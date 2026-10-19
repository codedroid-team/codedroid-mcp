/**
 * Running this computer's `adb`, and finding the phone CodeDroid runs on.
 *
 * - `adb` is spawned with an argv array, never through a shell on this computer.
 * - The phone: CODEDROID_SERIAL or ANDROID_SERIAL when set, else the one device adb lists as
 *   ready. Several with neither set is an error that lists them.
 * - The Android user matters: on a phone with several users (a Googlebook runs as user 10) the
 *   app, and the socket it listens on, belong to the user in front, while adb defaults to user 0.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const PACKAGE = "com.codedroid.app";

/** Runs `adb <args>` and resolves stdout; rejects with adb's own words. */
export function makeAdb({ run = execFileAsync, env = process.env } = {}) {
  const binary = env.ADB || "adb";
  return async function adb(args, { timeout = 30_000 } = {}) {
    try {
      const { stdout } = await run(binary, args, { timeout, maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(
          `adb was not found. Install Android platform-tools (https://developer.android.com/tools/releases/platform-tools) ` +
            `or set ADB to its path.`,
        );
      }
      const said = [e.stderr, e.stdout].filter(Boolean).join("\n").trim();
      throw new Error(said || e.message);
    }
  };
}

/** Serials adb lists, with their state ("device", "unauthorized", "offline"...). */
export function parseDevices(output) {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const model = rest.find((part) => part.startsWith("model:"))?.slice("model:".length);
      return { serial, state, model };
    });
}

/** The serial to use, or an error saying what to do. */
export async function pickDevice(adb, env = process.env) {
  const wanted = env.CODEDROID_SERIAL || env.ANDROID_SERIAL;
  const devices = parseDevices(await adb(["devices", "-l"]));
  if (wanted) {
    const found = devices.find((d) => d.serial === wanted);
    if (!found) throw new Error(`Device ${wanted} is not attached. adb sees: ${describe(devices)}.`);
    if (found.state !== "device") throw new Error(stateHint(found));
    return wanted;
  }
  const ready = devices.filter((d) => d.state === "device");
  if (ready.length === 1) return ready[0].serial;
  if (ready.length > 1) {
    throw new Error(
      `Several Android devices are attached (${describe(ready)}). Set CODEDROID_SERIAL to the one CodeDroid runs on.`,
    );
  }
  if (devices.length) throw new Error(stateHint(devices[0]));
  throw new Error(
    "No Android device on adb. Plug the phone in with USB debugging on, or pair it over Wireless debugging " +
      "(adb pair <ip:port>, then adb connect <ip:port>).",
  );
}

function describe(devices) {
  return devices.map((d) => `${d.serial}${d.model ? ` (${d.model})` : ""} ${d.state}`).join(", ") || "nothing";
}

function stateHint(device) {
  if (device.state === "unauthorized") {
    return `${device.serial} has not allowed this computer: unlock the phone and tap Allow on "Allow USB debugging?".`;
  }
  return `${device.serial} is ${device.state}. Reconnect it (replug USB, or adb connect again over Wireless debugging).`;
}

/** The Android user in front, whose CodeDroid the bridge talks to. */
export async function currentUser(adb, serial) {
  const out = (await adb(["-s", serial, "shell", "am", "get-current-user"])).trim();
  return /^\d+$/.test(out) ? Number(out) : 0;
}

export const ACCESSIBILITY_SERVICE = `${PACKAGE}/${PACKAGE}.device.CodeDroidAccessibilityService`;

/** The enabled_accessibility_services value with CodeDroid's service added to [current]. */
export function withCodeDroidService(current) {
  const services = String(current ?? "")
    .trim()
    .split(":")
    .filter((s) => s && s !== "null");
  return services.includes(ACCESSIBILITY_SERVICE) ? services.join(":") : [...services, ACCESSIBILITY_SERVICE].join(":");
}

/**
 * Why CodeDroid's server did not answer, in words for the user: not installed, accessibility off,
 * or not listening (switched off in Settings, or a build without the MCP server).
 */
export async function diagnose(adb, serial, user) {
  const shell = (...args) => adb(["-s", serial, "shell", ...args]).catch(() => "");
  const installed = await shell("pm", "path", "--user", String(user), PACKAGE);
  if (!installed.includes("package:")) {
    return `CodeDroid is not installed on ${serial} (Android user ${user}). Install it from https://get.codedroid.com.`;
  }
  const status = await shell("content", "query", "--user", String(user), "--uri", `content://${PACKAGE}/device/status`);
  if (!status.includes('"accessibility"')) {
    return `CodeDroid on ${serial} did not answer (adb shell content query --uri content://${PACKAGE}/device/status). Open the app once, then try again.`;
  }
  if (status.includes('"accessibility":false')) {
    const enabled = await shell("settings", "get", "--user", String(user), "secure", "enabled_accessibility_services");
    if (enabled.includes(ACCESSIBILITY_SERVICE)) {
      return (
        `CodeDroid's accessibility service on ${serial} is turned on but not running. In Settings > Accessibility > ` +
        `CodeDroid, turn it off and on again.`
      );
    }
    return (
      `CodeDroid's accessibility service is off on ${serial}. Turn it on in Settings > Accessibility > CodeDroid, ` +
      `or from this computer:\n` +
      `  adb -s ${serial} shell settings put --user ${user} secure enabled_accessibility_services '${withCodeDroidService(enabled)}'\n` +
      `  adb -s ${serial} shell settings put --user ${user} secure accessibility_enabled 1`
    );
  }
  return (
    `CodeDroid on ${serial} is not accepting computers. In CodeDroid, open Settings > Computers and turn on ` +
    `"Allow computers to connect". If that row is missing, update CodeDroid to a build that has it.`
  );
}
