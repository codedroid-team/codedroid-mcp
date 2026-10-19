#!/usr/bin/env node
/**
 * codedroid-mcp — connect any MCP client (Claude Code, Codex, Cursor, ...) to CodeDroid on the
 * Android phone attached to this computer over adb.
 *
 * ONE daemon per computer owns the connection to the phone and serves MCP over Streamable HTTP
 * on localhost; clients either point at its URL or launch this stdio shim, which auto-starts it.
 *
 * Modes:
 *   codedroid-mcp                  stdio shim → daemon (auto-starts it)  [default]
 *   codedroid-mcp daemon           run the daemon in the foreground
 *   codedroid-mcp connect          connect to the phone now (and get it allowed there), then exit
 *   codedroid-mcp status           what the running daemon sees
 *   codedroid-mcp stop             stop the running daemon
 *   codedroid-mcp call <tool> [json]  call one tool and print the result (scripts, CI)
 *   codedroid-mcp skill install|path  the agent skills, for clients without the plugin
 *
 * Options: --port=<n> (or CODEDROID_MCP_PORT), default 4826. CODEDROID_MCP_ADB=0 leaves out the
 * adb tool. CODEDROID_SERIAL picks the phone when several are attached.
 *
 * All log output goes to stderr — stdout is reserved for MCP JSON-RPC frames.
 *
 * Forked from aura-mcp-connect (MIT, Copyright (c) 2026 Dinesh Kumar C; see LICENSE.aura-mcp-connect).
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

/** The adb tool is on unless CODEDROID_MCP_ADB=0 (or --no-adb). The env var reaches a daemon the shim starts. */
function resolveEnableAdb(args) {
  if (args["no-adb"]) return false;
  const raw = process.env.CODEDROID_MCP_ADB;
  return raw === undefined || (raw !== "0" && raw.toLowerCase() !== "false");
}

const HELP = `codedroid-mcp ${VERSION}

Gives an MCP client (Claude Code, Codex, Cursor...) the Android phone attached to this computer
through CodeDroid: see the screen, tap and type, hand CodeDroid a task, and run adb.

Usage:
  codedroid-mcp                     MCP stdio server (auto-starts the shared daemon)
  codedroid-mcp connect             Connect to the phone now; the first time, tap Allow on it
  codedroid-mcp status              What the running daemon sees
  codedroid-mcp stop                Stop the running daemon
  codedroid-mcp call <tool> [json]  Call one tool and print the result
  codedroid-mcp daemon              Run the shared daemon in the foreground
  codedroid-mcp skill install       Install the agent skills for Claude Code
                                    (--codex for Codex, --dir=<path> anywhere else)
  codedroid-mcp skill path          Print where the skill files are

The phone needs USB debugging (or Wireless debugging) allowed for this computer, and CodeDroid
installed with its accessibility service on.

Options:
  --port=<n>   Daemon port (default 4826; env CODEDROID_MCP_PORT)
  --no-adb     Leave out the adb tool (env CODEDROID_MCP_ADB=0)
  --version    Print version
  --help       This text

Env: CODEDROID_SERIAL picks the phone when several are attached; ADB is the adb binary.

Clients:
  claude mcp add codedroid -- npx -y @codedroid/mcp
  codex mcp add codedroid -- npx -y @codedroid/mcp
  { "mcpServers": { "codedroid": { "command": "npx", "args": ["-y", "@codedroid/mcp"] } } }
  or by URL, with the daemon running: http://127.0.0.1:4826/mcp (streamable HTTP)
`;

/** Logger for daemon mode: stderr + ~/.codedroid/daemon.log (it is usually spawned with stdio ignored). */
async function makeDaemonLogger() {
  const { default: fs } = await import("fs");
  const { default: path } = await import("path");
  const { default: os } = await import("os");
  const logFile = path.join(os.homedir(), ".codedroid", "daemon.log");
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
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

/** A client of the daemon, starting it if needed: for connect, status and call. */
async function daemonClient(port, enableAdbTool) {
  const { ensureDaemonRunning } = await import("./stdio-shim.js");
  const { DEFAULT_PORT } = await import("./daemon.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const effective = port ?? DEFAULT_PORT;
  await ensureDaemonRunning(effective, log, { enableAdbTool });
  const client = new Client({ name: "codedroid-mcp-cli", version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${effective}/mcp`)), { timeout: 150_000 });
  return client;
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
        const healthy = await fetch(`http://127.0.0.1:${effectivePort}/health`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (healthy?.service === "codedroid-mcp-daemon") {
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
    const { DEFAULT_PORT } = await import("./daemon.js");
    const res = await fetch(`http://127.0.0.1:${port ?? DEFAULT_PORT}/shutdown`, { method: "POST" }).catch(() => null);
    process.stdout.write(res?.ok ? "Stopped the daemon.\n" : "No daemon was running.\n");
    return;
  }

  if (command === "status" || command === "connect") {
    if (command === "connect") log("Connecting to the phone. The first time, it asks whether to allow this computer: tap Allow.");
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
