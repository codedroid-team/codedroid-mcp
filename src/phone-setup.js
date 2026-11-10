/**
 * Takes the phone on this computer's adb from nothing to paired, for `setup`:
 *
 *   1. Install CodeDroid from get.codedroid.com if it is missing (checked against the feed's sha256).
 *   2. Turn on what its onboarding asks for (Accessibility, the keyboard, permissions), as
 *      get.codedroid.com's USB install does: over adb, Android 13+'s restricted settings never apply.
 *   3. Wait for the user to sign in on the phone, the one step adb cannot do.
 *   4. Pair with a code the app hands the adb shell (its content provider answers only the shell
 *      and itself), so no code is carried by hand. The phone still asks Allow on the first connect.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { adbLocations } from "./adb-tool.js";
import { DEFAULT_SERVER, PAIR_BY_HAND, pair, readHosts } from "./host.js";

const execFileAsync = promisify(execFile);

const APP = "com.codedroid.agent";
export const APK_FEED = "https://get.codedroid.com/api/apk";
const POLL_MS = 2_000;
const INSTALL_TIMEOUT_MS = 300_000;

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

/** The one phone to set up: [serial], CODEDROID_SERIAL or ANDROID_SERIAL, else the only device adb has. */
export function pickPhone(devicesOutput, env = process.env, serial = null) {
  // Only `serial<TAB>state` lines: not the header, nor "* daemon started successfully".
  const attached = [...devicesOutput.matchAll(/^([^\s*]\S*)\t([^\r\n]+)/gm)].map((m) => [m[1], m[2].trim()]);
  const wanted = serial || env.CODEDROID_SERIAL || env.ANDROID_SERIAL;
  const candidates = wanted ? attached.filter(([serial]) => serial === wanted) : attached;
  if (!candidates.length) return { problem: wanted ? `${wanted} is not on adb.` : "No phone is on adb." };
  if (candidates.length > 1) {
    return { problem: `Several devices are on adb (${candidates.map(([s]) => s).join(", ")}): name the one to set up with CODEDROID_SERIAL.` };
  }
  const [found, state] = candidates[0];
  if (state === "unauthorized") return { problem: "Accept the USB debugging prompt on the phone, then run this again." };
  if (state.startsWith("no permissions")) {
    return { problem: "adb has no permission to use the phone. On Linux, add its udev rules (https://developer.android.com/studio/run/device), then run this again." };
  }
  if (state.split(/\s/)[0] !== "device") return { problem: `The phone is ${state.split(/\s/)[0]} on adb: reconnect it, then run this again.` };
  return { serial: found };
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
 * @returns {Promise<{status: "no-phone" | "not-installed" | "paired" | "already-paired" | "signed-out" | "failed", detail: string, host?: object, model?: string}>}
 *   no-phone: adb is missing or has no single phone ready, so pair by hand instead.
 *   not-installed: CodeDroid is not on the phone, and confirmInstall said no.
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
} = {}) {
  let serial;
  try {
    const picked = pickPhone(await adb(["devices"]), env, wanted);
    if (picked.problem) return { status: "no-phone", detail: picked.problem };
    serial = picked.serial;
  } catch (e) {
    return {
      status: "no-phone",
      detail:
        e?.code === "ENOENT"
          ? "adb is not installed, so the phone can't be set up over USB. Get it: https://developer.android.com/tools/releases/platform-tools"
          : `adb failed: ${e.message}`,
    };
  }
  const shell = (command, timeout) => adb(["shell", command], { serial, timeout });
  const turnOn = () => shell(TURN_ON);

  try {
    const user = /^\s*(\d+)\s*$/m.exec(await shell("am get-current-user"))?.[1] ?? "0";
    const query = async (uri) => parseProviderRow(await shell(`content query --user ${user} --uri content://${APP}/${uri}`));
    if (!/^package:/m.test(await shell(`pm path --user ${user} ${APP}`))) {
      const model = (await shell("getprop ro.product.model")).trim() || "the phone";
      if (!(await confirmInstall(model))) return { status: "not-installed", detail: `CodeDroid is not on ${model}.`, model };
      const apk = await downloadApk({ fetch, tmpdir, log });
      try {
        log("Installing CodeDroid on the phone. If it offers to scan the app, accept.");
        const out = await adb(["install", "-r", apk], { serial, timeout: INSTALL_TIMEOUT_MS });
        if (!/^Success/m.test(out)) {
          const known = INSTALL_FAILURES.find(([pattern]) => pattern.test(out));
          return { status: "failed", detail: known?.[1] ?? `Installing CodeDroid failed: ${out.trim().split("\n").at(-1)}` };
        }
      } finally {
        fs.rmSync(path.dirname(apk), { recursive: true, force: true });
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

    // Paired, unless the phone says it no longer has this computer (Remove, or a sign-out): an
    // app from before `computers` is taken at its word, and the connection will say.
    const existing = readHosts({ home }).find((h) => h.device?.id && h.device.id === status.deviceId);
    if (existing && (!Array.isArray(status.computers) || status.computers.includes(existing.host_id))) {
      return { status: "already-paired", detail: "This computer is already paired with the phone.", host: existing };
    }
    if (existing) log("The phone no longer allows this computer. Pairing again.");

    // An app from before mcp/pairing says nothing of signing in: the pairing itself will.
    if (status.signedIn === false) {
      if (signInWaitMs <= 0) return { status: "signed-out", detail: "Sign in to CodeDroid on the phone, then try again." };
      await shell(`am start --user current -n ${APP}/.MainActivity`);
      log("On the phone, tap send in CodeDroid, then sign in with Google. Waiting...");
    }
    const deadline = Date.now() + signInWaitMs;
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
