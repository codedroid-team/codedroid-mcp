/**
 * Takes the phones on this computer's adb from nothing to paired, for `setup` and the
 * codedroid_setup_phone tool: findPhones lists them, and setUpPhones sets them up side by side, each
 * as setUpPhone does one:
 *
 *   1. Install CodeDroid from get.codedroid.com if it is missing (checked against the feed's sha256).
 *   2. Turn on what its onboarding asks for (Accessibility, the keyboard, permissions), as
 *      get.codedroid.com's USB install does: over adb, Android 13+'s restricted settings never apply.
 *   3. Sign the phone in. A computer signed in to CodeDroid (`login`, account.js) hands the app a
 *      one-time code it minted as its account (`mcp/signin`), so an emulator or a CI phone needs no
 *      Google sign-in; otherwise, wait for the user to sign in on the phone, the one step adb
 *      cannot do.
 *   4. Reach it. A phone on the computer's account needs no pairing: once the app has registered
 *      it, the computer connects as the account. Otherwise pair with a code the app hands the adb
 *      shell (its content provider answers only the shell and itself), so no code is carried by
 *      hand. The phone asks Allow on the first connect, unless it was signed in by this computer.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { fetchDevices, mintSignInCode } from "./account.js";
import { adbLocations } from "./adb-tool.js";
import { DEFAULT_SERVER, PAIR_BY_HAND, accountHost, normalizeServer, pair, readAccount, readPairings } from "./host.js";

const execFileAsync = promisify(execFile);

const APP = "com.codedroid.agent";
export const APK_FEED = "https://get.codedroid.com/api/apk";
const POLL_MS = 2_000;
const INSTALL_TIMEOUT_MS = 300_000;
// How long a signed-in phone has to register with the server, so the account lists it.
const REGISTER_WAIT_MS = 60_000;

// web_client's phone-setup.sh, which get.codedroid.com runs after a USB install. Each step is
// best-effort: whatever a phone refuses, the app asks for itself.
const TURN_ON = `
P=${APP}
A=$P/$P.device.CodeDroidAccessibilityService
for p in POST_NOTIFICATIONS RECORD_AUDIO READ_MEDIA_IMAGES READ_MEDIA_VIDEO READ_EXTERNAL_STORAGE; do
  pm grant --user current $P android.permission.$p >/dev/null 2>&1
done
i=0
until ime enable --user current $P/.device.CodeDroidKeyboard >/dev/null 2>&1 || [ $i -ge 10 ]; do
  sleep 0.5
  i=$((i + 1))
done
L=$(settings get --user current secure enabled_accessibility_services)
case "$L" in
  *"$A"*) ;;
  ""|null) settings put --user current secure enabled_accessibility_services "$A" ;;
  *) settings put --user current secure enabled_accessibility_services "$L:$A" ;;
esac
settings put --user current secure accessibility_enabled 1
am start --user current -n $P/.MainActivity >/dev/null 2>&1
`.trim();

/** What adb's install failures mean for the user, as install.sh says them. */
const INSTALL_FAILURES = [
  [/INSTALL_FAILED_UPDATE_INCOMPATIBLE/, "A different build of CodeDroid is already on the phone. Uninstall it there, then run this again."],
  [/INSTALL_FAILED_USER_RESTRICTED/, 'The phone blocked installing over USB. Turn on "Install via USB" in Developer options, then run this again.'],
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE/, "The phone is out of storage. Free some, then run this again."],
];

/**
 * adb against one phone (-s serial), stdin closed so `shell` never waits on it. Resolves stdout and
 * stderr together, even when it exits non-zero (`pm path` of a missing package): callers read what
 * it said. A missing adb or a timeout throws.
 */
export function adbRunner({ run = execFileAsync, env = process.env } = {}) {
  return async (args, { serial, timeout = 60_000 } = {}) => {
    const argv = serial ? ["-s", serial, ...args] : args;
    const locations = adbLocations(env);
    for (const [i, file] of locations.entries()) {
      try {
        const running = run(file, argv, { timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
        running.child?.stdin?.end();
        const { stdout, stderr } = await running;
        return `${stdout}${stderr}`;
      } catch (e) {
        if (e?.code === "ENOENT" && i < locations.length - 1) continue;
        if (typeof e?.code === "number") return `${e.stdout ?? ""}${e.stderr ?? ""}`;
        throw e;
      }
    }
  };
}

/** adb's devices as [serial, state]: only `serial<TAB>state` lines, not the header nor "* daemon started successfully". */
function parseDevices(output) {
  return [...output.matchAll(/^([^\s*]\S*)\t([^\r\n]+)/gm)].map((m) => [m[1], m[2].trim()]);
}

/** Why a device adb lists as [state] can't be set up, or null when it can. */
function stateProblem(state) {
  if (state === "unauthorized") return "Accept the USB debugging prompt on the phone, then run this again.";
  if (state.startsWith("no permissions")) {
    return "adb has no permission to use the phone. On Linux, add its udev rules (https://developer.android.com/studio/run/device), then run this again.";
  }
  if (state.split(/\s/)[0] !== "device") return `The phone is ${state.split(/\s/)[0]} on adb: reconnect it, then run this again.`;
  return null;
}

/** What a thrown adb call means for the user. */
function adbFailure(e) {
  return e?.code === "ENOENT"
    ? "adb is not installed, so the phone can't be set up over USB. Get it: https://developer.android.com/tools/releases/platform-tools"
    : `adb failed: ${e.message}`;
}

/** The phone [serial], CODEDROID_SERIAL or ANDROID_SERIAL names, else every device adb has. */
function wantedDevices(devicesOutput, env, serial) {
  const attached = parseDevices(devicesOutput);
  const wanted = serial || env.CODEDROID_SERIAL || env.ANDROID_SERIAL;
  const candidates = wanted ? attached.filter(([s]) => s === wanted) : attached;
  if (!candidates.length) return { problem: wanted ? `${wanted} is not on adb.` : "No phone is on adb." };
  return { candidates };
}

/** The one phone to set up: [serial], CODEDROID_SERIAL or ANDROID_SERIAL, else the only device adb has. */
export function pickPhone(devicesOutput, env = process.env, serial = null) {
  const { candidates, problem } = wantedDevices(devicesOutput, env, serial);
  if (problem) return { problem };
  if (candidates.length > 1) {
    return { problem: `Several devices are on adb (${candidates.map(([s]) => s).join(", ")}): name the one to set up with CODEDROID_SERIAL.` };
  }
  const [found, state] = candidates[0];
  const refused = stateProblem(state);
  return refused ? { problem: refused } : { serial: found };
}

/**
 * The devices to set up: every one on adb, or the one [serial] (else CODEDROID_SERIAL) names. Each
 * has its serial and a `label` to name it by (its model, with the serial when another has the same
 * model), then either its `model` and whether CodeDroid is `installed`, or the `problem` that keeps
 * it from being set up (unauthorized, offline). Resolves `{ problem }` with no device at all.
 */
export async function findPhones({ adb = adbRunner(), env = process.env, serial = null } = {}) {
  let output;
  try {
    output = await adb(["devices"]);
  } catch (e) {
    return { problem: adbFailure(e) };
  }
  const { candidates, problem } = wantedDevices(output, env, serial);
  if (problem) return { problem };
  const phones = await Promise.all(
    candidates.map(async ([serial, state]) => {
      const refused = stateProblem(state);
      if (refused) return { serial, model: null, problem: refused };
      const shell = (command) => adb(["shell", command], { serial, timeout: 15_000 });
      try {
        const user = currentUser(await shell("am get-current-user"));
        const [model, installed] = await Promise.all([shell("getprop ro.product.model"), shell(`pm path --user ${user} ${APP}`)]);
        return { serial, model: model.trim() || null, installed: /^package:/m.test(installed) };
      } catch (e) {
        return { serial, model: null, problem: adbFailure(e) };
      }
    }),
  );
  const models = new Map();
  for (const { model } of phones) if (model) models.set(model, (models.get(model) ?? 0) + 1);
  return {
    phones: phones.map((p) => ({ ...p, label: !p.model ? p.serial : models.get(p.model) > 1 ? `${p.model} (${p.serial})` : p.model })),
  };
}

/** findPhones' devices as setup lists them, one line each. */
export function phoneLines(phones) {
  return phones.map((p) => `  ${p.model ? `${p.model} (${p.serial})` : p.serial}: ${p.problem ?? (p.installed ? "CodeDroid installed" : "CodeDroid not installed")}`);
}

/** The Android user in front, from `am get-current-user`. */
function currentUser(output) {
  return /^\s*(\d+)\s*$/m.exec(output)?.[1] ?? "0";
}

/** The JSON a `content query` of the app's provider printed (`Row: 0 result={...}`), or null. */
export function parseProviderRow(output) {
  const match = /result=(\{.*\})\s*$/m.exec(output);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {(msg: string) => void} [options.log] progress, for the person watching
 * @param {(model: string) => Promise<boolean>} [options.confirmInstall] asked before installing the app; no by default
 * @param {number} [options.signInWaitMs] how long to wait for the user to sign in on the phone
 * @param {string} [options.serial] the adb serial of the phone, when several are on adb
 * @param {object|null} [options.account] the account this computer is signed in with (host.js readAccount)
 * @returns {Promise<{status: "no-phone" | "not-installed" | "paired" | "already-paired" | "signed-out" | "failed", detail: string, host?: object, model?: string}>}
 *   no-phone: adb is missing or has no single phone ready, so pair by hand instead.
 *   not-installed: CodeDroid is not on the phone, and confirmInstall said no.
 *   paired: this computer reaches the phone: `host` is its entry (host.js), `host.account` when
 *   through the account rather than a pairing.
 */
export async function setUpPhone({
  adb = adbRunner(),
  fetch = globalThis.fetch,
  log = () => {},
  confirmInstall = async () => false,
  signInWaitMs = 5 * 60_000,
  serial: wanted = null,
  env = process.env,
  home = os.homedir(),
  tmpdir = os.tmpdir(),
  pollMs = POLL_MS,
  account = readAccount({ home, env }),
  mintCode = mintSignInCode,
  listDevices = fetchDevices,
  registerWaitMs = REGISTER_WAIT_MS,
  apk = null,
} = {}) {
  let serial;
  try {
    const picked = pickPhone(await adb(["devices"]), env, wanted);
    if (picked.problem) return { status: "no-phone", detail: picked.problem };
    serial = picked.serial;
  } catch (e) {
    return { status: "no-phone", detail: adbFailure(e) };
  }
  const shell = (command, timeout) => adb(["shell", command], { serial, timeout });
  const turnOn = () => shell(TURN_ON);

  try {
    const user = currentUser(await shell("am get-current-user"));
    const query = async (uri) => parseProviderRow(await shell(`content query --user ${user} --uri content://${APP}/${uri}`));
    if (!/^package:/m.test(await shell(`pm path --user ${user} ${APP}`))) {
      const model = (await shell("getprop ro.product.model")).trim() || "the phone";
      if (!(await confirmInstall(model))) return { status: "not-installed", detail: `CodeDroid is not on ${model}.`, model };
      const download = apk ?? apkDownload({ fetch, tmpdir, log });
      try {
        const file = await download.get();
        log("Installing CodeDroid on the phone. If it offers to scan the app, accept.");
        const out = await adb(["install", "-r", file], { serial, timeout: INSTALL_TIMEOUT_MS });
        if (!/^Success/m.test(out)) {
          const known = INSTALL_FAILURES.find(([pattern]) => pattern.test(out));
          return { status: "failed", detail: known?.[1] ?? `Installing CodeDroid failed: ${out.trim().split("\n").at(-1)}` };
        }
      } finally {
        if (!apk) await download.dispose();
      }
    }
    let status = await query("device/status");
    if (!status?.accessibility) {
      log("Turning on CodeDroid's Accessibility and keyboard.");
      await turnOn();
      status = await poll(() => query("device/status"), (s) => s?.accessibility, 10_000, pollMs);
      if (!status?.accessibility) {
        return { status: "failed", detail: "CodeDroid's Accessibility did not turn on. Open CodeDroid on the phone and turn it on there, then run this again." };
      }
    }

    // The account reaches the phone with no pairing, when the phone uses the account's server and
    // is (or can be) signed in as the account. Any other case pairs, as before.
    const phoneServer = normalizeServer(status.server ?? DEFAULT_SERVER);
    let viaAccount = !!account && account.server === phoneServer;
    const onAccount = (devices) => devices.some((d) => String(d.id) === String(status.deviceId));
    if (viaAccount && onAccount(account.devices ?? [])) {
      return { status: "already-paired", detail: "The phone is on your account.", host: accountHost(account, { id: status.deviceId, model: status.metadata?.model_name ?? null }) };
    }

    // Who the phone is signed in as, from the app: signed out, this account, or another. An app
    // from before mcp/signin cannot say, and cannot be signed in from here.
    if (viaAccount) {
      const who = await query("mcp/signin");
      if (!who || /^Unknown endpoint/.test(who.error ?? "")) viaAccount = false;
      else if (who.error === "already_signed_in" && who.email && account.email && who.email !== account.email) {
        log(`The phone is signed in as ${who.email}, not ${account.email}: pairing instead.`);
        viaAccount = false;
      } else if (who.error === "no_code" || status.signedIn === false) {
        try {
          const code = await mintCode(account, { fetch, home });
          const signedIn = await query(`mcp/signin?code=${encodeURIComponent(code)}`);
          if (signedIn?.ok) {
            log(`Signed the phone in to CodeDroid as ${signedIn.email ?? account.email ?? "your account"}.`);
            status = { ...status, signedIn: true };
          } else if (signedIn?.error === "already_signed_in") {
            status = { ...status, signedIn: true };
          } else {
            log(`The phone could not be signed in from here (${signedIn?.error ?? "no answer"}); sign in on the phone instead.`);
          }
        } catch (e) {
          log(`The phone could not be signed in from here (${e.message}); sign in on the phone instead.`);
        }
      }
    }

    // Off the account (another server, an app from before mcp/signin, another Google account), a
    // pairing reaches the phone: the one kept, unless the phone says it no longer has this computer
    // (Remove, or a sign-out). An app from before `computers` is taken at its word.
    if (!viaAccount) {
      const existing = readPairings({ home }).find((h) => h.device?.id && h.device.id === status.deviceId);
      if (existing && (!Array.isArray(status.computers) || status.computers.includes(existing.host_id))) {
        return { status: "already-paired", detail: "This computer is already paired with the phone.", host: existing };
      }
      if (existing) log("The phone no longer allows this computer. Pairing again.");
    }

    // An app from before mcp/pairing says nothing of signing in: the pairing itself will.
    if (status.signedIn === false) {
      if (signInWaitMs <= 0) return { status: "signed-out", detail: "Sign in to CodeDroid on the phone, then try again." };
      await shell(`am start --user current -n ${APP}/.MainActivity`);
      log("On the phone, tap send in CodeDroid, then sign in with Google. Waiting...");
    }
    const deadline = Date.now() + signInWaitMs;

    if (viaAccount) {
      // Signed in as the account: the app registers the phone with the server on its next
      // connect, and from then on this computer reaches it as the account. Nothing to pair. A
      // phone still to be signed in on gets the sign-in wait too.
      const until = status.signedIn === false ? Math.max(deadline, Date.now() + registerWaitMs) : Date.now() + registerWaitMs;
      let devices = account.devices ?? [];
      for (;;) {
        try {
          devices = await listDevices(account, { fetch, home });
        } catch (e) {
          return { status: "failed", detail: e.message };
        }
        if (onAccount(devices)) {
          const device = devices.find((d) => String(d.id) === String(status.deviceId));
          return {
            status: "paired",
            detail: `${device.model ?? "The phone"} is on your account: this computer reaches it with nothing to pair.`,
            host: accountHost(account, device),
          };
        }
        if (Date.now() >= until) {
          const now = await query("device/status");
          return now?.signedIn === false
            ? { status: "signed-out", detail: "Sign in to CodeDroid on the phone, then try again." }
            : { status: "failed", detail: "The phone is signed in but has not registered with CodeDroid's server yet. Check that it is online and open CodeDroid on it, then run this again." };
        }
        await sleep(pollMs);
      }
    }
    for (;;) {
      const answer = await query("mcp/pairing");
      if (answer?.code) {
        const host = await pair(answer.code, { server: status.server ?? DEFAULT_SERVER, fetch, home });
        return { status: "paired", detail: `Paired with ${host.device?.model ?? "the phone"}.`, host };
      }
      const error = answer?.error ?? "no answer";
      if (/^Unknown endpoint/.test(error)) {
        return { status: "failed", detail: `This CodeDroid can't pair over USB: update it (Settings > About > Version), or pair by hand. ${PAIR_BY_HAND}` };
      }
      if (error === "disabled") return { status: "failed", detail: "Turn on Allow computers to connect in CodeDroid > Settings > Computers, then run this again." };
      if (error === "accessibility_off") await turnOn();
      // Signed out, or just signed in and not yet registered with the server.
      else if (error !== "signed_out" && !/not registered/i.test(error)) return { status: "failed", detail: `CodeDroid could not make a pairing code: ${error}` };
      if (Date.now() >= deadline) {
        return error === "signed_out"
          ? { status: "signed-out", detail: "Sign in to CodeDroid on the phone, then try again." }
          : { status: "failed", detail: `CodeDroid could not make a pairing code: ${error}` };
      }
      await sleep(pollMs);
    }
  } catch (e) {
    return { status: "failed", detail: e.message };
  }
}

/**
 * setUpPhone on each of [phones] (findPhones' devices) side by side, sharing one download of
 * CodeDroid, the account, and its list of phones while they wait to register. A device with a
 * `problem` is reported as it is. [log] lines name their device when there are several. Resolves
 * each device with its result, in [phones]' order.
 */
export async function setUpPhones({
  phones,
  log = () => {},
  fetch = globalThis.fetch,
  tmpdir = os.tmpdir(),
  home = os.homedir(),
  env = process.env,
  account = readAccount({ home, env }),
  listDevices = fetchDevices,
  pollMs = POLL_MS,
  ...options
}) {
  const apk = apkDownload({ fetch, tmpdir, log });
  const listShared = sharedFor(listDevices, pollMs);
  const several = phones.length > 1;
  try {
    return await Promise.all(
      phones.map(async (phone) => {
        if (phone.problem) return { ...phone, status: "no-phone", detail: phone.problem };
        const result = await setUpPhone({
          ...options,
          serial: phone.serial,
          fetch,
          tmpdir,
          home,
          env,
          account,
          listDevices: listShared,
          pollMs,
          apk,
          log: several ? (line) => log(`${phone.label}: ${line}`) : log,
        });
        return { ...phone, ...result };
      }),
    );
  } finally {
    await apk.dispose();
  }
}

/** [fn] shared by its callers: a call within [ms] of the one before gets that one's answer. */
function sharedFor(fn, ms) {
  let last = null;
  let at = 0;
  return (...args) => {
    if (!last || Date.now() - at >= ms) {
      at = Date.now();
      last = fn(...args);
    }
    return last;
  };
}

/**
 * One download of CodeDroid for the phones a setup installs it on: `get` downloads it the first
 * time it is asked for, and `dispose` deletes it.
 */
function apkDownload({ fetch, tmpdir, log }) {
  let file = null;
  return {
    get: () => (file ??= downloadApk({ fetch, tmpdir, log })),
    async dispose() {
      const done = await file?.catch(() => null);
      if (done) fs.rmSync(path.dirname(done), { recursive: true, force: true });
    },
  };
}

/** [read]'s first answer that [done] accepts within [ms], else its last. */
async function poll(read, done, ms, every) {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(every);
    value = await read();
  }
  return value;
}

/** The newest release from get.codedroid.com, checked against the feed's sha256; resolves its path. */
async function downloadApk({ fetch, tmpdir, log }) {
  const feed = await fetch(APK_FEED, { signal: AbortSignal.timeout(30_000) });
  if (!feed.ok) throw new Error(`Could not find the CodeDroid app at ${APK_FEED} (HTTP ${feed.status}).`);
  const release = await feed.json();
  const url = new URL(release.download_url);
  url.searchParams.set("via", "cli");
  log(`Downloading CodeDroid${release.version ? ` ${release.version}` : ""}...`);
  const res = await fetch(url, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Downloading CodeDroid failed (HTTP ${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (typeof release.sha256 !== "string" || sha256 !== release.sha256.toLowerCase()) {
    throw new Error("The downloaded CodeDroid app did not match its published checksum, so it was not installed. Try again.");
  }
  const file = path.join(fs.mkdtempSync(path.join(tmpdir, "codedroid-")), "codedroid.apk");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

/** Every device on adb, or the one [serial] names, set up side by side (setUpPhones); `{ problem }` with none. */
export async function setUpAdbPhones({ serial = null, adb = adbRunner(), env = process.env, ...options } = {}) {
  const found = await findPhones({ adb, env, serial });
  if (found.problem) return { problem: found.problem };
  return { phones: await setUpPhones({ phones: found.phones, adb, env, ...options }) };
}

const TOOL_DESCRIPTION =
  "Set up CodeDroid on the Android phones plugged into this computer (USB or Wireless debugging), every device " +
  "on adb at once, or the one `serial` names, with no code to type: installs the app from get.codedroid.com where " +
  "it is missing (only with install: true), turns on its Accessibility and keyboard over adb, signs each phone in " +
  "with this computer's account (or waits for the user to sign in on it), and pairs. Call it when codedroid_status " +
  "says this computer is not paired, or the user asks to set up the phones or tablets on this computer. If " +
  "CodeDroid is not on a phone yet, it says so: ask the user before calling again with install: true. A long setup " +
  'answers "still working": call it again to keep waiting. Then call codedroid_status.';

// What the agent does next, by how setup ended: [phones] ended so, [named] when there were several.
const NEXT = {
  paired: (phones, named) => `Ask the user to tap Allow on ${named ? "each phone" : "the phone"} if CodeDroid asks, then call codedroid_status.`,
  "already-paired": () => "Call codedroid_status to connect.",
  "signed-out": (phones, named) =>
    `Ask the user to sign in to CodeDroid on ${named ? phones.map((p) => p.label).join(", ") : "the phone"} (tap send, then sign in with Google), then call this again.`,
  "not-installed": (phones, named) =>
    `Ask the user whether to install CodeDroid on ${named ? phones.map((p) => p.label).join(", ") : "it"}. If they agree, call this again with install: true.`,
  "no-phone": () => `Ask the user to fix that, then call this again. Or they pair by hand: ${PAIR_BY_HAND}`,
};

/** What a setup's [outcome] (setUpAdbPhones') tells the agent, and whether every phone was reached. */
function report(outcome) {
  if (outcome.problem) return { ok: false, lines: [outcome.problem, NEXT["no-phone"]()] };
  const { phones } = outcome;
  const named = phones.length > 1;
  const lines = phones.map((p) => (named ? `${p.label}: ${p.detail}` : p.detail));
  for (const status of new Set(phones.map((p) => p.status))) {
    lines.push(NEXT[status]?.(phones.filter((p) => p.status === status), named));
  }
  return { ok: phones.every((p) => p.status === "paired" || p.status === "already-paired"), lines: lines.filter(Boolean) };
}

/**
 * codedroid_setup_phone: setUpAdbPhones for the agent. A setup can take minutes (a download, then the
 * user signing in), longer than a client waits for one call (Codex: 60 s), so it runs as a job on
 * the daemon: a call waits up to [waitMs] and otherwise says it is still working, and the next call
 * joins the same job instead of starting a second install. A result no call picks up within [keepMs]
 * is dropped, since the phones may have changed since.
 *
 * @param {object} options
 * @param {Map<string, object>} options.jobs setups under way on this daemon, shared by its sessions
 */
export function createSetupPhoneTool({
  jobs,
  setUp = setUpAdbPhones,
  waitMs = 45_000,
  signInWaitMs = 3 * 60_000,
  keepMs = 2 * 60_000,
  now = Date.now,
} = {}) {
  return {
    definition: {
      name: "codedroid_setup_phone",
      title: "Set up the phones over USB",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          install: { type: "boolean", description: "Install CodeDroid if it is missing. Only once the user has agreed." },
          serial: { type: "string", description: "adb serial of the one phone to set up (adb devices); without it, every device on adb" },
        },
      },
      annotations: { title: "Set up the phones over USB", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async handler({ install = false, serial } = {}) {
      let job = jobs.get("setup");
      const sameSerial = !serial || job?.serial === serial;
      if (job && job.finishedAt === undefined && !sameSerial) {
        const text = `Setting up ${job.serial ?? "the phones on adb"} already. Call this again once that is done.`;
        return { content: [{ type: "text", text }], isError: true };
      }
      if (job?.finishedAt !== undefined && (!sameSerial || now() - job.finishedAt > keepMs)) job = null;
      if (!job) {
        const started = { progress: [], serial: serial ?? null };
        started.done = setUp({
          log: (line) => started.progress.push(line),
          confirmInstall: async () => install === true,
          serial,
          signInWaitMs,
        })
          .catch((e) => ({ problem: e.message }))
          .then((result) => ((started.finishedAt = now()), result));
        jobs.set("setup", (job = started));
      }
      let timer;
      const result = await Promise.race([job.done, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
      if (!result) {
        const text = [...job.progress, "Still working. Call codedroid_setup_phone again to keep waiting."].join("\n");
        return { content: [{ type: "text", text }], isError: false };
      }
      if (jobs.get("setup") === job) jobs.delete("setup");
      const { ok, lines } = report(result);
      return { content: [{ type: "text", text: [...job.progress, ...lines].join("\n") }], isError: !ok };
    },
  };
}
