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
 *   codedroid-mcp setup [code]     add CodeDroid to this computer's coding clients, then pair (with
 *                                  no code: set up and pair the phone on adb)
 *   codedroid-mcp pair <code>      pair with the phone showing <code> too, then connect to it
 *   codedroid-mcp connect [phone]  connect to the phones now (and get it allowed there), then exit
 *   codedroid-mcp unpair <phone>   forget one paired phone
 *   codedroid-mcp status [phone]   what the running daemon sees
 *   codedroid-mcp stop             stop the running daemon
 *   codedroid-mcp call <tool> [json]  call one tool and print the result (scripts, CI)
 *   codedroid-mcp skill install|path  the agent skills, for clients without the plugin
 *   codedroid-mcp e2e report [dir] [--check]  quality report and HTML pages for an app's e2e folder
 *
 * Options: --port=<n> (or CODEDROID_MCP_PORT), default 4826. --server=<url> for pair. --no-adb (or
 * CODEDROID_MCP_ADB=0) leaves out the host-side adb tool. CODEDROID_SERIAL picks its device.
 *
 * All log output goes to stderr — stdout is reserved for MCP JSON-RPC frames.
 */
import { VERSION } from "./version.js";

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
  codedroid-mcp setup [code]        Add CodeDroid to the coding clients installed here, then
                                    pair with the phone showing <code>; with no code, set up
                                    the phone on adb (install CodeDroid, turn it on) and pair
                                    (--client=<ids> to choose, --yes to skip the questions)
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

Pair first: plug the phone in with USB debugging on and run setup, or on the phone, open CodeDroid >
Settings > Computers > Pair a computer, and run the command it shows here; do the same on every
phone to use. A phone needs CodeDroid signed in, online, with its accessibility service on. The
adb tool, alone, needs the phone on this computer's adb. With several phones paired, tools take a
device argument naming one.

Options:
  --port=<n>   Daemon port (default 4826; env CODEDROID_MCP_PORT)
  --no-adb     Leave out the host-side adb tool for this client (env CODEDROID_MCP_ADB=0);
               with the daemon command, for every client. Overrides --adb.
  --version    Print version
  --help       This text

Env: CODEDROID_SERIAL picks the adb tool's device when several are attached; ADB is the adb binary.

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

async function confirm(question) {
  const { createInterface } = await import("readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return !/^n/i.test(answer.trim());
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
  // A pairing `setup` just made over adb, which `pair` then connects as its own.
  let paired = null;
  // Set when `setup` runs: the clients it changed, to restart once the phone is connected.
  let setupRestart = command === "setup" ? [] : null;
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

  if (command === "e2e") {
    const usage = "Usage: codedroid-mcp e2e report [dir] [--check]";
    if (args._[1] !== "report" || args._.length > 3) {
      process.stderr.write(`${usage}\n`);
      process.exitCode = 2;
      return;
    }
    const { runE2eReport } = await import("./e2e-report.js");
    const { code, lines } = runE2eReport({ dir: args._[2] ?? "e2e", check: !!args.check });
    process.stdout.write(lines.join("\n") + "\n");
    process.exitCode = code;
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
      const { describeHost, deviceKey, PAIR_BY_HAND, readHosts } = await import("./host.js");
      const { setUpPhone } = await import("./phone-setup.js");
      const say = (line) => process.stdout.write(`${line}\n`);
      const phone = await setUpPhone({
        log: say,
        // Never unasked: without a terminal to ask in, only --yes installs (agents have codedroid_setup_phone).
        confirmInstall: async (model) =>
          !!args.yes || (!!process.stdin.isTTY && (await confirm(`Install CodeDroid on ${model} and set it up? [Y/n] `))),
      });
      if (phone.status === "paired") {
        paired = phone.host;
      } else if (phone.status === "already-paired") {
        say(`${phone.detail} Checking the connection.`);
        command = "connect";
        args._ = ["connect", deviceKey(phone.host)];
      } else {
        const hosts = readHosts();
        say(phone.detail);
        if (phone.status === "no-phone") {
          say(
            hosts.length
              ? `Paired with ${hosts.map(describeHost).join(", ")}.`
              : `To pair, plug the phone in with USB debugging on and run this again, or pair by hand. ${PAIR_BY_HAND}`,
          );
        } else if (phone.status === "not-installed") {
          if (process.stdin.isTTY) say("Left it as it was.");
          else {
            say("Run this again with --yes to install it.");
            process.exitCode = 1;
          }
        } else {
          process.exitCode = 1;
          if (phone.status === "failed" && !hosts.length && !phone.detail.includes(PAIR_BY_HAND)) say(`To pair by hand: ${PAIR_BY_HAND}`);
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
    const host = paired ?? (await pair(code, { server: args.server ?? DEFAULT_SERVER }));
    log(`Paired with ${host.device.model ?? "the phone"} through ${host.server}.`);
    args._ = ["pair", deviceKey(host)];
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
    const { PAIRING_STEPS, readHosts } = await import("./host.js");
    if (!readHosts().length) fatal(`This computer is not paired with a phone. ${PAIRING_STEPS}`);
    if (command !== "status") log("Connecting. The first time, the phone asks whether to allow this computer: tap Allow.");
    const device = args._.slice(1).join(" ") || undefined;
    const client = await daemonClient(port, enableAdbTool);
    const result = await client.callTool({ name: "codedroid_status", arguments: { device } }, undefined, { timeout: 150_000 });
    await client.close();
    const status = JSON.parse(result.content?.[0]?.text ?? "{}");
    if (setupRestart) {
      // The end of setup: what to do next, not the status a script reads.
      const restart = setupRestart.length ? `Restart ${setupRestart.join(", ")}, then ask` : "Ask your coding agent";
      process.stdout.write(
        status.connected
          ? `Connected to ${status.device?.model ?? "your phone"}. ${restart}: "Read the screen on my phone and describe what is open."\n`
          : `Not connected: ${status.problem}\n`,
      );
    } else {
      printResult(result);
    }
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
