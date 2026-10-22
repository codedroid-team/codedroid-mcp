/**
 * stdio-shim — the `codedroid-mcp` stdio entry point MCP clients launch. It
 * proxies to the shared local daemon, auto-starting it when needed, so every
 * client on this computer shares one connection to the phone.
 *
 *   IDE ── stdio ── this shim ── HTTP ── daemon ── relay ── CodeDroid on the phone
 *
 * Any number of shims (one per IDE/window) share the one phone connection.
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildProxyServer } from "./proxy-core.js";
import { DEFAULT_PORT, DAEMON_AUTHENTICATION } from "./daemon.js";
import { daemonTransport } from "./daemon-transport.js";
import { readDaemonToken } from "./host.js";
import { VERSION } from "./version.js";

/** The daemon's /health on [port], or null when no CodeDroid daemon answers there. */
export async function fetchHealth(port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.service === "codedroid-mcp-daemon" ? body : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Refuse legacy daemons before sending credentials or accepting their tools. */
export function assertAuthenticatedDaemon(health, port) {
  if (health.authentication !== DAEMON_AUTHENTICATION) {
    throw new Error(
      `The CodeDroid daemon on port ${port} needs an authentication upgrade. ` +
        `Run npx -y @codedroid/mcp stop --port=${port}, then reconnect to start an authenticated daemon.`,
    );
  }
}

export async function ensureDaemonRunning(port, log, { enableAdbTool = false } = {}) {
  const existing = await fetchHealth(port);
  if (existing) {
    assertAuthenticatedDaemon(existing, port);
    // A daemon's tool set is fixed at startup, so an already-running one can't
    // be changed by a later client. Say so, or the user has nothing to go on.
    if (enableAdbTool !== existing.adbToolEnabled) {
      log(
        `A daemon is already running on port ${port} with the adb tool ` +
          `${existing.adbToolEnabled ? "on" : "off"}; this client's adb setting (--adb, --no-adb, CODEDROID_MCP_ADB) had no effect. ` +
          `Stop that daemon (codedroid-mcp stop --port=${port}) and let this client restart it.`,
      );
    }
    return;
  }

  log(`Daemon not running — starting it on port ${port}...`);
  const indexPath = fileURLToPath(new URL("./index.js", import.meta.url));
  // The child inherits this environment, but its adb setting comes from argv: this client's own
  // resolved choice (--adb, --no-adb or CODEDROID_MCP_ADB), so a flag reaches the daemon it starts
  // and an explicit --no-adb is not undone by an inherited CODEDROID_MCP_ADB=1.
  const adbArg = enableAdbTool ? "--adb" : "--no-adb";
  const child = spawn(process.execPath, [indexPath, "daemon", `--port=${port}`, adbArg], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    if (health) {
      assertAuthenticatedDaemon(health, port);
      log("Daemon is up.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Could not start the CodeDroid MCP daemon on port ${port} within 20s. ` +
      `Try running it manually to see why: codedroid-mcp daemon --port=${port}`,
  );
}

/**
 * Run the stdio shim until the IDE closes stdin or the daemon goes away.
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {(msg: string) => void} [options.log] stderr logger
 * @param {boolean} [options.enableAdbTool] Only used to warn when an already-
 *   running daemon can't honour the request — the shim never registers the
 *   tool itself, it forwards through to whichever daemon owns it.
 */
export async function runStdioShim({
  port = DEFAULT_PORT,
  log = () => {},
  enableAdbTool = false,
} = {}) {
  await ensureDaemonRunning(port, log, { enableAdbTool });

  const client = new Client({ name: "codedroid-mcp-shim", version: VERSION });
  // The daemon (ours or one ensureDaemonRunning just started) wrote its token; present it on /mcp.
  const httpTransport = daemonTransport(port, readDaemonToken());
  // Long initialize budget: the daemon may be doing the first phone connect
  // (including the on-phone approval tap) behind this call.
  await client.connect(httpTransport, { timeout: 150_000 });

  const server = await buildProxyServer({
    getClient: async () => client,
    name: "codedroid",
    version: VERSION,
  });

  // Pass phone/daemon notifications through to the IDE.
  client.fallbackNotificationHandler = async (notification) => {
    try {
      await server.notification(notification);
    } catch (e) {
      /* session closing — drop */
    }
  };

  client.onclose = () => {
    log("Daemon connection closed — exiting so the IDE can reconnect.");
    process.exit(1);
  };

  const stdioTransport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // IDE closed our stdin — release the daemon session and leave cleanly.
    client.onclose = undefined;
    try {
      await client.close();
    } catch (e) {
      /* already gone */
    }
    process.exit(0);
  };
  server.onclose = shutdown;
  // The SDK's stdio transport does not close itself at EOF. Without these hooks the
  // client eventually kills the shim and its daemon session is left behind.
  process.stdin.once("end", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await server.connect(stdioTransport);
  log(`Bridging stdio ↔ daemon on port ${port}.`);
}
