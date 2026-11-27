/**
 * screencast — a live view of a phone's screen, served by the daemon on loopback.
 *
 * The phone must be on this computer's adb (USB, Wireless debugging, an emulator). The daemon
 * pushes scrcpy-server (Apache-2.0, pinned in scrcpy-stream.js) to it, runs it with app_process
 * capturing the display into a hardware H.264 encoder, forwards a port to its socket and relays
 * the packets as they are to a page's WebSocket; the page decodes them with WebCodecs. Nothing is
 * decoded here, nothing queues behind the agent's calls, and the phone spends no screenshots.
 *
 *   ScrcpySource   one server on one phone: start, the packets, the last config and group of
 *                  pictures for a viewer joining late, stop.
 *   ScreencastHub  one source per phone, their viewers, the page and its WebSocket under
 *                  /cast/<token>/ on the daemon's HTTP server, the tool.
 *
 * Secure windows are black (shell cannot mirror them since Android 12), as in take_screenshot.
 */
import { execFile, spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { promisify } from "util";
import { WebSocketServer } from "ws";
import { adbLocations, modelMatches } from "./adb-tool.js";
import { describeHost, findHost } from "./host.js";
import { adbRunner } from "./phone-setup.js";
import { DEVICE_SCHEMA } from "./phones.js";
import {
  CODEC_H264,
  SCRCPY_SERVER_SHA256,
  SCRCPY_SERVER_URL,
  SCRCPY_VERSION,
  SERVER_DEVICE_PATH,
  ScrcpyStreamParser,
  framePacket,
  serverCommand,
  sessionPacket,
  socketName,
} from "./scrcpy-stream.js";
import { VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

export const DEFAULTS = { maxFps: 30, maxSize: 1280, bitRate: 4_000_000 };
const LIMITS = { maxFps: [1, 60], maxSize: [480, 2160] };
/** A cast nobody watches for this long stops: a page never opened, or closed. */
export const IDLE_MS = 2 * 60_000;
/** How long start() waits for the server's first frame; the encoder takes a few seconds. */
const START_TIMEOUT_MS = 25_000;
const CONNECT_RETRY_MS = 100;
const ADB_TIMEOUT_MS = 15_000;
/** Packets kept since the last key frame for a viewer joining late; past this, it waits for the next one. */
const GOP_MAX_BYTES = 8 * 1024 * 1024;
/** A viewer this far behind is skipped to the next key frame rather than fed stale frames. */
const VIEWER_BACKLOG_BYTES = 4 * 1024 * 1024;
const SERVER_LOG_LINES = 20;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message) => ({ ...text(message), isError: true });

/** The pinned scrcpy-server on this computer: ~/.codedroid/scrcpy-server-v<version>, downloaded once and checked by hash. */
export async function ensureScrcpyServer({ home = os.homedir(), env = process.env, download = fetch } = {}) {
  if (env.CODEDROID_SCRCPY_SERVER) return env.CODEDROID_SCRCPY_SERVER;
  const file = path.join(home, ".codedroid", `scrcpy-server-v${SCRCPY_VERSION}`);
  try {
    if (sha256(fs.readFileSync(file)) === SCRCPY_SERVER_SHA256) return file;
  } catch (e) {
    // Not there yet.
  }
  let response;
  try {
    response = await download(SCRCPY_SERVER_URL);
  } catch (e) {
    throw new Error(`Could not download scrcpy-server ${SCRCPY_VERSION} from ${SCRCPY_SERVER_URL}: ${e.message}. Put the file at ${file}, or name one with CODEDROID_SCRCPY_SERVER.`);
  }
  if (!response.ok) throw new Error(`Could not download scrcpy-server ${SCRCPY_VERSION} from ${SCRCPY_SERVER_URL} (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = sha256(bytes);
  if (got !== SCRCPY_SERVER_SHA256) throw new Error(`The scrcpy-server download does not match the pinned hash (got ${got}); not using it.`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

/** The first adb binary (adb-tool.js adbLocations) that runs; `adb` on PATH first. */
export async function findAdb(env = process.env, run = execFileAsync) {
  for (const file of adbLocations(env)) {
    try {
      await run(file, ["version"], { timeout: 5_000 });
      return file;
    } catch (e) {
      // Try the next.
    }
  }
  throw new Error("adb is not on this computer. Install Android platform-tools, or set ADB to its path.");
}

/** adb's `devices -l` as {serial, state, model}: columns parted by spaces, unlike the plain listing's tab. */
export function parseDevicesLong(output) {
  return [...String(output).matchAll(/^([^\s*]\S*)[ \t]+(\S+)([^\r\n]*)$/gm)]
    .filter((m) => m[1] !== "List")
    .map((m) => ({ serial: m[1], state: m[2], model: /\bmodel:(\S+)/.exec(m[3])?.[1] ?? null }));
}

/**
 * scrcpy-server on one phone, from push to stop.
 *
 * @param {object} options
 * @param {string} options.serial
 * @param {string} options.jar  the server on this computer (ensureScrcpyServer)
 * @param {(args: string[], opts?: object) => Promise<string>} options.adb  push, forward (phone-setup.js adbRunner)
 * @param {(serial: string, command: string) => import("child_process").ChildProcess} options.spawnShell  `adb -s <serial> shell <command>`, kept running
 * @param {(port: number) => net.Socket} [options.connect]
 * @param {(msg: string) => void} [options.log]
 */
export class ScrcpySource {
  constructor({ serial, jar, adb, spawnShell, connect = (port) => net.connect({ host: "127.0.0.1", port }), maxFps, maxSize, bitRate, log = () => {} }) {
    this.serial = serial;
    this.settings = { maxFps, maxSize, bitRate };
    this.name = null;
    this.width = null;
    this.height = null;
    this.frames = 0;
    this.bytes = 0;
    this.startedAt = null;
    /** Set by the hub: the stream ended, with why. */
    this.onclose = null;
    this._jar = jar;
    this._adb = adb;
    this._spawnShell = spawnShell;
    this._connect = connect;
    this._log = log;
    this._scid = randomBytes(4).toString("hex").replace(/^[89a-f]/, "7");
    this._port = null;
    this._child = null;
    this._socket = null;
    this._parser = new ScrcpyStreamParser();
    this._listeners = new Set();
    this._session = null;
    this._config = null;
    this._gop = [];
    this._gopBytes = 0;
    this._serverLog = [];
    this._closed = false;
    this._closeReason = null;
  }

  /** Lines the server wrote, newest last: what went wrong when it did. */
  get serverLog() {
    return this._serverLog.join("\n");
  }

  /** Resolves once the first frame arrived, so the caller can tell the viewer what it will see. */
  async start() {
    const started = new Promise((resolve, reject) => {
      this._firstFrame = { resolve, reject };
    });
    try {
      await this._adb(["push", this._jar, SERVER_DEVICE_PATH], { serial: this.serial, timeout: ADB_TIMEOUT_MS });
      const forwarded = await this._adb(["forward", "tcp:0", `localabstract:${socketName(this._scid)}`], { serial: this.serial, timeout: ADB_TIMEOUT_MS });
      const port = /^(\d+)\s*$/m.exec(forwarded)?.[1];
      if (!port) throw new Error(`adb could not forward a port to ${this.serial}: ${forwarded.trim() || "no answer"}`);
      this._port = Number(port);
      const child = this._spawnShell(this.serial, serverCommand({ scid: this._scid, ...this.settings }));
      this._child = child;
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk) => this._serverSaid(chunk));
      }
      child.on("error", (e) => this._close(`adb could not run scrcpy-server: ${e.message}`));
      child.on("exit", (code) => this._close(`scrcpy-server on ${this.serial} exited${code === null ? "" : ` (${code})`}.`));
      this._connectUntilAnswered(Date.now() + START_TIMEOUT_MS);
      const timer = setTimeout(() => this._close(`scrcpy-server on ${this.serial} sent no frame within ${START_TIMEOUT_MS / 1000} s.`), START_TIMEOUT_MS);
      try {
        await started;
      } finally {
        clearTimeout(timer);
      }
      this.startedAt = Date.now();
      this._log(`Screencast of ${this.serial}: ${this.name} ${this.width}x${this.height}, h264 up to ${this.settings.maxFps} fps`);
    } catch (e) {
      this._close(e.message);
      throw e;
    }
  }

  _serverSaid(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      this._serverLog.push(line.trim());
      if (this._serverLog.length > SERVER_LOG_LINES) this._serverLog.shift();
    }
  }

  /** In forward mode adb accepts before the server listens, then closes with nothing said: try again until a byte comes. */
  _connectUntilAnswered(deadline) {
    if (this._closed) return;
    const socket = this._connect(this._port);
    let answered = false;
    socket.on("data", (chunk) => {
      if (!answered) {
        answered = true;
        this._socket = socket;
      }
      this._receive(chunk);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (answered) return void this._close(this._closeReason ?? `The stream from ${this.serial} ended.`);
      if (Date.now() < deadline && !this._closed) setTimeout(() => this._connectUntilAnswered(deadline), CONNECT_RETRY_MS);
    });
  }

  _receive(chunk) {
    for (const event of this._parser.push(chunk)) {
      if (event.type === "device") this.name = event.name;
      else if (event.type === "codec") {
        if (event.id !== CODEC_H264) this._close(`scrcpy-server sent codec 0x${event.id.toString(16)}, not h264.`);
      } else if (event.type === "disabled") this._close(event.error ? `scrcpy-server could not start the encoder on ${this.serial}.` : "scrcpy-server sent no video.");
      else if (event.type === "session") {
        this.width = event.width;
        this.height = event.height;
        this._session = sessionPacket(event);
        this._config = null;
        this._gop = [];
        this._gopBytes = 0;
        this._emit(this._session, event);
      } else if (event.type === "packet") {
        const framed = framePacket(event);
        if (event.config) this._config = framed;
        else {
          this.frames++;
          this.bytes += event.data.length;
          if (event.keyFrame) {
            this._gop = [];
            this._gopBytes = 0;
          }
          if (this._gop.length || event.keyFrame) {
            this._gop.push(framed);
            this._gopBytes += framed.length;
            if (this._gopBytes > GOP_MAX_BYTES) {
              this._gop = [];
              this._gopBytes = 0;
            }
          }
          this._firstFrame?.resolve();
          this._firstFrame = null;
        }
        this._emit(framed, event);
      }
    }
  }

  _emit(framed, event) {
    for (const listener of this._listeners) listener(framed, event);
  }

  /**
   * [listener](framed, event) gets every packet from now on, after what it needs to decode the
   * next one: the display size, the codec config and the frames since the last key frame.
   * Returns the function that unsubscribes.
   */
  subscribe(listener) {
    if (this._session) listener(this._session, { type: "session" });
    if (this._config) listener(this._config, { type: "packet", config: true });
    for (const framed of this._gop) listener(framed, { type: "packet", keyFrame: framed === this._gop[0] });
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  get viewers() {
    return this._listeners.size;
  }

  stop(reason = "stopped") {
    this._close(reason);
  }

  _close(reason) {
    if (this._closed) return;
    this._closed = true;
    this._closeReason = reason;
    this._firstFrame?.reject(new Error(`${reason}${this._serverLog.length ? `\nscrcpy-server said:\n${this.serverLog}` : ""}`));
    this._firstFrame = null;
    this._socket?.destroy();
    this._child?.kill();
    if (this._port) this._adb(["forward", "--remove", `tcp:${this._port}`], { serial: this.serial, timeout: ADB_TIMEOUT_MS }).catch(() => {});
    this._listeners.clear();
    this.onclose?.(reason);
  }
}

/** A setting from the tool's arguments, within its limits, else the default. */
function setting(name, value) {
  const [min, max] = LIMITS[name];
  const number = Number(value);
  if (value === undefined || value === null || value === "") return DEFAULTS[name];
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name === "maxFps" ? "max_fps" : "max_size"} takes a whole number from ${min} to ${max}.`);
  return number;
}

function isLoopback(hostHeader) {
  const host = String(hostHeader ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function originAllowed(origin, hostHeader) {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return isLoopback(url.host) && url.host === String(hostHeader);
  } catch (e) {
    return false;
  }
}

/**
 * The daemon's screencasts: one per phone, shared by every viewer and every MCP client.
 *
 * @param {object} options
 * @param {import("./phones.js").Phones} options.phones  the pairings, to name a phone as other tools do
 * @param {(args: string[], opts?: object) => Promise<string>} [options.adb]
 * @param {(serial: string, command: string) => import("child_process").ChildProcess} [options.spawnShell]
 * @param {(port: number) => net.Socket} [options.connect]
 * @param {() => Promise<string>} [options.serverJar]  ensureScrcpyServer by default
 * @param {number} [options.idleMs]
 * @param {(msg: string) => void} [options.log]
 */
export class ScreencastHub {
  constructor({ phones, adb = adbRunner(), spawnShell, connect, serverJar, idleMs = IDLE_MS, env = process.env, log = () => {} }) {
    this._phones = phones;
    this._adb = adb;
    this._env = env;
    this._ownSpawn = !spawnShell;
    this._spawnShell = spawnShell ?? ((serial, command) => this._spawnAdbShell(serial, command));
    this._connect = connect;
    this._serverJar = serverJar ?? (() => ensureScrcpyServer({ env }));
    this._idleMs = idleMs;
    this._log = log;
    /** The daemon's address, set once it listens: http://127.0.0.1:<port> */
    this.baseUrl = null;
    /** serial → cast */
    this._casts = new Map();
    this._byToken = new Map();
    this._wss = new WebSocketServer({ noServer: true });
    this._adbBinary = null;
    this._closed = false;
  }

  _spawnAdbShell(serial, command) {
    const child = spawn(this._adbBinary, ["-s", serial, "shell", command], { stdio: ["ignore", "pipe", "pipe"] });
    return child;
  }

  /** The phone [selector] names, as an adb serial: an adb serial itself, a pairing's, a pairing matched by model, or an adb model. */
  async serialFor(selector) {
    const wanted = String(selector ?? "").trim();
    const attached = parseDevicesLong(await this._adb(["devices", "-l"], { timeout: ADB_TIMEOUT_MS })).filter((d) => d.state === "device");
    const list = attached.length ? attached.map((d) => `${d.serial}${d.model ? ` (${d.model})` : ""}`).join(", ") : "none";
    const own = attached.find((d) => d.serial === wanted);
    if (own) return { serial: own.serial, pairing: null, label: own.model ?? own.serial };
    const pairings = this._phones.sync().map((e) => e.pairing);
    let pairing;
    if (wanted) {
      try {
        pairing = findHost(pairings, wanted);
      } catch (e) {
        // Not a pairing: a device on adb named by its model, as adb lists it, such as an emulator with no CodeDroid.
        const byModel = attached.filter((d) => d.model?.toLowerCase().includes(wanted.toLowerCase()));
        if (byModel.length === 1) return { serial: byModel[0].serial, pairing: null, label: byModel[0].model };
        throw new Error(`${e.message} On adb: ${list}.`);
      }
    } else if (pairings.length === 1) pairing = pairings[0];
    else if (!pairings.length && attached.length === 1) return { serial: attached[0].serial, pairing: null, label: attached[0].model ?? attached[0].serial };
    else if (!pairings.length) throw new Error(`Name the phone with device: on adb are ${list}.`);
    else throw new Error(`${pairings.length} phones are paired; say which with device (an id, a model, or an adb serial): ${pairings.map(describeHost).join(", ")}.`);
    if (pairing.serial && attached.some((d) => d.serial === pairing.serial)) return { serial: pairing.serial, pairing, label: describeHost(pairing) };
    const matches = attached.filter((d) => d.model && pairing.device?.model && modelMatches(pairing.device.model, d.model));
    if (matches.length === 1) return { serial: matches[0].serial, pairing, label: describeHost(pairing) };
    if (matches.length > 1) throw new Error(`Several devices on adb are ${pairing.device.model}; pass its adb serial as device: ${list}.`);
    throw new Error(
      `${describeHost(pairing)} is not on this computer's adb (on adb: ${list}). The screencast runs over adb: connect the phone with USB debugging or Wireless debugging, then try again.`,
    );
  }

  /** Starts a cast of the phone, or returns the one running: {url, serial, label, name, width, height, settings, reused}. */
  async start({ device, max_fps, max_size } = {}) {
    if (this._closed) throw new Error("The daemon is shutting down.");
    if (!this.baseUrl) throw new Error("The daemon is not listening yet.");
    const settings = { maxFps: setting("maxFps", max_fps), maxSize: setting("maxSize", max_size), bitRate: DEFAULTS.bitRate };
    const target = await this.serialFor(device);
    const running = this._casts.get(target.serial);
    if (running) {
      this._touch(running);
      return this._describe(running, true);
    }
    if (this._ownSpawn) this._adbBinary ??= await findAdb(this._env);
    const jar = await this._serverJar();
    const source = new ScrcpySource({ ...target, jar, adb: this._adb, spawnShell: this._spawnShell, connect: this._connect, ...settings, log: this._log });
    const cast = { token: randomBytes(16).toString("hex"), serial: target.serial, label: target.label, source, viewers: new Set(), idleTimer: null };
    this._casts.set(target.serial, cast);
    this._byToken.set(cast.token, cast);
    source.onclose = (reason) => {
      this._log(`Screencast of ${target.serial} ended: ${reason}`);
      this._forget(cast);
    };
    try {
      await source.start();
    } catch (e) {
      this._forget(cast);
      throw e;
    }
    this._touch(cast);
    return this._describe(cast, false);
  }

  _describe(cast, reused) {
    const { source } = cast;
    return {
      url: `${this.baseUrl}/cast/${cast.token}/`,
      serial: cast.serial,
      label: cast.label,
      name: source.name,
      width: source.width,
      height: source.height,
      settings: source.settings,
      viewers: cast.viewers.size,
      frames: source.frames,
      bytes: source.bytes,
      startedAt: source.startedAt,
      reused,
    };
  }

  /** Every running cast. */
  status() {
    return [...this._casts.values()].map((cast) => this._describe(cast, true));
  }

  /** Stops the cast of the phone [device] names (every cast with none); resolves how many stopped. */
  async stop({ device } = {}) {
    let casts;
    if (device === undefined || device === null || device === "") casts = [...this._casts.values()];
    else {
      let serial;
      try {
        serial = (await this.serialFor(device)).serial;
      } catch (e) {
        serial = String(device).trim();
      }
      casts = [this._casts.get(serial)].filter(Boolean);
    }
    for (const cast of casts) cast.source.stop("stopped");
    return casts.length;
  }

  _forget(cast) {
    clearTimeout(cast.idleTimer);
    if (this._casts.get(cast.serial) === cast) this._casts.delete(cast.serial);
    this._byToken.delete(cast.token);
    for (const ws of cast.viewers) ws.close(1001, "the screencast ended");
    cast.viewers.clear();
  }

  /** A start or a viewer: the idle clock starts again, and stops while someone watches. */
  _touch(cast) {
    clearTimeout(cast.idleTimer);
    cast.idleTimer = null;
    if (cast.viewers.size) return;
    cast.idleTimer = setTimeout(() => {
      if (!cast.viewers.size) cast.source.stop(`nobody watched for ${Math.round(this._idleMs / 1000)} s`);
    }, this._idleMs);
    cast.idleTimer.unref?.();
  }

  _castFor(req, url) {
    if (!isLoopback(req.headers.host) || !originAllowed(req.headers.origin, req.headers.host)) return { status: 403 };
    const match = /^\/cast\/([0-9a-f]{32})\/(ws)?$/.exec(url.pathname);
    if (!match) return { status: 404 };
    const cast = this._byToken.get(match[1]);
    return cast ? { cast, ws: match[2] === "ws" } : { status: 404 };
  }

  /** Serves /cast/<token>/ (the page); true when the request was one of this hub's. */
  handleRequest(req, res, url) {
    if (!url.pathname.startsWith("/cast/")) return false;
    const { status, cast, ws } = this._castFor(req, url);
    if (status) {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(status === 403 ? "localhost only" : "no such screencast; start one with the screencast tool");
      return true;
    }
    if (ws) {
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8" }).end("WebSocket only");
      return true;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return true;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(cast));
    return true;
  }

  /** The page's WebSocket at /cast/<token>/ws; true when the upgrade was one of this hub's. */
  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    if (!url.pathname.startsWith("/cast/")) return false;
    const { status, cast, ws } = this._castFor(req, url);
    if (status || !ws) {
      socket.write(`HTTP/1.1 ${status ?? 404} ${status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return true;
    }
    this._wss.handleUpgrade(req, socket, head, (client) => this._attach(cast, client));
    return true;
  }

  _attach(cast, ws) {
    const { source } = cast;
    cast.viewers.add(ws);
    this._touch(cast);
    ws.send(JSON.stringify({ type: "hello", mode: "h264", label: cast.label, name: source.name, width: source.width, height: source.height, settings: source.settings, bridge: VERSION }));
    let waitingForKey = false;
    const unsubscribe = source.subscribe((framed, event) => {
      if (ws.readyState !== ws.OPEN) return;
      const resync = event.type === "session" || event.config;
      if (!resync && ws.bufferedAmount > VIEWER_BACKLOG_BYTES) waitingForKey = true;
      if (waitingForKey && !resync && !event.keyFrame) return;
      waitingForKey = false;
      ws.send(framed, { binary: true });
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      unsubscribe();
      cast.viewers.delete(ws);
      if (this._casts.get(cast.serial) === cast) this._touch(cast);
    });
  }

  async close() {
    this._closed = true;
    for (const cast of [...this._casts.values()]) cast.source.stop("the daemon is shutting down");
    await new Promise((resolve) => this._wss.close(resolve));
  }
}

function page(cast) {
  return `<!doctype html>
<meta charset="utf-8">
<title>CodeDroid screencast</title>
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; background: #111; color: #ddd; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px; }
  canvas { max-height: 88vh; max-width: 95vw; border-radius: 12px; background: #000; }
  #status { color: #999; min-height: 1.2em; }
</style>
<canvas id="screen" width="2" height="2"></canvas>
<div id="status">Connecting</div>
<script>
  const canvas = document.getElementById("screen");
  const status = document.getElementById("status");
  const context = canvas.getContext("2d");
  const label = ${JSON.stringify(cast.label)};
  let decoder = null;
  let config = null;
  let haveKey = false;
  let frames = 0;
  let shown = 0;
  let lastTick = performance.now();
  const say = (message) => { status.textContent = message; };
  if (typeof VideoDecoder === "undefined") {
    say("This browser has no WebCodecs: open the page in Chrome, Edge, Safari 16.4+ or Firefox 130+.");
  }
  function avcCodecString(bytes) {
    let start = 0;
    while (start < bytes.length && bytes[start] === 0) start++;
    if (start > 0 && bytes[start] === 1) start++; else start = 0;
    const hex = (byte) => byte.toString(16).padStart(2, "0");
    return "avc1." + hex(bytes[start + 1]) + hex(bytes[start + 2]) + hex(bytes[start + 3]);
  }
  function resetDecoder(codec) {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        context.drawImage(frame, 0, 0);
        frame.close();
        shown++;
      },
      error: (e) => { say("Decoder error: " + e.message); haveKey = false; },
    });
    decoder.configure({ codec, optimizeForLatency: true });
    haveKey = false;
  }
  function onPacket(buffer) {
    const view = new DataView(buffer);
    const high = view.getUint32(0);
    if (high & 0x80000000) {
      canvas.width = view.getUint32(4);
      canvas.height = view.getUint32(8);
      return;
    }
    const data = new Uint8Array(buffer, 12);
    const isConfig = !!(high & 0x40000000);
    const isKey = !!(high & 0x20000000);
    const pts = (high & 0x1fffffff) * 4294967296 + view.getUint32(4);
    if (isConfig) {
      config = data;
      if (typeof VideoDecoder !== "undefined") resetDecoder(avcCodecString(data));
      return;
    }
    if (!decoder || decoder.state !== "configured") return;
    if (!haveKey) {
      if (!isKey || !config) return;
      haveKey = true;
    }
    let chunkData = data;
    if (isKey && config) {
      chunkData = new Uint8Array(config.length + data.length);
      chunkData.set(config, 0);
      chunkData.set(data, config.length);
    }
    decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: pts, data: chunkData }));
    frames++;
  }
  function connect() {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + location.pathname + "ws");
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const hello = JSON.parse(event.data);
        document.title = "CodeDroid screencast: " + (hello.label || hello.name || "");
        say("Live: " + (hello.label || hello.name) + ", " + hello.width + "x" + hello.height);
        return;
      }
      onPacket(event.data);
    };
    ws.onclose = (event) => say(event.reason || "The screencast ended. Start it again with the screencast tool, then reload.");
    ws.onerror = () => say("Could not reach the daemon.");
  }
  setInterval(() => {
    const now = performance.now();
    const fps = Math.round(shown / ((now - lastTick) / 1000));
    lastTick = now;
    shown = 0;
    if (frames) say("Live: " + label + ", " + canvas.width + "x" + canvas.height + ", " + fps + " fps");
  }, 1000);
  connect();
</script>
`;
}

const DESCRIPTION = `
Stream the phone's screen live to a page on this computer, for the person to watch while you work: hardware H.264 video at up to 30 fps over adb, so it costs the phone no screenshots and never waits behind your calls. Tell the user the URL the reply gives.

action: start (default) begins a cast, or returns the running one's URL; stop ends it; status says what runs, with viewers and frames. device names the phone as other tools do, or by its adb serial. max_fps (${LIMITS.maxFps.join("-")}, default ${DEFAULTS.maxFps}) and max_size (longest edge in px, ${LIMITS.maxSize.join("-")}, default ${DEFAULTS.maxSize}) apply to a new cast.

Needs the phone on this computer's adb (USB debugging, Wireless debugging or an emulator), like the adb tool. The first start downloads scrcpy-server (Apache-2.0, ${SCRCPY_VERSION}) once. Secure windows (banking apps) show black. A cast nobody watches for ${IDLE_MS / 60_000} minutes stops by itself. It is a view for people: keep reading the screen with get_screen.
`.trim();

/** @param {ScreencastHub} hub */
export function createScreencastTool(hub) {
  return {
    definition: {
      name: "screencast",
      title: "Live view of the phone",
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "stop", "status"], description: "start (default), stop, or status" },
          device: DEVICE_SCHEMA,
          max_fps: { type: "integer", minimum: LIMITS.maxFps[0], maximum: LIMITS.maxFps[1], description: `Frame rate cap for a new cast (default ${DEFAULTS.maxFps})` },
          max_size: { type: "integer", minimum: LIMITS.maxSize[0], maximum: LIMITS.maxSize[1], description: `Longest edge in pixels for a new cast (default ${DEFAULTS.maxSize})` },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async handler(args = {}) {
      const action = args.action ?? "start";
      try {
        if (action === "status") {
          const casts = hub.status();
          return text(casts.length ? { casts } : "No screencast is running.");
        }
        if (action === "stop") {
          const stopped = await hub.stop(args);
          return text(stopped ? `Stopped ${stopped === 1 ? "the screencast" : `${stopped} screencasts`}.` : "No screencast was running.");
        }
        if (action !== "start") return failure(`action is start, stop or status, not "${action}".`);
        const cast = await hub.start(args);
        return text(
          `${cast.reused ? "Already streaming" : "Streaming"} ${cast.label} (${cast.name}, ${cast.width}x${cast.height}, h264 up to ${cast.settings.maxFps} fps) at\n${cast.url}\n` +
            `Open it in Chrome, Edge, Safari or Firefox on this computer. It stops after ${IDLE_MS / 60_000} minutes with nobody watching, or with action "stop".`,
        );
      } catch (e) {
        return failure(e.message);
      }
    },
  };
}
