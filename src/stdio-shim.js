/**
 * stdio-shim — the `codedroid-mcp` stdio entry point MCP clients launch. It
 * proxies to the shared local daemon, auto-starting it when needed, so every
 * client on this computer shares one connection to the phone.
 *
 *   IDE ── stdio ── this shim ── HTTP ── daemon ── relay ── CodeDroid on the phone
 *
 * Any number of shims (one per IDE/window) share the daemon's phone connections. A daemon that
 * restarts (an upgrade, `stop`, a crash) costs a shim its session, not its IDE: the next request
 * opens a new one, starting the daemon again if it is gone.
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

/**
 * Stops a running daemon and waits until it is gone. Resolves {status, port, pid}, status being
 * "stopped"; "none" when no daemon was running; "refused" when it rejected this user's token; or
 * "stuck" when it accepted but is still up 5 s later.
 */
export async function stopDaemon(port = DEFAULT_PORT) {
  const health = await fetchHealth(port);
  if (!health) return { status: "none", port };
  const shutdown = (token) => fetch(`http://127.0.0.1:${port}/shutdown`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => null);
  // Legacy daemons need no token, including when the new credential file is invalid. Earlier
  // token-enabled daemons lacked the capability marker; retry those with a token after a 401.
  const authenticated = health.authentication === DAEMON_AUTHENTICATION;
  let res = await shutdown(authenticated ? readDaemonToken() : null);
  if (!authenticated && res?.status === 401) {
    await res.arrayBuffer();
    const token = readDaemonToken();
    if (token) res = await shutdown(token);
  }
  if (res?.status === 401) return { status: "refused", port, pid: health.pid };
  for (let i = 0; i < 50 && (await fetchHealth(port)); i++) await new Promise((r) => setTimeout(r, 100));
  return { status: (await fetchHealth(port)) ? "stuck" : "stopped", port, pid: health.pid };
}

/** Why a daemon did not stop, and what to do about it. */
export function notStopped({ status, port, pid }) {
  const daemon = `The CodeDroid daemon on port ${port}${pid ? ` (pid ${pid})` : ""}`;
  return status === "refused"
    ? `${daemon} refused to stop: it does not accept the token in ~/.codedroid/daemon-token. End that process to stop it.`
    : `${daemon} did not exit within 5 s. End that process to stop it.`;
}

export async function ensureDaemonRunning(port, log, { enableAdbTool = true } = {}) {
  const existing = await fetchHealth(port);
  if (existing) {
    assertAuthenticatedDaemon(existing, port);
    if (existing.adbPerClient) {
      if (enableAdbTool && !existing.adbToolEnabled) {
        log(`The daemon on port ${port} was started with the adb tool off. Stop it (codedroid-mcp stop --port=${port}) and let this client restart it.`);
      }
      return;
    }
    // An older daemon fixes adb for every client and runs it from the wrong directory. Clients of
    // it lose their session, not their IDE: the next request opens a new one on this daemon.
    log(`Replacing the older daemon (v${existing.version}) on port ${port}.`);
    const stopped = await stopDaemon(port);
    if (stopped.status === "refused" || stopped.status === "stuck") {
      log(notStopped(stopped));
      return;
    }
  }

  log(`Daemon not running — starting it on port ${port}...`);
  const indexPath = fileURLToPath(new URL("./index.js", import.meta.url));
  // --adb because the daemon serves every client: this client's own choice goes with its session,
  // and an inherited CODEDROID_MCP_ADB=0 must not take adb from the others.
  const child = spawn(process.execPath, [indexPath, "daemon", `--port=${port}`, "--adb"], {
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
 * The request never reached a daemon session: the daemon no longer has it (404, or 400 from an older
 * daemon) or nothing listens on the port. Safe to send again, even a tap.
 */
export function isLostDaemonSession(e) {
  return (
    e?.code === 404 ||
    /unknown session|no valid session|session not found/i.test(e?.message ?? "") ||
    e?.cause?.code === "ECONNREFUSED"
  );
}

/**
 * Run the stdio shim until the IDE closes stdin.
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {(msg: string) => void} [options.log] stderr logger
 * @param {boolean} [options.enableAdbTool] Whether this client's session gets adb.
 *   The shim never registers the tool itself: it forwards through to the daemon.
 */
export async function runStdioShim({
  port = DEFAULT_PORT,
  log = () => {},
  enableAdbTool = true,
} = {}) {
  let server;
  const connectDaemon = async () => {
    await ensureDaemonRunning(port, log, { enableAdbTool });
    const next = new Client({ name: "codedroid-mcp-shim", version: VERSION });
    // Pass phone/daemon notifications through to the IDE.
    next.fallbackNotificationHandler = async (notification) => {
      try {
        await server?.notification(notification);
      } catch (e) {
        /* session closing — drop */
      }
    };
    // The daemon (ours or one ensureDaemonRunning just started) wrote its token; present it on /mcp.
    // Long initialize budget: the daemon may be doing the first phone connect
    // (including the on-phone approval tap) behind this call.
    await next.connect(daemonTransport(port, readDaemonToken(), { enableAdbTool }), { timeout: 150_000 });
    return next;
  };

  let client = await connectDaemon();
  let reconnecting = null;
  /** The daemon session as proxy-core sees it: one that ends is replaced, and the request sent again. */
  const daemon = {
    getServerCapabilities: () => client.getServerCapabilities(),
    getInstructions: () => client.getInstructions(),
    async request(...args) {
      const used = client;
      try {
        return await used.request(...args);
      } catch (e) {
        // A client without a transport is closed: the request never left, so it is safe to send again.
        if (used.transport && !isLostDaemonSession(e)) throw e;
        if (client === used && !reconnecting) {
          reconnecting = (async () => {
            log(`Daemon session lost (${e.message}) — opening a new one.`);
            // Replaced only once a new session opens, so a failed attempt leaves the next request to try again.
            client = await connectDaemon();
            used.close().catch(() => {});
          })().finally(() => {
            reconnecting = null;
          });
        }
        await reconnecting;
        return client.request(...args);
      }
    },
  };

  server = await buildProxyServer({
    getClient: async () => daemon,
    name: "codedroid",
    version: VERSION,
  });

  const stdioTransport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // IDE closed our stdin — release the daemon session and leave cleanly.
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
