/**
 * adb — a single generic MCP tool that runs an adb command against a phone
 * attached to THIS computer (USB, or Wireless Debugging).
 *
 * On by default; --no-adb or CODEDROID_MCP_ADB=0 turns it off for a client, and it has a per-call
 * timeout. Marked destructive so clients ask before running it.
 *
 * It never touches the connection to CodeDroid: it shells out to this machine's
 * own `adb`, exactly like a developer typing `adb install app.apk` themselves.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_S = 60;
const TRANSFER_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 900;

// adb's global options that take a value: `-s SERIAL`, `-t ID`, `-H host`, `-P port`, `-L socket`,
// `--one-device SERIAL`, `--reply-fd FD`.
const VALUE_OPTIONS = new Set(["-s", "-t", "-H", "-P", "-L", "--one-device", "--reply-fd"]);
// Global options that pick the device, after which CODEDROID_SERIAL must not be added.
const DEVICE_OPTIONS = new Set(["-s", "-t", "-d", "-e"]);
// Subcommands whose rest is a command line for the phone's shell.
const SHELLS = new Set(["shell", "exec-out"]);
// Subcommands that move whole files, so they get the longer default timeout.
const TRANSFERS = new Set(["install", "install-multiple", "install-multi-package", "push", "pull", "sideload", "bugreport", "backup", "restore"]);
// Subcommands that act on this computer rather than the phone.
const HOST_ONLY = new Set(["keygen", "ppp", "server", "nodaemon", "fork-server"]);

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

/** [argv] split into its global options, subcommand and the subcommand's own arguments. */
function parseArgv(argv) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) i += VALUE_OPTIONS.has(argv[i]) ? 2 : 1;
  return { globals: argv.slice(0, i), subcommand: argv[i], rest: argv.slice(i + 1) };
}

/** Whether [globals] already pick the device; adb also takes `-sSERIAL` and `-tID`. */
function namesDevice(globals) {
  return globals.some((word) => DEVICE_OPTIONS.has(word) || /^-[st]./.test(word));
}

/** [file] with symlinks resolved, as far as it exists: a file to be pulled does not yet. */
function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch (e) {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(realPath(parent), path.basename(file));
  }
}

function isInside(dir, file) {
  const relative = path.relative(dir, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The client's project directory, or null without one. A client started in the home directory or
 * above it (GUI clients often are) has none: that would let push and pull reach every file.
 */
export function projectDir(cwd, home = os.homedir()) {
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return null;
  const dir = realPath(cwd);
  return isInside(dir, realPath(home)) ? null : dir;
}

/** The files on this computer that [subcommand] copies to the phone or overwrites. */
function copiedHostFiles(subcommand, rest) {
  // A leading dash does not stop `-/../x` being a path: adb takes it as one after `--`, and bugreport
  // and restore always do. Without a separator it stays in the directory, so is safe to skip as a flag.
  const isFlag = (word) => word.startsWith("-") && !/[/\\]/.test(word);
  const words = rest.filter((word, i) => !isFlag(word) && !["-z", "-f"].includes(rest[i - 1]));
  if (subcommand === "push") return words.slice(0, -1);
  if (subcommand === "pull") return [words.length > 1 ? words.at(-1) : "."];
  if (subcommand === "bugreport") return [words[0] ?? "."];
  if (subcommand === "restore") return words;
  // adb uses the last -f; one with no file is adb's own error.
  if (subcommand === "backup") return [rest.includes("-f") ? rest[rest.lastIndexOf("-f") + 1] ?? "." : "backup.adb"];
  return [];
}

/**
 * Why [argv] must not run, or null. execFile keeps the command out of this computer's shell, but
 * adb itself can reach other servers and copy local files, and screen text can steer an agent.
 */
function refusal({ globals, subcommand, rest }, project) {
  if (globals.some((word) => /^-[HPL]/.test(word))) {
    return "adb: -H, -P and -L are not available here: this tool uses this computer's adb server.";
  }
  if (HOST_ONLY.has(subcommand)) return `adb: '${subcommand}' is not available here: it acts on this computer, not the phone.`;
  if (subcommand?.startsWith("install") || subcommand === "sideload") {
    const relative = rest.find((word) => /\.(apk|apex|zip)$/i.test(word) && !path.isAbsolute(word));
    if (relative && !project) return `adb: '${relative}' is relative and this client has no project directory. Pass its absolute path.`;
  }
  const roots = [project, os.tmpdir(), "/tmp"].filter(Boolean).map(realPath);
  for (const file of copiedHostFiles(subcommand, rest)) {
    if (!path.isAbsolute(file) && !project) {
      return `adb: '${file}' is relative and this client has no project directory. Use an absolute path in ${roots.join(" or ")}.`;
    }
    if (!roots.some((root) => isInside(root, realPath(path.resolve(project ?? "/", file))))) {
      return `adb: '${subcommand}' can only use local files in ${roots.join(" or ")}, not '${file}'. Copy it there, or ask the user to run this adb command.`;
    }
  }
  return null;
}

/** Where adb may be besides PATH: a GUI client's daemon does not get the terminal's PATH. */
function adbLocations(env) {
  if (env.ADB) return [env.ADB];
  const home = os.homedir();
  const sdks = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    path.join(home, "Library", "Android", "sdk"),
    path.join(home, "Android", "Sdk"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Android", "Sdk"),
  ];
  return [
    "adb",
    ...sdks.filter(Boolean).map((sdk) => path.join(sdk, "platform-tools", "adb")),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
  ];
}

const CONNECT_PHONE =
  "On the phone turn on USB debugging and connect the cable, or use Wireless debugging (`pair <ip:port>`, then `connect <ip:port>`). " +
  "CodeDroid's own tools, and install_apk to install a build, work without this.";

/** What to do about the failures adb's own message does not explain. */
const HINTS = [
  [/no devices\/emulators found|device '.*' not found/, `No phone is on this computer's adb. ${CONNECT_PHONE}`],
  [/unauthorized/, "Ask the user to accept the USB debugging prompt on the phone, then try again."],
  [/device offline|still connecting/, "Ask the user to reconnect the phone, then try again."],
  [/more than one (device|emulator)/, "Pass -s <serial> for the phone to use, or set CODEDROID_SERIAL."],
  [/INSTALL_FAILED_UPDATE_INCOMPATIBLE/, "The installed app has a different signature. Uninstalling it deletes its data: ask the user first."],
  [/INSTALL_FAILED_VERSION_DOWNGRADE/, "A newer version is installed. For a debuggable app add -d; otherwise ask the user about uninstalling it."],
  [/INSTALL_FAILED_TEST_ONLY/, "The APK is test-only: add -t."],
  [/INSTALL_FAILED_USER_RESTRICTED|INSTALL_FAILED_VERIFICATION_FAILURE/, "The phone blocked it. Ask the user to allow installing over USB in Developer options and to accept any prompt."],
  [/INSTALL_FAILED_NO_MATCHING_ABIS/, "The APK has no native code for this phone's CPU: rebuild for its ABI."],
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE/, "The phone is out of storage. Ask the user to free some."],
];

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
  "You also have `adb`: this computer's adb, for the phone when it is on USB or Wireless debugging. Use " +
  "it to read logs (logcat -d), inspect state (dumpsys), start activities, and run instrumentation " +
  "tests; use install_apk to install builds and CodeDroid's tools to see and drive the screen. Never force-stop or " +
  "instrument com.codedroid.agent.";

/** The tool's full guidance: read right before calling it. */
const DESCRIPTION = `
Run an adb command against the phone attached to this computer. Pass what you would type after \`adb\`, e.g. \`install -r -g app/build/outputs/apk/debug/app-debug.apk\`, \`logcat -d -t 300 *:E\`, \`shell dumpsys activity activities\`. Runs this machine's adb, so the phone must be on it (USB or Wireless debugging): CODEDROID_SERIAL or ANDROID_SERIAL, or -s in the command, picks it when several devices are; otherwise adb's own default. Relative paths start from the client's working directory; use absolute ones if adb says it has none.

USEFUL:
- Install and start: \`install -r -g <apk>\`, \`shell am start -W -n <pkg>/<activity>\`, \`shell am force-stop <pkg>\`, \`shell pm clear <pkg>\`.
- Logs: clear with \`logcat -c\` before acting, then \`logcat -d -t 300\`; crashes only: \`logcat -d -b crash\`; one app: \`shell pidof <pkg>\` then \`logcat -d --pid=<pid>\`.
- Tests: \`shell am instrument -w -r <test-pkg>/androidx.test.runner.AndroidJUnitRunner\` (add \`-e class <Class>\`; set timeout_s); read the INSTRUMENTATION_STATUS lines.
- State: \`shell dumpsys window | grep mCurrentFocus\`, \`shell dumpsys package <pkg>\`, \`shell settings get global <key>\`.

RULES:
- On a phone with several users, \`settings\`, \`content\`, \`pm grant\` and \`appops\` need \`--user $(adb shell am get-current-user)\`; adb defaults to user 0.
- Do not force-stop, clear or instrument com.codedroid.agent: it switches CodeDroid's accessibility off and its tools stop working.
- \`uiautomator dump\` and UiAutomator-based tests suspend CodeDroid's accessibility while they run; use get_screen to read the screen.
- Never stream: \`logcat\` without \`-d\`, \`screenrecord\` without \`--time-limit\` run until timeout_s.
- Ask the user before uninstalling, clearing data, rebooting or deleting files.
- \`push\`, \`pull\`, \`bugreport\`, \`backup\` and \`restore\` only use local files in the project or the temp directory; \`install\` takes any path.
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
 *   cwd?: string | null,
 * }} [deps] cwd is the client's working directory: the daemon's own is whichever client started it.
 */
export function createAdbTool({ run = execFileAsync, env = process.env, cwd = null } = {}) {
  /** With stdin closed: a bare `shell` would otherwise wait on it until the timeout. */
  const runChild = (file, args, opts) => {
    const running = run(file, args, opts);
    running.child?.stdin?.end();
    return running;
  };
  /** Runs adb from the first location that has it. */
  const runAdb = async (args, opts) => {
    const locations = adbLocations(env);
    for (const [i, file] of locations.entries()) {
      try {
        return await runChild(file, args, opts);
      } catch (e) {
        if (e?.code !== "ENOENT" || i === locations.length - 1) throw e;
      }
    }
  };

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
            description: `Seconds before it is stopped (default ${DEFAULT_TIMEOUT_S}, ${TRANSFER_TIMEOUT_S} for installs and file transfers, max ${MAX_TIMEOUT_S})`,
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
      const parsed = parseArgv(argv);
      const home = os.homedir();
      const project = projectDir(cwd, home);
      const refused = refusal(parsed, project);
      if (refused) return { content: [{ type: "text", text: refused }], isError: true };

      const serial = namesDevice(parsed.globals) ? null : env.CODEDROID_SERIAL || env.ANDROID_SERIAL;
      const defaultTimeoutS = TRANSFERS.has(parsed.subcommand) ? TRANSFER_TIMEOUT_S : DEFAULT_TIMEOUT_S;
      const timeoutS = Math.min(Math.max(Number(args?.timeout_s) || defaultTimeoutS, 1), MAX_TIMEOUT_S);
      const fullArgv = serial ? ["-s", serial, ...argv] : argv;
      const opts = { timeout: timeoutS * 1000, maxBuffer: 10 * 1024 * 1024, cwd: project ?? home };

      try {
        const { stdout, stderr } = await runAdb(fullArgv, opts);
        const text = joinOutput(stdout, stderr) || "(no output)";
        // Older platform-tools exit 0 from a failed install.
        const failed = parsed.subcommand?.startsWith("install") && /^Failure \[|failed to install/m.test(text);
        return failed ? failure(text, hintFor(text)) : { content: [{ type: "text", text: truncate(text) }] };
      } catch (e) {
        // Never let a failed adb invocation escape past the MCP boundary — the
        // model can act on "device unauthorized" text, but not on a dead session.
        if (e?.code === "ENOENT") {
          return failure(
            `adb was not found on this computer. Install Android platform-tools ` +
              `(https://developer.android.com/tools/releases/platform-tools) or set ADB to its path.`,
          );
        }
        // Only the start of the output is kept anyway, so too much of it is not a failure.
        if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return { content: [{ type: "text", text: truncate(joinOutput(e.stdout, e.stderr)) }] };
        }
        const output = joinOutput(e?.stdout, e?.stderr);
        if (e?.killed) {
          return failure(output, `adb was stopped after ${timeoutS}s. Raise timeout_s, or avoid commands that stream or wait.`);
        }
        const text = [output, e?.message?.split("\n")[0]].filter(Boolean).join("\n") || String(e);
        const devices = /more than one (device|emulator)/.test(text) ? await listDevices(runAdb, opts) : "";
        return failure(text, hintFor(text), devices);
      }
    },
  };
}

/** adb's output, without the notice it prints when it has to start its server. */
function joinOutput(stdout, stderr) {
  const notices = /^\* daemon .*\n?/gm;
  return [stdout, stderr?.replace(notices, "")].filter(Boolean).join("\n").trim();
}

function hintFor(text) {
  return HINTS.find(([pattern]) => pattern.test(text))?.[1];
}

/** [output] cut to size, followed by [notes], which long output must not push out. */
function failure(output, ...notes) {
  return { content: [{ type: "text", text: [truncate(output), ...notes].filter(Boolean).join("\n") }], isError: true };
}

async function listDevices(runAdb, opts) {
  try {
    return (await runAdb(["devices", "-l"], opts)).stdout.trim();
  } catch (e) {
    return "";
  }
}
