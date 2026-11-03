/**
 * install_apk — sends an APK from this computer to a paired phone through CodeDroid's own link, and
 * installs it there. No cable, no shared network, no adb.
 *
 * The phone holds what has arrived, by the APK's hash, so an upload survives a dropped link. The
 * work runs here rather than in the call: MCP clients give up on a long call, so one that outlasts
 * WAIT_MS says it is still going, and calling again with the same file picks it back up.
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { projectDir } from "./adb-tool.js";
import { DEVICE_SCHEMA } from "./phones.js";

const CHUNK_BYTES = 1024 * 1024;
const WAIT_MS = 45_000;
const CALL_TIMEOUT_MS = 120_000;
/** Long enough for CodeDroid replacing itself: its process restarts and its link comes back. */
const RECONNECT_MS = 120_000;
const RETRY_DELAY_MS = 2_000;
/** How long Android may take to answer once it has the APK. */
const INSTALL_ANSWER_MS = 5 * 60_000;
/** How long a result nobody came back for is kept. */
const KEEP_RESULT_MS = 10 * 60_000;

const LOST_LINK = /not connected|not open|connection closed|request timed out/i;
const OLD_APP = /No tool named install_/;

const DESCRIPTION = `
Install an APK from this computer on the phone, through CodeDroid's own connection: no USB cable, shared network or adb. Use it after each build, then check the result with open_app and get_screen.

Pass the path to one .apk: relative to the working directory, or absolute. An App Bundle or split APKs will not install. Returns the package and version that were installed.

- If it says it is still working, call it again with the same path to keep waiting.
- Android's refusals come back as they are, with what to do. Removing an installed app deletes its data: ask the user first.
- It confirms Android's own install prompt. The first time, CodeDroid has to be allowed to install apps: the error says how.
- Google Play Protect can ask about a new build. CodeDroid does not answer it: the error says what to ask the user.
`.trim();

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function failure(message) {
  return { ...text(message), isError: true };
}

async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** [file]'s absolute path and size, or throws saying what is wrong with it. */
function checkedApk(file, cwd) {
  if (typeof file !== "string" || !file.trim()) throw new Error("install_apk: 'path' must be the path to an .apk.");
  const project = projectDir(cwd);
  if (!path.isAbsolute(file) && !project) {
    throw new Error(`install_apk: '${file}' is relative and this client has no project directory. Pass its absolute path.`);
  }
  const resolved = path.resolve(project ?? "/", file);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    throw new Error(`install_apk: cannot read ${resolved}: ${e.code ?? e.message}. Build it first.`);
  }
  if (!stat.isFile() || stat.size === 0) throw new Error(`install_apk: ${resolved} is not an APK file.`);
  return { file: resolved, size: stat.size };
}

/** A zip's first bytes, which every APK has: a wrong path should not cost a whole upload. */
function looksLikeApk(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    return head.toString("latin1") === "PK";
  } finally {
    fs.closeSync(fd);
  }
}

/** Why a phone's refusal stops the install, as the model should read it. */
class Refused extends Error {}

/**
 * @param {object} options
 * @param {import("./phones.js").Phones} options.phones
 * @param {string | null} [options.cwd] the client's working directory
 * @param {Map<string, object>} options.jobs installs under way on this daemon, shared by its sessions
 */
export function createInstallTool({ phones, cwd = null, jobs, retryDelayMs = RETRY_DELAY_MS, waitMs = WAIT_MS }) {
  /** One phone call, sent again while the link is down: every one of them is safe to repeat. */
  const call = async (device, name, args) => {
    const deadline = Date.now() + RECONNECT_MS;
    for (;;) {
      let result;
      try {
        result = await phones.request(
          { method: "tools/call", params: { name, arguments: { ...args, device } } },
          CallToolResultSchema,
          { timeout: CALL_TIMEOUT_MS },
        );
      } catch (e) {
        if (!LOST_LINK.test(e?.message ?? "") || Date.now() >= deadline) throw e;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      const body = result.content?.[0]?.text ?? "";
      if (result.isError) {
        if (OLD_APP.test(body)) throw new Refused("CodeDroid on this phone is too old to install apps. Update CodeDroid on the phone, then call install_apk again.");
        let refusal;
        try {
          refusal = JSON.parse(body);
        } catch (e) {
          throw new Refused(body);
        }
        throw new Refused(JSON.stringify({ installed: false, error: refusal.error, message: refusal.message, hint: refusal.hint }));
      }
      return JSON.parse(body);
    }
  };

  const run = async (job, device) => {
    const fd = await fs.promises.open(job.file, "r");
    try {
      const { sha256, size } = job;
      let { offset } = await call(device, "install_begin", { sha256, size });
      job.sent = offset;
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (offset < size) {
        const { bytesRead } = await fd.read(buffer, 0, CHUNK_BYTES, offset);
        if (bytesRead === 0) throw new Refused(`install_apk: ${job.file} changed while it was being sent.`);
        const data = buffer.subarray(0, bytesRead).toString("base64");
        ({ offset } = await call(device, "install_write", { sha256, offset, data }));
        job.sent = offset;
      }
      job.stage = "installing";
      let state = await call(device, "install_commit", { sha256 });
      const deadline = Date.now() + INSTALL_ANSWER_MS;
      while (!state.installed) {
        if (Date.now() >= deadline) {
          throw new Refused("Android has not finished the install after 5 minutes. Read the screen with get_screen, then call install_apk again.");
        }
        state = await call(device, "install_status", { sha256 });
      }
      return text(state);
    } catch (e) {
      return failure(e?.message ?? String(e));
    } finally {
      await fd.close();
    }
  };

  return {
    definition: {
      name: "install_apk",
      title: "Install an APK",
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The .apk on this computer, e.g. app/build/outputs/apk/debug/app-debug.apk" },
          device: DEVICE_SCHEMA,
        },
        required: ["path"],
      },
      annotations: { title: "Install an APK", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },

    /** @param {{path?: string, device?: string}} args */
    async handler(args) {
      let apk;
      let sha256;
      try {
        apk = checkedApk(args?.path, cwd);
        if (!looksLikeApk(apk.file)) return failure(`install_apk: ${apk.file} is not an APK: it is not a zip file.`);
        sha256 = await sha256Of(apk.file);
      } catch (e) {
        return failure(e.message);
      }

      const device = args?.device;
      const key = `${device ?? ""}:${sha256}`;
      let job = jobs.get(key);
      if (!job) {
        job = { ...apk, sha256, sent: 0, stage: "sending" };
        job.done = run(job, device).finally(() => {
          setTimeout(() => {
            if (jobs.get(key) === job) jobs.delete(key);
          }, KEEP_RESULT_MS).unref();
        });
        jobs.set(key, job);
      }

      let timer;
      const outcome = await Promise.race([
        job.done,
        new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
      if (!outcome) {
        return text({
          installed: false,
          status: job.stage,
          sent_bytes: job.sent,
          total_bytes: job.size,
          hint: "Still working. Call install_apk again with the same path to keep waiting.",
        });
      }
      if (jobs.get(key) === job) jobs.delete(key);
      return outcome;
    },
  };
}
