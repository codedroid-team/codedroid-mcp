/**
 * daemon — ONE process on this computer that owns the single link to
 * CodeDroid on the phone (through the CodeDroid server's relay) and serves MCP over
 * Streamable HTTP on localhost.
 *
 * The phone connection uses a WebSocket relay. /mcp requires a per-daemon bearer token, and the
 * host-side adb tool is opt-in.
 *
 * Every MCP client (Claude Code, Claude Desktop, Cursor, VS Code windows…)
 * connects to http://127.0.0.1:<port>/mcp and gets its own MCP session; tool
 * calls are serialized onto the one phone connection. This replaces the old
 * model where each client spawned its own bridge and stole the phone from the
 * previous one ("newest wins" tug-of-war).
 *
 * Endpoints:
 *   POST/GET/DELETE /mcp   Streamable HTTP MCP (per-session) — needs the per-daemon bearer token
 *   POST /shutdown         stop the daemon — needs the token
 *   GET /health            {ok, version, phone, error, sessions, adbToolEnabled} — unauthenticated
 */
import http from "http";
import os from "os";
import { randomUUID, randomBytes, timingSafeEqual } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { adbTool } from "./adb-tool.js";
import { buildProxyServer, broadcastNotification } from "./proxy-core.js";
import { RelayPhoneTransport } from "./relay-transport.js";
import { createStatusTool } from "./status-tool.js";
import { clearDaemonToken, writeDaemonToken } from "./host.js";
import { VERSION } from "./version.js";

export const DEFAULT_PORT = 4826;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** How long a link stays trusted after its last proven round-trip. Past
 *  this, getClient() pings before reuse (a phone app restart kills the link
 *  without any close event — see 2026-07-16 stale-connection incident). */
const LIVENESS_MAX_AGE_MS = 20_000;
const PING_TIMEOUT_MS = 5_000;
/**
 * How long a new session waits for the phone before opening without it (see proxy-core). A phone
 * that already allowed this computer connects in about a second; Codex gives a server 10 s to start.
 */
const CONNECT_WAIT_MS = 5_000;
/** In a session that opened without the phone, how long tools/list waits for it: a ping's worth. */
const LIST_WAIT_MS = 2_000;

/** Owns the single connection to the phone: single-flight connect, exclusive
 *  tool-call queue, reconnect-on-demand after a drop. */
export class PhoneManager {
  constructor({
    transportFactory,
    log = () => {},
    livenessMaxAgeMs = LIVENESS_MAX_AGE_MS,
    pingTimeoutMs = PING_TIMEOUT_MS,
  } = {}) {
    this._transportFactory =
      transportFactory ?? (() => new RelayPhoneTransport({ log }));
    this._log = log;
    this._livenessMaxAgeMs = livenessMaxAgeMs;
    this._pingTimeoutMs = pingTimeoutMs;
    this._client = null;
    this._connectPromise = null;
    this._queueTail = Promise.resolve();
    this._closed = false;
    this._lastAliveAt = 0;
    this.state = "disconnected";
    /** Why the last connect failed, in words for the user; null once connected. */
    this.lastError = null;
    /** {id, model, server} of the phone, once connected. */
    this.device = null;
    /** Set by the daemon to fan phone notifications out to sessions. */
    this.onNotification = null;
    /** Set by the daemon: the phone (re)connected, so its tools may be new to a session. */
    this.onConnected = null;
  }

  async getClient() {
    if (this._closed) throw new Error("Daemon is shutting down");
    if (this._client) {
      // A phone app restart or network flip can kill the link without any
      // close event — the cached client then looks healthy while every
      // forwarded request hangs. Verify liveness with a cheap MCP ping
      // when the link hasn't been proven alive recently.
      if (Date.now() - this._lastAliveAt <= this._livenessMaxAgeMs) return this._client;
      try {
        await this._client.ping({ timeout: this._pingTimeoutMs });
        this._lastAliveAt = Date.now();
        return this._client;
      } catch (e) {
        this._log("Cached phone connection is dead (ping failed) — reconnecting");
        const dead = this._client;
        this._client = null;
        this.state = "disconnected";
        try {
          await dead.close();
        } catch (closeErr) {
          /* it's already gone */
        }
      }
    }
    if (!this._connectPromise) {
      this._connectPromise = this._connect().finally(() => {
        this._connectPromise = null;
      });
    }
    return this._connectPromise;
  }

  /** Every successful round-trip proves the link — cheaper than extra pings. */
  markAlive() {
    this._lastAliveAt = Date.now();
  }

  async _connect() {
    this.state = "connecting";
    this._log("Connecting to phone...");
    let transport;
    try {
      transport = await this._transportFactory();
    } catch (e) {
      this.state = "disconnected";
      this.lastError = e.message;
      throw e;
    }
    const client = new Client({ name: "codedroid-mcp-daemon", version: VERSION });
    client.fallbackNotificationHandler = async (notification) => {
      await this.onNotification?.(notification);
    };
    try {
      // Generous initialize budget: the very first connect can include a
      // human tapping Approve on the phone.
      await client.connect(transport, { timeout: 130_000 });
    } catch (e) {
      this.state = "disconnected";
      this.lastError = e.message;
      throw e;
    }
    client.onclose = () => {
      if (this._client === client) {
        this._client = null;
        this.state = "disconnected";
        this._log("Phone connection closed — will reconnect on next request");
      }
    };
    this._client = client;
    this._lastAliveAt = Date.now();
    this.state = "connected";
    this.lastError = null;
    this.device = transport.device ?? null;
    this._log("Phone connected");
    this.onConnected?.();
    return client;
  }

  /** Serialize work against the single physical screen. */
  runExclusive(fn) {
    const run = this._queueTail.then(fn, fn);
    // Keep the chain alive whether fn resolved or rejected.
    this._queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close() {
    this._closed = true;
    const client = this._client;
    this._client = null;
    this.state = "disconnected";
    if (client) {
      try {
        await client.close();
      } catch (e) {
        /* already gone */
      }
    }
  }
}

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  // Strip port; tolerate IPv6 brackets.
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isAllowedOrigin(origin) {
  if (origin === undefined || origin === "null") return true; // non-browser clients
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.host);
  } catch (e) {
    return false;
  }
}

/** The bearer token on a request, or null. `Authorization: Bearer <token>`. */
function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? "").trim());
  return match ? match[1] : null;
}

/** Whether [req] carries the daemon's token. Constant-time, so a wrong guess leaks no timing. */
function hasValidToken(req, token) {
  const got = bearerToken(req);
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res, status, id, code, message) {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: id ?? null,
  });
}

/**
 * Start the daemon.
 *
 * @param {object} [options]
 * @param {number} [options.port]   0 = ephemeral (tests)
 * @param {string} [options.host]
 * @param {() => Promise<import("@modelcontextprotocol/sdk/shared/transport.js").Transport> | import("@modelcontextprotocol/sdk/shared/transport.js").Transport} [options.phoneTransportFactory]
 * @param {(msg: string) => void} [options.log]
 * @param {boolean} [options.enableAdbTool]  Serve the host-side `adb` tool. OFF by
 *   default: it runs commands on this computer, so it is opt-in. CODEDROID_MCP_ADB=1
 *   or --adb turns it on (index.js).
 * @param {string} [options.home]  Where ~/.codedroid lives; overridable for tests.
 * @param {string} [options.authToken]  The bearer token /mcp and /shutdown require;
 *   generated and written to ~/.codedroid/daemon-token when omitted.
 * @returns {Promise<{port: number, authToken: string, close: () => Promise<void>, phoneManager: PhoneManager}>}
 */
export async function startDaemon({
  port = DEFAULT_PORT,
  host = "127.0.0.1",
  phoneTransportFactory,
  log = () => {},
  enableAdbTool = false,
  home = os.homedir(),
  authToken = randomBytes(32).toString("hex"),
} = {}) {
  const phoneManager = new PhoneManager({
    transportFactory: phoneTransportFactory,
    log,
  });
  /** sessionId → { transport, server } */
  const sessions = new Map();

  phoneManager.onNotification = (notification) =>
    broadcastNotification(
      [...sessions.values()].map((s) => s.server),
      notification,
    );
  phoneManager.onConnected = () =>
    broadcastNotification(
      [...sessions.values()].map((s) => s.server),
      { method: "notifications/tools/list_changed" },
    );

  const httpServer = http.createServer(async (req, res) => {
    try {
      // Local-only surface: reject DNS-rebinding / cross-origin browser abuse.
      if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: "Forbidden: localhost access only" });
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);

      // /health stays unauthenticated so a client can discover a running daemon before it has the
      // token. It carries no phone identifiers (id/model/server) — a reachable-but-unauthorized
      // caller learns only that a daemon is here and whether adb is on.
      if (url.pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          service: "codedroid-mcp-daemon",
          version: VERSION,
          phone: phoneManager.state,
          error: phoneManager.lastError,
          sessions: sessions.size,
          adbToolEnabled: enableAdbTool,
        });
        return;
      }

      // Everything past here drives the phone or the host adb tool: it needs the per-daemon token.
      if (!hasValidToken(req, authToken)) {
        sendJson(res, 401, { error: "Unauthorized: missing or invalid bearer token" });
        return;
      }

      if (url.pathname === "/shutdown" && req.method === "POST") {
        sendJson(res, 200, { ok: true });
        setImmediate(async () => {
          await close();
          process.exit(0);
        });
        return;
      }

      if (url.pathname !== "/mcp") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const sessionId = req.headers["mcp-session-id"];

      if (req.method === "POST") {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          jsonRpcError(res, 400, null, -32700, e.message);
          return;
        }

        // Existing session → route to its transport.
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId).transport.handleRequest(req, res, body);
          return;
        }

        // New session — must be an initialize request.
        if (!sessionId && isInitializeRequest(body)) {
          let server;
          try {
            server = await buildProxyServer({
              getClient: () => phoneManager.getClient(),
              runExclusive: (fn) => phoneManager.runExclusive(fn),
              onBackendAlive: () => phoneManager.markAlive(),
              name: "codedroid (via daemon)",
              version: VERSION,
              // Executes on THIS machine (wherever the daemon runs), not the
              // phone — see adb-tool.js. The stdio shim builds its own proxy
              // server without these, so it transparently forwards their
              // calls to here rather than double-registering them.
              localTools: [createStatusTool(phoneManager), ...(enableAdbTool ? [adbTool] : [])],
              connectWaitMs: CONNECT_WAIT_MS,
              listWaitMs: LIST_WAIT_MS,
            });
          } catch (e) {
            log(`Session init failed: ${e.message}`);
            jsonRpcError(res, 503, body.id, -32001, e.message);
            return;
          }

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { transport, server });
              log(`Session ${id.slice(0, 8)}… opened (${sessions.size} active)`);
            },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id && sessions.delete(id)) {
              log(`Session ${id.slice(0, 8)}… closed (${sessions.size} active)`);
            }
          };

          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        jsonRpcError(
          res,
          400,
          body?.id,
          -32000,
          "Bad Request: unknown session (send initialize without mcp-session-id to start one)",
        );
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !sessions.has(sessionId)) {
          jsonRpcError(res, 400, null, -32000, "Bad Request: no valid session");
          return;
        }
        await sessions.get(sessionId).transport.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, { error: "Method not allowed" });
    } catch (e) {
      log(`HTTP handler error: ${e.stack || e.message}`);
      if (!res.headersSent) {
        jsonRpcError(res, 500, null, -32603, `Internal error: ${e.message}`);
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const boundPort = httpServer.address().port;
  // Write the token only now the port is ours, in the same synchronous turn as listen resolving —
  // so a concurrent starter that lost the bind (EADDRINUSE above) never clobbered this file, and no
  // request can be handled before the token exists. One token file per computer, like host.json:
  // a daemon on a second --port would overwrite it, matching the one-daemon-per-computer model.
  writeDaemonToken(authToken, { home });
  log(`CodeDroid MCP daemon listening on http://${host}:${boundPort}/mcp`);
  if (enableAdbTool) log("The adb tool is on: connected MCP clients can run adb commands on this machine.");
  else log("The adb tool is off (opt in with CODEDROID_MCP_ADB=1 or --adb).");

  const close = async () => {
    for (const { transport } of sessions.values()) {
      try {
        await transport.close();
      } catch (e) {
        /* best-effort */
      }
    }
    sessions.clear();
    await phoneManager.close();
    clearDaemonToken({ home });
    await new Promise((resolve) => httpServer.close(resolve));
  };

  return { port: boundPort, authToken, close, phoneManager };
}
