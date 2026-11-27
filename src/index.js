#!/usr/bin/env node
/**
 * codedroid-mcp — connect any MCP client (Claude Code, Codex, Cursor, ...) to CodeDroid on the
 * Android phones paired with this computer.
 *
 * ONE daemon per computer owns the connections to the phones (through the CodeDroid server's relay)
 * and serves MCP over Streamable HTTP on localhost; clients either point at its URL or launch this
 * stdio shim, which auto-starts it.
 *
 * Modes:
 *   codedroid-mcp                  stdio shim → daemon (auto-starts it)  [default]
 *   codedroid-mcp daemon           run the daemon in the foreground
 *   codedroid-mcp setup [code]     add CodeDroid to this computer's coding clients, sign in, and
 *                                  set up the phone on adb if there is one (with a code: pair)
 *   codedroid-mcp login            sign in with Google: every phone on the account is reached
 *   codedroid-mcp logout           sign out
 *   codedroid-mcp pair <code>      pair with the phone showing <code> too, then connect to it
 *   codedroid-mcp connect [phone]  connect to the phones now (and get it allowed there), then exit
 *   codedroid-mcp unpair <phone>   forget one paired phone
 *   codedroid-mcp status [phone]   what the running daemon sees
 *   codedroid-mcp stop             stop the running daemon
 *   codedroid-mcp call <tool> [json]  call one tool and print the result (scripts, CI)
 *   codedroid-mcp skill install|path  the agent skills, for clients without the plugin
 *   codedroid-mcp e2e report [dir] [--check]  quality report and HTML pages for an app's e2e folder
 *   codedroid-mcp e2e verdicts <file> [dir]   record the verifier's verdicts (JSON Lines) in e2e/VERIFY.md
 *   codedroid-mcp e2e verdicts --due [dir]    list the cases due for judging, with their text codes
 *   codedroid-mcp flow run <file>  replay a Maestro flow on the phone, with no model in the loop
 *   codedroid-mcp doctor           check Node, adb, pairing, the daemon, the phones and the clients
 *   codedroid-mcp viewer [phone]   a page showing the phone's screen, where you can take over
 *   codedroid-mcp screencast [phone]  a live video of the phone's screen, over adb
 *
 * Options: --port=<n> (or CODEDROID_MCP_PORT), default 4826. --server=<url> for pair. --no-adb (or
 * CODEDROID_MCP_ADB=0) leaves out the host-side adb tool. CODEDROID_SERIAL picks its device.
 *
 * All log output goes to stderr — stdout is reserved for MCP JSON-RPC frames.
 */
import { VERSION } from "./version.js";

// How long setup waits for a phone to join the account it just signed in with, and how often it looks.
const ACCOUNT_PHONE_WAIT_MS = 10 * 60_000;
const ACCOUNT_PHONE_POLL_MS = 5_000;

function log(...parts) {
  process.stderr.write(`[codedroid-mcp] ${parts.join(" ")}\n`);
}

function fatal(message, code = 1) {
  process.stderr.write(`[codedroid-mcp] ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      out._.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq === -1) out[raw.slice(2)] = "true";
    else out[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return out;
}

function resolvePort(args) {
  const raw = args.port ?? process.env.CODEDROID_MCP_PORT;
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fatal(`Invalid port: ${raw}`);
  return port;
}

/**
 * The adb tool is ON unless turned off with --no-adb or CODEDROID_MCP_ADB=0, for this client's
 * session; for the `daemon` command, for every client. An unrecognised value leaves it off. */
function resolveEnableAdb(args) {
  if (args["no-adb"]) return false;
  if (args["adb"]) return true;
  const raw = process.env.CODEDROID_MCP_ADB;
  if (!raw) return true;
  return raw === "1" || raw.toLowerCase() === "true";
}

const HELP = `codedroid-mcp ${VERSION}

Gives an MCP client (Claude Code, Codex, Cursor...) your Android phones through CodeDroid: see the
screen, tap and type, hand CodeDroid a task, and run adb on this computer.

Usage:
  codedroid-mcp                     MCP stdio server (auto-starts the shared daemon)
  codedroid-mcp setup [code]        Add CodeDroid to the coding clients installed here, sign in
                                    with Google, and set up every phone on adb (install CodeDroid,
                                    turn it on, sign it in); with a code, pair with the phone
                                    showing it instead
                                    (--client=<ids> to choose, --yes to skip the questions,
                                    --no-login to skip signing in)
  codedroid-mcp login               Sign in with the Google account you use in CodeDroid: every
                                    phone signed in with it is reached, with nothing to pair
                                    (--ci prints a token for CODEDROID_TOKEN instead of saving,
                                    --no-browser, --server=<url>)
  codedroid-mcp logout              Sign out; pairings stay
  codedroid-mcp pair <code>         Pair with the phone showing <code>, then connect
                                    (--server=<url> when the phone's command has it).
                                    Pair each phone: earlier pairings stay.
  codedroid-mcp connect [phone]     Connect to the phones now; the first time, tap Allow on each
  codedroid-mcp unpair <phone>      Forget a paired phone (its id or model)
  codedroid-mcp status [phone]      What the running daemon sees
  codedroid-mcp stop                Stop the running daemon
  codedroid-mcp call <tool> [json]  Call one tool and print the result
  codedroid-mcp daemon              Run the shared daemon in the foreground
  codedroid-mcp skill install       Install the agent skills for Claude Code
                                    (--codex for Codex, --dir=<path> anywhere else)
  codedroid-mcp skill path          Print where the skill files are
  codedroid-mcp e2e report [dir]    Write QUALITY.md, quality.json and HTML pages for an app's e2e
                                    folder (default ./e2e); --check lists the stale pages instead
  codedroid-mcp e2e verdicts <file> [dir]
                                    Check the verifier's JSON Lines <file> and append its verdicts
                                    to VERIFY.md in the e2e folder (default ./e2e)
  codedroid-mcp e2e verdicts --due [dir]
                                    List the cases due for judging, per feature, each
                                    with the code of its current text; writes nothing
  codedroid-mcp flow run <file>     Replay a Maestro flow on the phone with no model in the loop
                                    (--device=<phone>, --env=KEY=VALUE, --screenshots=<dir>);
                                    exit 1 when a step fails. Run it from the project.
  codedroid-mcp doctor              Check Node, adb, this computer's pairing, the daemon, each
                                    phone's link and which coding clients have CodeDroid
  codedroid-mcp viewer [phone]      Open a page that shows the phone's screen while an agent drives
                                    it, where you can tap, type and press Back or Home
                                    (--interval=<seconds>, default 3)
  codedroid-mcp screencast [phone]  Stream the phone's screen live (H.264 over adb) to a page on
                                    this computer; the phone must be on adb (--max-fps=<n>,
                                    --max-size=<px>, --open to open the browser)

Sign in first: run setup (or login) and sign in with the Google account you use in CodeDroid, and
every phone signed in with it is reached. Or pair one phone at a time: plug it in with USB
debugging on and run setup, or on the phone, open CodeDroid > Settings > Computers > Pair a
computer, and run the command it shows here. A phone needs CodeDroid signed in, online, with its
accessibility service on. The adb tool, alone, needs the phone on this computer's adb. With several
phones, tools take a device argument naming one.

Options:
  --port=<n>   Daemon port (default 4826; env CODEDROID_MCP_PORT)
  --no-adb     Leave out the host-side adb tool for this client (env CODEDROID_MCP_ADB=0);
               with the daemon command, for every client. Overrides --adb.
  --version    Print version
  --help       This text

Env: CODEDROID_SERIAL picks the adb tool's device when several are attached, and the one setup sets
     up; ADB is the adb binary.
     CODEDROID_TOKEN is the account token from login --ci (CI); CODEDROID_SERVER its server.
     CODEDROID_MCP_UPDATE_CHECK=0 stops the daemon's daily look at npm for a newer release.

Clients:
  claude mcp add codedroid -- npx -y @codedroid/mcp
  codex mcp add codedroid -- npx -y @codedroid/mcp
  { "mcpServers": { "codedroid": { "command": "npx", "args": ["-y", "@codedroid/mcp"] } } }
  or by URL, with the daemon running: http://127.0.0.1:4826/mcp (streamable HTTP), sending
  Authorization: Bearer <the token in ~/.codedroid/daemon-token>, which stays the same across restarts
`;

/** Logger for daemon mode: stderr + ~/.codedroid/daemon.log (it is usually spawned with stdio ignored). */
async function makeDaemonLogger() {
  const { default: fs } = await import("fs");
  const { default: path } = await import("path");
  const { default: os } = await import("os");
  const logFile = path.join(os.homedir(), ".codedroid", "daemon.log");
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  } catch (e) {
    /* stderr still works */
  }
  return (...parts) => {
    const line = `${new Date().toISOString()} ${parts.join(" ")}`;
    process.stderr.write(`[codedroid-mcp] ${line}\n`);
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch (e) {
      /* best-effort */
    }
  };
}

/** A client of the daemon, starting it if needed: for pair, connect, status and call. */
async function daemonClient(port, enableAdbTool) {
  const { ensureDaemonRunning } = await import("./stdio-shim.js");
  const { DEFAULT_PORT } = await import("./daemon.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { daemonTransport } = await import("./daemon-transport.js");
  const { readDaemonToken } = await import("./host.js");
  const effective = port ?? DEFAULT_PORT;
  await ensureDaemonRunning(effective, log, { enableAdbTool });
  const client = new Client({ name: "codedroid-mcp-cli", version: VERSION });
  await client.connect(daemonTransport(effective, readDaemonToken(), { enableAdbTool }), { timeout: 150_000 });
  return client;
}

/** The running daemon's /health, or null when there is none. */
async function daemonHealth(port) {
  const { DEFAULT_PORT } = await import("./daemon.js");
  const { fetchHealth } = await import("./stdio-shim.js");
  return fetchHealth(port ?? DEFAULT_PORT);
}

async function ask(question) {
  const { createInterface } = await import("readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function confirm(question) {
  return !/^n/i.test(await ask(question));
}

/**
 * Which of several devices on adb `setup` sets up, and whether it installs CodeDroid where it is
 * missing: every one, installing, with --yes; outside a terminal, every one, installing on none;
 * otherwise as the user answers, all at once or one by one.
 */
async function choosePhones(phones, args) {
  if (args.yes) return { chosen: phones, install: true };
  if (!process.stdin.isTTY) return { chosen: phones, install: false };
  const missing = phones.filter((p) => !p.installed).length;
  const installing = missing ? `, installing CodeDroid on ${missing === phones.length ? "each" : missing}` : "";
  const answer = await ask(`Set up all ${phones.length}${installing}? [Y/n/pick] `);
  if (/^n/i.test(answer)) return { chosen: [], install: false };
  if (!/^p/i.test(answer)) return { chosen: phones, install: true };
  const chosen = [];
  for (const p of phones) {
    if (await confirm(`Set up ${p.label}${p.installed ? "" : ", installing CodeDroid"}? [Y/n] `)) chosen.push(p);
  }
  return { chosen, install: true };
}

/** Stops with the next step when this computer has no phone to reach: not signed in and not paired. */
async function requirePhones() {
  const { PAIRING_STEPS, readAccount, readHosts } = await import("./host.js");
  if (!readHosts().length && !readAccount()) fatal(`This computer is not signed in or paired with a phone. ${PAIRING_STEPS}`);
}

/** Signs this computer in, saying what to do, and lists the phones; what `login` and `setup` share. */
async function runLogin({ server, ci = false, browser = true } = {}) {
  const { login } = await import("./account.js");
  const { DEFAULT_SERVER, describeHost, accountHost } = await import("./host.js");
  const say = (line) => process.stdout.write(`${line}\n`);
  const bold = process.stdout.isTTY && !process.env.NO_COLOR;
  const highlight = (code) => (bold ? `\x1b[1m${code}\x1b[22m` : code);
  const account = await login({ server: server ?? DEFAULT_SERVER, log: say, open: browser, save: !ci, highlight });
  const who = account.email ?? "your account";
  if (ci) {
    say(`Signed in as ${who}. Nothing was saved here. Keep this token as the CODEDROID_TOKEN secret of your CI:\n\n${account.refresh_token}\n`);
    say("It stays valid while used at least every 30 days, and until this computer is removed in CodeDroid > Settings > Computers on a phone.");
    return account;
  }
  const phones = account.devices.map((d) => describeHost(accountHost(account, d)));
  say(`Signed in as ${who}.${phones.length ? ` Phones on the account: ${phones.join(", ")}.` : ""}`);
  return account;
}

/** What to tap on which phone, said before connecting: "the first time" is when the phone asks. */
async function allowPrompt(device) {
  const { findHost, readHosts } = await import("./host.js");
  let hosts = readHosts();
  try {
    if (device) hosts = [findHost(hosts, device)];
  } catch (e) {
    /* codedroid_status says what is wrong with the selector */
  }
  const models = [...new Set(hosts.map((h) => h.device?.model ?? "your phone"))];
  const which = models.length === 1 ? models[0] : models.length ? `${models.slice(0, -1).join(", ")} and ${models.at(-1)}` : "your phone";
  return `Connecting to ${which}. If CodeDroid on the phone asks whether to allow this computer, tap Allow.`;
}

/**
 * codedroid_status as a person reads it: the phones connected on one line, then each one that is
 * not with its problem. True when at least one phone is connected: an old pairing that is offline
 * does not undo a setup that reached the phone in hand.
 */
function printConnection(status, forget) {
  const devices = status.devices ?? [];
  // A model two phones share names each with its id too.
  const shared = (model) => devices.filter((d) => d.model === model).length > 1;
  const name = (d) => (!d.model ? "your phone" : shared(d.model) ? `${d.model} (${d.id})` : d.model);
  const connected = devices.filter((d) => d.connected);
  const failed = devices.filter((d) => !d.connected);
  if (!devices.length) {
    process.stdout.write(`Not connected: ${status.problem}\n`);
    return false;
  }
  if (connected.length) process.stdout.write(`Connected to ${connected.map(name).join(", ")}.\n`);
  for (const d of failed) process.stdout.write(`${connected.length ? "Not connected to" : "Not connected:"} ${d.model ?? "your phone"} (${d.id}): ${d.problem}\n`);
  if (connected.length && failed.length) process.stdout.write(`${forget}\n`);
  return connected.length > 0;
}

/**
 * Waits for a phone on the signed-in account to come online (someone installing CodeDroid and
 * signing in on it now), so setup can connect and the phone can ask to allow this computer. False
 * after ACCOUNT_PHONE_WAIT_MS with none, or when the account cannot be read.
 */
async function waitForAccountPhone(say) {
  const { fetchDevices } = await import("./account.js");
  const { readAccount } = await import("./host.js");
  const account = readAccount();
  say(
    `No phone is on ${account.email ?? "your account"} yet. On the phone, get CodeDroid from https://get.codedroid.com, ` +
      "sign in with that Google account and turn on Accessibility. Waiting for it here (Ctrl-C to stop)...",
  );
  const deadline = Date.now() + ACCOUNT_PHONE_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ACCOUNT_PHONE_POLL_MS));
    try {
      // Online, so connecting reaches it and it can ask to allow this computer.
      if ((await fetchDevices(account)).some((d) => d.linked)) return true;
    } catch (e) {
      say(e.message);
      return false;
    }
  }
  return false;
}

function printResult(result) {
  for (const item of result.content ?? []) {
    if (item.type === "text") process.stdout.write(item.text + "\n");
    else if (item.type === "image") process.stdout.write(`[image ${item.mimeType}, ${item.data.length} base64 chars]\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return void process.stdout.write(`codedroid-mcp ${VERSION}\n`);
  if (args.help || args._[0] === "help") return void process.stdout.write(HELP);

  let command = args._[0];
  // The phones `setup` just reached over adb, which `pair` then connects as its own.
  let paired = null;
  // Set when `setup` runs: the clients it changed, to restart once the phone is connected.
  let setupRestart = command === "setup" ? [] : null;
  // "setup" or "login" when the command ends by connecting: say what happened per phone, not the status JSON.
  let guided = command === "setup" ? "setup" : null;
  const port = resolvePort(args);
  const enableAdbTool = resolveEnableAdb(args);

  if (command === "skill") {
    const { installSkills, SKILLS_SOURCE, defaultSkillsDir } = await import("./skill.js");
    if (args._[1] === "path") return void process.stdout.write(`${SKILLS_SOURCE}\n`);
    if (args._[1] !== "install") fatal("Usage: codedroid-mcp skill install [--codex | --dir=<path>] | codedroid-mcp skill path");
    const written = installSkills({ dir: args.dir ?? defaultSkillsDir({ codex: !!args.codex }) });
    process.stdout.write(`Installed:\n${written.map((p) => `  ${p}`).join("\n")}\nNew sessions pick them up.\n`);
    return;
  }

  if (command === "login") {
    if (args._.length > 1) fatal("Usage: codedroid-mcp login [--ci] [--no-browser] [--server=<url>]", 2);
    const account = await runLogin({ server: args.server, ci: !!args.ci, browser: !args["no-browser"] });
    if (args.ci) return;
    if (!account.devices.length) {
      process.stdout.write("No phone is signed in to CodeDroid with this account yet: sign in on the phone with the same account, or plug it in and run setup.\n");
      // The running daemon reads the account on its next request; its phone list refreshes with it.
      const health = await daemonHealth(port);
      if (health) process.stdout.write("The running daemon picks the account up on its next call.\n");
      return;
    }
    // Connect now, so each phone asks to allow this computer while the person is here, not on
    // their agent's first call.
    command = "connect";
    args._ = ["connect"];
    guided = "login";
  }

  if (command === "logout") {
    const { logout } = await import("./account.js");
    const { readPairings } = await import("./host.js");
    const account = await logout();
    if (!account) return void process.stdout.write("This computer was not signed in.\n");
    if (account.fromEnv) return void process.stdout.write("Signed out on the server. Remove CODEDROID_TOKEN from the environment too.\n");
    const left = readPairings().length;
    process.stdout.write(`Signed out ${account.email ?? "the account"}.${left ? ` ${left} pairing${left === 1 ? "" : "s"} stay.` : ""}\n`);
    return;
  }

  if (command === "e2e") {
    const sub = args._[1];
    const usage = sub === "verdicts" ? "Usage: codedroid-mcp e2e verdicts <file> [dir] | codedroid-mcp e2e verdicts --due [dir]" : "Usage: codedroid-mcp e2e report [dir] [--check]";
    const flags = sub === "verdicts" ? ["--due"] : ["--check"];
    const unknown = process.argv.slice(2).some((a) => a.startsWith("-") && !flags.includes(a) && a !== "--help");
    const due = sub === "verdicts" && !!args.due;
    if ((sub !== "report" && sub !== "verdicts") || unknown || (sub === "report" || due ? args._.length > 3 : args._.length < 3 || args._.length > 4)) {
      process.stderr.write(`${usage}\n`);
      process.exitCode = 2;
      return;
    }
    const { code, lines } = sub === "report"
      ? (await import("./e2e-report.js")).runE2eReport({ dir: args._[2] ?? "e2e", check: !!args.check })
      : due ? (await import("./e2e-verdicts.js")).listDue({ dir: args._[2] ?? "e2e" })
      : (await import("./e2e-verdicts.js")).recordVerdicts({ file: args._[2], dir: args._[3] ?? "e2e" });
    process.stdout.write(lines.join("\n") + "\n");
    process.exitCode = code;
    return;
  }

  if (command === "flow") {
    const usage = "Usage: codedroid-mcp flow run <file.yaml> [--device=<phone>] [--env=KEY=VALUE,...] [--screenshots=<dir>]";
    if (args._[1] !== "run" || !args._[2]) fatal(usage, 2);
    const { default: path } = await import("path");
    const file = path.resolve(args._[2]);
    const env = {};
    for (const pair of String(args.env ?? "").split(",").filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) fatal(`--env takes KEY=VALUE, not ${pair}`, 2);
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const toolArgs = {
      path: file,
      ...(Object.keys(env).length ? { env } : {}),
      ...(args.screenshots ? { screenshot_dir: path.resolve(args.screenshots) } : {}),
      ...(args.device ? { device: args.device } : {}),
    };
    await requirePhones();
    const client = await daemonClient(port, enableAdbTool);
    const phone = args.device ? { device: args.device } : {};
    // A free phone is claimed for the run, so the fleet sees what holds it, and let go after: a CI
    // run must not leave it held. One this computer already holds (an agent's) is left as it was.
    const claim = async () => {
      try {
        const info = await client.callTool({ name: "device_info", arguments: phone }, undefined, { timeout: 30_000 });
        if (info.isError || JSON.parse(info.content?.[0]?.text ?? "{}").status !== "available") return false;
        const claimed = await client.callTool(
          { name: "claim_device", arguments: { ...phone, purpose: `flow run ${path.basename(file)}`, idle_minutes: 5 } },
          undefined,
          { timeout: 30_000 },
        );
        return !claimed.isError;
      } catch (e) {
        return false;
      }
    };
    const claimed = await claim();
    let result;
    for (;;) {
      result = await client.callTool({ name: "run_flow", arguments: toolArgs }, undefined, { timeout: 600_000 });
      const text = result.content?.[0]?.text ?? "";
      if (result.isError || !text.startsWith("Still running")) break;
      log(text.split("\n")[0]);
    }
    if (claimed) await client.callTool({ name: "release_device", arguments: phone }, undefined, { timeout: 30_000 }).catch(() => {});
    printResult(result);
    await client.close();
    process.exit(result.isError ? 1 : 0);
  }

  if (command === "doctor") {
    const { collectDoctorReport, formatDoctorReport, realProbes } = await import("./doctor.js");
    const { readAccount, readHosts } = await import("./host.js");
    const report = await collectDoctorReport(
      realProbes({
        daemonHealth: () => daemonHealth(port),
        phoneStatus: async () => {
          if (!readHosts().length && !readAccount()) return null;
          const client = await daemonClient(port, enableAdbTool);
          try {
            const result = await client.callTool({ name: "codedroid_status", arguments: {} }, undefined, { timeout: 150_000 });
            return JSON.parse(result.content?.[0]?.text ?? "null");
          } finally {
            await client.close();
          }
        },
      }),
    );
    process.stdout.write(formatDoctorReport(report).join("\n") + "\n");
    process.exit(report.ok ? 0 : 1);
  }

  if (command === "viewer") {
    await requirePhones();
    const { startViewer } = await import("./viewer.js");
    const seconds = Number(args.interval ?? 3);
    if (!(seconds >= 1 && seconds <= 60)) fatal("--interval takes 1 to 60 seconds.", 2);
    const device = args._.slice(1).join(" ") || undefined;
    const client = await daemonClient(port, enableAdbTool);
    const viewer = await startViewer({
      callTool: (name, toolArgs) => client.callTool({ name, arguments: toolArgs }, undefined, { timeout: 150_000 }),
      device,
      intervalMs: seconds * 1000,
    });
    process.stdout.write(`Open ${viewer.url}\nIt shows the phone every ${seconds} s while the tab is visible. Press Ctrl+C to stop.\n`);
    const stop = async () => {
      await viewer.close();
      await client.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  if (command === "screencast") {
    const device = args._.slice(1).join(" ") || undefined;
    const toolArgs = { action: "start", ...(device ? { device } : {}) };
    if (args["max-fps"]) toolArgs.max_fps = Number(args["max-fps"]);
    if (args["max-size"]) toolArgs.max_size = Number(args["max-size"]);
    const client = await daemonClient(port, true);
    const started = await client.callTool({ name: "screencast", arguments: toolArgs }, undefined, { timeout: 90_000 });
    const message = started.content?.[0]?.text ?? "";
    if (started.isError) {
      await client.close();
      fatal(message);
    }
    process.stdout.write(`${message}\nPress Ctrl+C to stop it.\n`);
    const url = /https?:\/\/\S+/.exec(message)?.[0];
    if (args.open && url) {
      const { spawn } = await import("child_process");
      const opener = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
      spawn(opener[0], opener.slice(1), { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    }
    const stop = async () => {
      await client.callTool({ name: "screencast", arguments: { action: "stop", ...(device ? { device } : {}) } }, undefined, { timeout: 30_000 }).catch(() => {});
      await client.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  if (command === "setup") {
    const { clients, MANUAL_SETUP, pickClients } = await import("./setup.js");
    let picked;
    try {
      picked = pickClients(clients(), args.client);
    } catch (e) {
      fatal(e.message);
    }
    if (!picked.length) {
      process.stdout.write(`Found no supported coding client. To add CodeDroid by hand: ${MANUAL_SETUP}\n`);
    } else if (args.yes || !process.stdin.isTTY || (await confirm(`Add CodeDroid to ${picked.map((c) => c.name).join(", ")}? [Y/n] `))) {
      const changed = setupRestart;
      for (const client of picked) {
        process.stdout.write(`${client.name}: `);
        let result;
        try {
          result = client.setup();
        } catch (e) {
          result = { status: "failed", detail: `failed: ${e.message}. Add the server by hand: ${MANUAL_SETUP}` };
        }
        const { status, detail } = result;
        process.stdout.write(`${detail}\n`);
        if (status === "added" || status === "updated") changed.push(client.name);
        if (status === "failed") process.exitCode = 1;
      }
      if (changed.length) process.stdout.write(`Restart ${changed.join(", ")} to load CodeDroid.\n`);
    }
    command = "pair";
    if (args._.length === 1) {
      const { describeHost, PAIR_BY_HAND, LOGIN_STEP, readAccount, readHosts } = await import("./host.js");
      const { findPhones, phoneLines, setUpPhones } = await import("./phone-setup.js");
      const say = (line) => process.stdout.write(`${line}\n`);
      // Signing in reaches every phone on the account: first, unless asked not to, or there is
      // no terminal to sign in from (a script runs login once, or sets CODEDROID_TOKEN).
      if (!readAccount() && !args["no-login"] && process.stdin.isTTY) {
        if (args.yes || (await confirm("Sign in with the Google account you use in CodeDroid, to reach your phones? [Y/n] "))) {
          try {
            await runLogin({ server: args.server });
          } catch (e) {
            say(`Not signed in: ${e.message}`);
          }
        }
      }
      const found = await findPhones();
      const devices = found.phones ?? [];
      const several = devices.length > 1;
      if (several) say(`Devices on adb:\n${phoneLines(devices).join("\n")}`);
      const usable = devices.filter((p) => !p.problem);
      const { chosen, install } = usable.length > 1 ? await choosePhones(usable, args) : { chosen: usable, install: null };
      // The devices that can't be set up are reported with the chosen ones, as not set up.
      const toSetUp = chosen.length ? devices.filter((p) => p.problem || chosen.includes(p)) : [];
      const results = toSetUp.length
        ? await setUpPhones({
            phones: toSetUp,
            log: say,
            // Never unasked: without a terminal to ask in, only --yes installs (agents have codedroid_setup_phone).
            confirmInstall: async (model) =>
              install ?? (!!args.yes || (!!process.stdin.isTTY && (await confirm(`Install CodeDroid on ${model} and set it up? [Y/n] `)))),
          })
        : [];
      const reached = results.filter((r) => r.status === "paired" || r.status === "already-paired");
      const failed = results.filter((r) => r.status === "failed" || r.status === "signed-out" || r.status === "no-phone");
      for (const r of results) say(toSetUp.length > 1 ? `${r.label}: ${r.detail}` : r.detail);
      if (failed.length) process.exitCode = 1;
      if (usable.length && !chosen.length) say("Left them as they were.");
      if (results.some((r) => r.status === "not-installed")) {
        if (process.stdin.isTTY) say(`Left ${toSetUp.length > 1 ? "those" : "it"} as ${toSetUp.length > 1 ? "they were" : "it was"}.`);
        else {
          say("Run this again with --yes to install it.");
          process.exitCode = 1;
        }
      }
      if (reached.length) {
        paired = reached.map((r) => r.host);
      } else if (!usable.length) {
        const hosts = readHosts();
        if (!several) say(found.problem ?? devices[0].problem);
        if (hosts.length) {
          say(`Phones: ${hosts.map(describeHost).join(", ")}. Checking the connection.`);
          command = "connect";
          args._ = ["connect"];
        } else if (readAccount() && process.stdin.isTTY && (await waitForAccountPhone(say))) {
          command = "connect";
          args._ = ["connect"];
        } else {
          say(
            readAccount()
              ? "No phone is on the account yet: open CodeDroid on the phone and sign in with the same Google account, or plug it in with USB debugging on and run this again."
              : `To reach a phone: ${LOGIN_STEP} Or plug the phone in with USB debugging on and run this again, or pair by hand. ${PAIR_BY_HAND}`,
          );
          return;
        }
      } else {
        if (results.some((r) => r.status === "failed") && !readHosts().length && !results.some((r) => r.detail.includes(PAIR_BY_HAND))) {
          say(`To pair by hand: ${PAIR_BY_HAND}`);
        }
        return;
      }
    }
  }

  if (command === "daemon") {
    const { startDaemon, DEFAULT_PORT } = await import("./daemon.js");
    const daemonLog = await makeDaemonLogger();
    daemonLog(`v${VERSION} · daemon`);
    let daemon;
    try {
      daemon = await startDaemon({ port, log: daemonLog, enableAdbTool });
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        const effectivePort = port ?? DEFAULT_PORT;
        const existing = await daemonHealth(effectivePort);
        if (existing) {
          const { assertAuthenticatedDaemon } = await import("./stdio-shim.js");
          assertAuthenticatedDaemon(existing, effectivePort);
          daemonLog(`A CodeDroid daemon is already running on port ${effectivePort}.`);
          process.exit(0);
        }
        fatal(`Port ${effectivePort} is in use by something else. Pick another: codedroid-mcp daemon --port=<n> (clients must use the same).`);
      }
      throw e;
    }
    // This release, now running, brings the computer's other CodeDroid installs along with it, and
    // watches npm for the next one.
    const { refreshInstalls } = await import("./setup.js");
    const { startUpdateChecks } = await import("./update-check.js");
    try {
      for (const line of refreshInstalls()) daemonLog(line);
    } catch (e) {
      daemonLog(`Could not update the other installs on this computer: ${e.message}`);
    }
    startUpdateChecks({ log: daemonLog });
    const shutdown = async () => {
      await daemon.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (command === "stop") {
    const { notStopped, stopDaemon } = await import("./stdio-shim.js");
    const stopped = await stopDaemon(port);
    if (stopped.status === "refused" || stopped.status === "stuck") fatal(notStopped(stopped));
    process.stdout.write(stopped.status === "stopped" ? "Stopped the daemon.\n" : "No daemon was running.\n");
    return;
  }

  if (command === "pair") {
    const code = args._.slice(1).join(" ");
    if (!code && !paired) fatal("Usage: codedroid-mcp pair <code> [--server=<url>]. The phone shows the command: CodeDroid > Settings > Computers > Pair a computer.");
    const { DEFAULT_SERVER, deviceKey, pair } = await import("./host.js");
    const hosts = paired ?? [await pair(code, { server: args.server ?? DEFAULT_SERVER })];
    if (!paired && !hosts[0].account) log(`Paired with ${hosts[0].device.model ?? "the phone"} through ${hosts[0].server}.`);
    // One phone is connected by name; several, with the rest of the computer's phones.
    args._ = hosts.length === 1 ? ["pair", deviceKey(hosts[0])] : ["pair"];
    // A daemon that serves several phones reads new pairings itself. An older one connected, or
    // connecting, holds the old pairing's link; a disconnected one reads the new one.
    const health = await daemonHealth(port);
    if (health && !health.phones && health.phone !== "disconnected") {
      const { notStopped, stopDaemon } = await import("./stdio-shim.js");
      const stopped = await stopDaemon(port);
      if (stopped.status === "refused" || stopped.status === "stuck") {
        fatal(`Paired, but the running daemon still holds the old pairing. ${notStopped(stopped)}`);
      }
      if (stopped.status === "stopped") log("Restarted the daemon for the new pairing.");
    }
  }

  if (command === "unpair") {
    const selector = args._.slice(1).join(" ");
    if (!selector) fatal("Usage: codedroid-mcp unpair <phone>, the phone's id or model as codedroid-mcp status shows it.");
    const { describeHost, unpair } = await import("./host.js");
    let removed;
    try {
      removed = unpair(selector);
    } catch (e) {
      fatal(e.message);
    }
    // A daemon that serves several phones lets go of it on its next request; an older one holds it until it stops.
    const health = await daemonHealth(port);
    if (health && !health.phones) {
      const { notStopped, stopDaemon } = await import("./stdio-shim.js");
      const stopped = await stopDaemon(port);
      if (stopped.status === "refused" || stopped.status === "stuck") fatal(`Unpaired, but ${notStopped(stopped)}`);
    }
    process.stdout.write(
      `Unpaired ${describeHost(removed)}. To also remove this computer on the phone: CodeDroid > Settings > Computers.\n`,
    );
    return;
  }

  if (command === "status" || command === "connect" || command === "pair") {
    await requirePhones();
    const device = args._.slice(1).join(" ") || undefined;
    if (command !== "status") {
      const prompt = await allowPrompt(device);
      if (guided) process.stdout.write(`${prompt}\n`);
      else log(prompt);
    }
    const client = await daemonClient(port, enableAdbTool);
    const result = await client.callTool({ name: "codedroid_status", arguments: { device } }, undefined, { timeout: 150_000 });
    await client.close();
    const status = JSON.parse(result.content?.[0]?.text ?? "{}");
    if (guided) {
      // The end of setup or login: what to do next, not the status a script reads.
      const restart = setupRestart?.length ? `Restart ${setupRestart.join(", ")}, then ask` : "Ask your coding agent";
      const { FORGET } = await import("./status-tool.js");
      const connected = printConnection(status, FORGET);
      if (connected) process.stdout.write(`${restart}: "Read the screen on my phone and describe what is open."\n`);
      // A login that signed in succeeded, whether or not a phone is online now.
      process.exit(connected || guided === "login" ? (process.exitCode ?? 0) : 1);
    }
    printResult(result);
    process.exit(status.connected ? (process.exitCode ?? 0) : 1);
  }

  if (command === "call") {
    const name = args._[1];
    if (!name) fatal("Usage: codedroid-mcp call <tool> ['{\"arg\": 1}']");
    let toolArgs = {};
    if (args._[2]) {
      try {
        toolArgs = JSON.parse(args._[2]);
      } catch (e) {
        fatal(`Arguments must be JSON: ${e.message}`);
      }
    }
    const client = await daemonClient(port, enableAdbTool);
    const result = await client.callTool({ name, arguments: toolArgs }, undefined, { timeout: 600_000 });
    printResult(result);
    await client.close();
    process.exit(result.isError ? 1 : 0);
  }

  if (command) fatal(`Unknown command: ${command}. See codedroid-mcp --help.`);

  const { runStdioShim } = await import("./stdio-shim.js");
  log(`v${VERSION} · stdio → shared daemon`);
  await runStdioShim({ port, log, enableAdbTool });
}

// Expected failures carry a message written for the user; CODEDROID_DEBUG=1 shows the stack.
main().catch((err) => fatal(process.env.CODEDROID_DEBUG ? err?.stack || String(err) : err?.message || String(err)));
