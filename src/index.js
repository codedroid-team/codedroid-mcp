#!/usr/bin/env node
/**
 * codedroid-mcp — connect any MCP client (Claude Code, Codex, Cursor, ...) to CodeDroid on an
 * Android phone paired with this computer.
 *
 * ONE daemon per computer owns the connection to the phone (through the CodeDroid server's relay)
 * and serves MCP over Streamable HTTP on localhost; clients either point at its URL or launch this
 * stdio shim, which auto-starts it.
 *
 * Modes:
 *   codedroid-mcp                  stdio shim → daemon (auto-starts it)  [default]
 *   codedroid-mcp daemon           run the daemon in the foreground
 *   codedroid-mcp pair <code>      pair with the phone showing <code>, then connect
 *   codedroid-mcp connect          connect to the phone now (and get it allowed there), then exit
 *   codedroid-mcp status           what the running daemon sees
 *   codedroid-mcp stop             stop the running daemon
 *   codedroid-mcp call <tool> [json]  call one tool and print the result (scripts, CI)
 *   codedroid-mcp skill install|path  the agent skills, for clients without the plugin
 *
 * Options: --port=<n> (or CODEDROID_MCP_PORT), default 4826. --server=<url> for pair. --adb (or
 * CODEDROID_MCP_ADB=1) adds the host-side adb tool, off by default. CODEDROID_SERIAL picks its device.
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
 * The adb tool is OFF unless turned on with --adb or CODEDROID_MCP_ADB=1: it runs commands on this
 * computer, so it is opt-in. The env var reaches a daemon the shim starts (--no-adb stays as an
 * explicit off, e.g. to override the env var). */
function resolveEnableAdb(args) {
  if (args["no-adb"]) return false;
  if (args["adb"]) return true;
  const raw = process.env.CODEDROID_MCP_ADB;
  if (raw === undefined) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

const HELP = `codedroid-mcp ${VERSION}

Gives an MCP client (Claude Code, Codex, Cursor...) your Android phone through CodeDroid: see the
screen, tap and type, hand CodeDroid a task, and — with --adb — run adb on this computer.

Usage:
  codedroid-mcp                     MCP stdio server (auto-starts the shared daemon)
  codedroid-mcp pair <code>         Pair with the phone showing <code>, then connect
                                    (--server=<url> when the phone's command has it)
  codedroid-mcp connect             Connect to the phone now; the first time, tap Allow on it
  codedroid-mcp status              What the running daemon sees
  codedroid-mcp stop                Stop the running daemon
  codedroid-mcp call <tool> [json]  Call one tool and print the result
  codedroid-mcp daemon              Run the shared daemon in the foreground
  codedroid-mcp skill install       Install the agent skills for Claude Code
                                    (--codex for Codex, --dir=<path> anywhere else)
  codedroid-mcp skill path          Print where the skill files are

Pair first: on the phone, open CodeDroid > Settings > Computers > Pair a computer, and run the
command it shows here. The phone needs CodeDroid signed in, online, with its accessibility
service on. The adb tool, alone, needs the phone on this computer's adb.

Options:
  --port=<n>   Daemon port (default 4826; env CODEDROID_MCP_PORT)
  --adb        Start a daemon with the host-side adb tool (env CODEDROID_MCP_ADB=1)
  --no-adb     Start without adb (overrides --adb and CODEDROID_MCP_ADB)
               These settings do not change an already-running shared daemon.
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
  await client.connect(daemonTransport(effective, readDaemonToken()), { timeout: 150_000 });
  return client;
}

/** The running daemon's /health, or null when there is none. */
async function daemonHealth(port) {
  const { DEFAULT_PORT } = await import("./daemon.js");
  const { fetchHealth } = await import("./stdio-shim.js");
  return fetchHealth(port ?? DEFAULT_PORT);
}

/**
 * Stops a running daemon and waits until it is gone. Resolves {status, port, pid}, status being
 * "stopped"; "none" when no daemon was running; "refused" when it rejected this user's token; or
 * "stuck" when it accepted but is still up 5 s later.
 */
async function stopDaemon(port) {
  const { DEFAULT_PORT } = await import("./daemon.js");
  const { readDaemonToken } = await import("./host.js");
  const effective = port ?? DEFAULT_PORT;
  const health = await daemonHealth(effective);
  if (!health) return { status: "none", port: effective };
  const shutdown = (token) => fetch(`http://127.0.0.1:${effective}/shutdown`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  // Legacy daemons need no token, including when the new credential file is invalid. Earlier
  // token-enabled daemons lacked the capability marker; retry those with a token after a 401.
  const { DAEMON_AUTHENTICATION } = await import("./daemon.js");
  const authenticated = health.authentication === DAEMON_AUTHENTICATION;
  let res = await shutdown(authenticated ? readDaemonToken() : null);
  if (!authenticated && res?.status === 401) {
    await res.arrayBuffer();
    const token = readDaemonToken();
    if (token) res = await shutdown(token);
  }
  if (res?.status === 401) return { status: "refused", port: effective, pid: health.pid };
  for (let i = 0; i < 50 && (await daemonHealth(effective)); i++) await new Promise((r) => setTimeout(r, 100));
  return { status: (await daemonHealth(effective)) ? "stuck" : "stopped", port: effective, pid: health.pid };
}

/** Why a daemon did not stop, and what to do about it; for stop and pair. */
function notStopped({ status, port, pid }) {
  const daemon = `The CodeDroid daemon on port ${port}${pid ? ` (pid ${pid})` : ""}`;
  return status === "refused"
    ? `${daemon} refused to stop: it does not accept the token in ~/.codedroid/daemon-token. End that process to stop it.`
    : `${daemon} did not exit within 5 s. End that process to stop it.`;
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

  const command = args._[0];
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
    const stopped = await stopDaemon(port);
    if (stopped.status === "refused" || stopped.status === "stuck") fatal(notStopped(stopped));
    process.stdout.write(stopped.status === "stopped" ? "Stopped the daemon.\n" : "No daemon was running.\n");
    return;
  }

  if (command === "pair") {
    const code = args._.slice(1).join(" ");
    if (!code) fatal("Usage: codedroid-mcp pair <code> [--server=<url>]. The phone shows the command: CodeDroid > Settings > Computers > Pair a computer.");
    const { DEFAULT_SERVER, pair } = await import("./host.js");
    const host = await pair(code, { server: args.server ?? DEFAULT_SERVER });
    log(`Paired with ${host.device.model ?? "the phone"} through ${host.server}.`);
    // A daemon connected, or connecting, holds the old pairing's link; a disconnected one reads the new one.
    const phone = (await daemonHealth(port))?.phone;
    if (phone && phone !== "disconnected") {
      const stopped = await stopDaemon(port);
      if (stopped.status === "refused" || stopped.status === "stuck") {
        fatal(`Paired, but the running daemon still holds the old pairing. ${notStopped(stopped)}`);
      }
      if (stopped.status === "stopped") log("Restarted the daemon for the new pairing.");
    }
  }

  if (command === "status" || command === "connect" || command === "pair") {
    const { PAIRING_STEPS, readHost } = await import("./host.js");
    if (!readHost()) fatal(`This computer is not paired with a phone. ${PAIRING_STEPS}`);
    if (command !== "status") log("Connecting to the phone. The first time, it asks whether to allow this computer: tap Allow.");
    const client = await daemonClient(port, enableAdbTool);
    const result = await client.callTool({ name: "codedroid_status", arguments: {} }, undefined, { timeout: 150_000 });
    printResult(result);
    await client.close();
    const status = JSON.parse(result.content?.[0]?.text ?? "{}");
    process.exit(status.connected ? 0 : 1);
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
