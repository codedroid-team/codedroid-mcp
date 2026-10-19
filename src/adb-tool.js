/**
 * adb — a single generic MCP tool that runs an adb command against the phone
 * attached to THIS computer (USB, or Wireless Debugging).
 *
 * Forked from aura-mcp-connect's `aura-adb` (MIT, Copyright (c) 2026 Dinesh Kumar C;
 * see LICENSE.aura-mcp-connect). Changed: on by default, since the link to the phone
 * is adb already and the user is a developer (CODEDROID_MCP_ADB=0 turns it off);
 * marked destructive so clients ask before running it; a per-call timeout.
 *
 * It never touches the connection to CodeDroid: it shells out to this machine's
 * own `adb`, exactly like a developer typing `adb install app.apk` themselves.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 900;

// adb's global options that take a value: `-s SERIAL`, `-t ID`, `-H host`, `-P port`, `-L socket`.
const VALUE_OPTIONS = new Set(["-s", "-t", "-H", "-P", "-L"]);
// Global options that pick the device, after which the phone's serial must not be added.
const DEVICE_OPTIONS = new Set(["-s", "-t", "-d", "-e"]);
// Subcommands whose rest is a command line for the phone's shell.
const SHELLS = new Set(["shell", "exec-out"]);

/**
 * [command] as adb's argv. Up to the subcommand, and for host-side commands (install, push, pull),
 * words split on whitespace and quotes group them, so a path with spaces stays one argument. After
 * `shell` or `exec-out` (and its own -x style flags) the rest goes to the phone's shell as written,
 * quotes, pipes and all, which is what that shell expects.
 */
export function adbArgv(command) {
  const text = command.trim();
  const argv = [];
  let subcommand = null;
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (subcommand && SHELLS.has(subcommand) && !/^-[a-zA-Z]\s/.test(text.slice(i) + " ")) {
      argv.push(text.slice(i).trim());
      break;
    }
    let word = "";
    let quote = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = null;
        else word += c;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (/\s/.test(c)) {
        break;
      } else {
        word += c;
      }
    }
    if (!subcommand && !word.startsWith("-") && !VALUE_OPTIONS.has(argv[argv.length - 1])) subcommand = word;
    argv.push(word);
  }
  return argv;
}

/** Whether [argv]'s own global options, before the subcommand, already pick the device. */
function namesDevice(argv) {
  for (let i = 0; i < argv.length && argv[i].startsWith("-"); i++) {
    if (DEVICE_OPTIONS.has(argv[i])) return true;
    if (VALUE_OPTIONS.has(argv[i])) i++;
  }
  return false;
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const cut = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated, ${cut} more chars)`;
}

/**
 * What the handshake says about adb, appended to the phone's instructions. At most 400 bytes:
 * Claude Code keeps about 2 KB of a server's instructions and the phone's take up to 1,600.
 */
const INSTRUCTIONS =
  "You also have `adb`: this computer's adb against the same phone. Use it to install builds, read " +
  "logs (logcat -d), inspect state (dumpsys), start activities, and run instrumentation tests; use " +
  "CodeDroid's tools to see and drive the screen. Never force-stop or instrument com.codedroid.app.";

/** The tool's full guidance: read right before calling it. */
const DESCRIPTION = `
Run an adb command against the phone attached to this computer. Pass what you would type after \`adb\`, e.g. \`install -r -g app/build/outputs/apk/debug/app-debug.apk\`, \`logcat -d -t 300 *:E\`, \`shell dumpsys activity activities\`. Runs this machine's adb against the phone CodeDroid is on (CODEDROID_SERIAL, or -s in the command, picks another).

USEFUL:
- Install and start: \`install -r -g <apk>\`, \`shell am start -W -n <pkg>/<activity>\`, \`shell am force-stop <pkg>\`, \`shell pm clear <pkg>\`.
- Logs: clear with \`logcat -c\` before acting, then \`logcat -d -t 300\`; crashes only: \`logcat -d -b crash\`; one app: \`shell pidof <pkg>\` then \`logcat -d --pid=<pid>\`.
- Tests: \`shell am instrument -w -r <test-pkg>/androidx.test.runner.AndroidJUnitRunner\` (add \`-e class <Class>\`; set timeout_s); read the INSTRUMENTATION_STATUS lines.
- State: \`shell dumpsys window | grep mCurrentFocus\`, \`shell dumpsys package <pkg>\`, \`shell settings get global <key>\`.

RULES:
- On a phone with several users, \`settings\`, \`content\`, \`pm grant\` and \`appops\` need \`--user $(adb shell am get-current-user)\`; adb defaults to user 0.
- Do not force-stop, clear or instrument com.codedroid.app: it switches CodeDroid's accessibility off and its tools stop working.
- \`uiautomator dump\` and UiAutomator-based tests suspend CodeDroid's accessibility while they run; use get_screen to read the screen.
- Never stream: \`logcat\` without \`-d\`, \`screenrecord\` without \`--time-limit\` run until timeout_s.
- Ask the user before uninstalling, clearing data, rebooting or deleting files.
- Quotes group words for adb itself (\`install "my app.apk"\`); everything after \`shell\` goes to the phone's shell as written, which does quote, pipe and chain.
- Output is cut at 20,000 characters, keeping the start: filter on the phone with grep or head.
`.trim();

/**
 * Build the tool.
 *
 * The `run`/`env` seams exist so tests can drive the handler without a real
 * adb on PATH: `promisify(execFile)` is captured at module load, so an ESM
 * test can never monkeypatch it after the fact. Mirrors the injection style
 * of `PhoneManager({ transportFactory })` elsewhere in this package.
 *
 * @param {{
 *   run?: (file: string, args: string[], opts: object) => Promise<{stdout: string, stderr: string}>,
 *   env?: Record<string, string | undefined>,
 *   serial?: () => string | undefined,
 * }} [deps] `serial`: the phone CodeDroid is connected on, used when the env names none.
 */
export function createAdbTool({ run = execFileAsync, env = process.env, serial: phoneSerial = () => undefined } = {}) {
  return {
    /** Merged into the handshake instructions by buildProxyServer. */
    instructions: INSTRUCTIONS,
    definition: {
      name: "adb",
      title: "Run adb",
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Arguments to pass to adb, e.g. 'shell pm list packages -3'",
          },
          timeout_s: {
            type: "number",
            description: `Seconds before it is stopped (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`,
          },
        },
        required: ["command"],
      },
      annotations: { title: "Run adb", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },

    /** @param {{command?: string, timeout_s?: number}} args */
    async handler(args) {
      const command = args?.command;
      if (typeof command !== "string" || !command.trim()) {
        return {
          content: [{ type: "text", text: "adb: 'command' must be a non-empty string" }],
          isError: true,
        };
      }

      // execFile — NOT exec()/shell:true — so metacharacters in `command`
      // (`;`, `&&`, backticks, `|`) reach adb as literal argv entries instead of
      // being interpreted by a shell ON THIS MACHINE. This is a generic *adb*
      // passthrough, deliberately not a generic host-shell passthrough.
      //
      // It does NOT follow that the phone sees them literally: `adb shell X; Y`
      // hands "X; Y" to the *device's* shell, which does chain (verified on
      // device 2026-08-06 — `shell echo hi; touch /sdcard/PWNED` created the
      // file). That is inherent to `adb shell` and expected for a dev tool; the
      // boundary this protects is the host, not the phone.
      const argv = adbArgv(command);
      const serial = namesDevice(argv) ? null : env.CODEDROID_SERIAL || env.ANDROID_SERIAL || phoneSerial();
      const timeoutS = Math.min(Math.max(Number(args?.timeout_s) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
      const fullArgv = serial ? ["-s", serial, ...argv] : argv;

      try {
        const { stdout, stderr } = await run(env.ADB || "adb", fullArgv, {
          timeout: timeoutS * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const text = [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
        return { content: [{ type: "text", text: truncate(text) }] };
      } catch (e) {
        // Never let a failed adb invocation escape past the MCP boundary — the
        // model can act on "device unauthorized" text, but not on a dead session.
        const text = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
        return {
          content: [{ type: "text", text: truncate(text || String(e)) }],
          isError: true,
        };
      }
    },
  };
}

export const adbTool = createAdbTool();
