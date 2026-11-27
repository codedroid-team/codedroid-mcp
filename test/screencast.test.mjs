/**
 * The screencast (screencast.js) against a fake adb and a fake scrcpy-server: the phone is named
 * as other tools name it or by its adb serial, the server is pushed, forwarded to and run, its
 * stream reaches the page's WebSocket as it is, a viewer joining late gets what it needs to decode
 * first, the tool's three actions, what the page refuses, and that stopping cleans up.
 *
 * Run: node test/screencast.test.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import WebSocket from "ws";
import { ScreencastHub, createScreencastTool, parseDevicesLong } from "../src/screencast.js";
import { CODEC_H264, framePacket, sessionPacket } from "../src/scrcpy-stream.js";

// ---------------------------------------------------------------- a fake phone with scrcpy-server

const CONFIG = Buffer.from("0000000167 42c01e 0000000168ce3c80".replace(/ /g, ""), "hex");
const KEY = Buffer.concat([Buffer.from("0000000165b8", "hex"), Buffer.alloc(200, 1)]);
const DELTA = Buffer.concat([Buffer.from("0000000161e0", "hex"), Buffer.alloc(20, 2)]);
const kind = (buffer) => {
  const high = buffer.readUInt32BE(0);
  return high & 0x80000000 ? "session" : high & 0x40000000 ? "config" : high & 0x20000000 ? "key" : "delta";
};

/** scrcpy-server's socket: listens once the "process" runs; writes the handshake and the first frames, then what the test says. */
class FakeServer {
  constructor() {
    this.listening = null;
    this.sockets = [];
    this.pts = 1_000_000;
  }

  async listen() {
    this.listening = net.createServer((socket) => {
      this.sockets.push(socket);
      const name = Buffer.alloc(64);
      name.write("sdk_gphone64_arm64");
      const codec = Buffer.alloc(4);
      codec.writeUInt32BE(CODEC_H264);
      socket.write(Buffer.concat([Buffer.from([0]), name, codec, sessionPacket({ width: 576, height: 1280 }), framePacket({ config: true, keyFrame: false, pts: 0, data: CONFIG })]));
      socket.write(this.frame(true));
    });
    await new Promise((resolve) => this.listening.listen(0, "127.0.0.1", resolve));
    return this.listening.address().port;
  }

  frame(keyFrame) {
    this.pts += 33_333;
    return framePacket({ config: false, keyFrame, pts: this.pts, data: keyFrame ? KEY : DELTA });
  }

  send(buffer) {
    for (const socket of this.sockets) socket.write(buffer);
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.listening?.close(resolve));
  }
}

const adbCalls = [];
const children = [];
const servers = new Map();
const allServers = [];
/** adb as phone-setup.js adbRunner gives it: args to output. `forward` opens a real port, as adb does, where the fake server will listen. */
const adb = async (args, { serial } = {}) => {
  adbCalls.push({ serial, args });
  if (args[0] === "devices") {
    return "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\nR5CT1          device usb:1-1 product:e1q model:SM_S921U device:e1q transport_id:2\n";
  }
  if (args[0] === "push") return "1 file pushed";
  if (args[0] === "forward" && args[1] === "tcp:0") {
    const server = new FakeServer();
    servers.set(serial, server);
    allServers.push(server);
    return `${await server.listen()}\n`;
  }
  if (args[0] === "forward" && args[1] === "--remove") return "";
  throw new Error(`unexpected adb ${args.join(" ")}`);
};
/** `adb shell app_process ...` as a process the hub holds; killing it ends the fake server, as cleanup=true does. */
const spawnShell = (serial, command) => {
  const child = new EventEmitter();
  child.serial = serial;
  child.command = command;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    servers.get(serial)?.close();
    setImmediate(() => child.emit("exit", null));
  };
  children.push(child);
  return child;
};

const pairings = [
  { server: "https://s", host_id: "h1", token: "t1", device: { id: "dev-pixel", model: "Pixel 9" } },
  { server: "https://s", host_id: "h2", token: "t2", device: { id: "dev-s24", model: "Samsung SM-S921U" } },
];
const phones = { sync: () => pairings.map((pairing) => ({ pairing })) };

const hub = new ScreencastHub({ phones, adb, spawnShell, serverJar: async () => "/fake/scrcpy-server", idleMs: 300 });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!hub.handleRequest(req, res, url)) res.writeHead(404).end();
});
server.on("upgrade", (req, socket, head) => {
  if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
hub.baseUrl = `http://127.0.0.1:${port}`;
const tool = createScreencastTool(hub);

const packetsOf = (ws, count) =>
  new Promise((resolve) => {
    const got = [];
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      got.push(kind(data));
      if (got.length === count) resolve(got);
    });
  });
const open = (url, headers = {}) => {
  const ws = new WebSocket(`${url.replace("http", "ws")}ws`, { origin: `http://127.0.0.1:${port}`, headers });
  return ws;
};
const closed = (ws) => new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));

try {
  // `adb devices -l` parts its columns with spaces, and adb's chatter is not a device.
  assert.deepEqual(parseDevicesLong("List of devices attached\n* daemon started successfully\nemulator-5554   device product:x model:sdk_gphone64_arm64 device:y\nR5CT1\toffline\n"), [
    { serial: "emulator-5554", state: "device", model: "sdk_gphone64_arm64" },
    { serial: "R5CT1", state: "offline", model: null },
  ]);

  // Naming the phone: an adb serial outright; a pairing, by its model on adb; two paired and none named.
  assert.deepEqual(await hub.serialFor("emulator-5554"), { serial: "emulator-5554", pairing: null, label: "sdk_gphone64_arm64" });
  assert.equal((await hub.serialFor("samsung")).serial, "R5CT1", "a pairing found by the model adb lists");
  await assert.rejects(hub.serialFor(), /2 phones are paired; say which with device/);
  await assert.rejects(hub.serialFor("pixel"), /Pixel 9 \(dev-pixel\) is not on this computer's adb \(on adb: emulator-5554 \(sdk_gphone64_arm64\), R5CT1 \(SM_S921U\)\)/);
  await assert.rejects(hub.serialFor("nope"), /No paired phone is "nope"\..* On adb: emulator-5554 \(sdk_gphone64_arm64\), R5CT1 \(SM_S921U\)\./);
  assert.equal((await hub.serialFor("gphone64")).serial, "emulator-5554", "an unpaired device on adb, by its model");

  // Nothing runs yet.
  assert.equal((await tool.handler({ action: "status" })).content[0].text, "No screencast is running.");
  assert.equal((await tool.handler({ action: "stop" })).content[0].text, "No screencast was running.");
  assert.match((await tool.handler({ action: "dance" })).content[0].text, /action is start, stop or status/);
  assert.match((await tool.handler({ device: "emulator-5554", max_fps: 0 })).content[0].text, /max_fps takes a whole number from 1 to 60/);
  assert.equal(children.length, 0, "a bad setting starts nothing");

  // Start: push, forward, run, and the first frame before the reply.
  const started = await tool.handler({ device: "emulator-5554", max_fps: 15, max_size: 720 });
  assert.equal(started.isError, undefined, started.content[0].text);
  assert.match(started.content[0].text, /^Streaming sdk_gphone64_arm64 \(sdk_gphone64_arm64, 576x1280, h264 up to 15 fps\) at\nhttp:\/\/127\.0\.0\.1:\d+\/cast\/[0-9a-f]{32}\/\n/);
  const url = /https?:\/\/\S+/.exec(started.content[0].text)[0];
  assert.deepEqual(
    adbCalls.filter((c) => c.serial === "emulator-5554").map((c) => c.args.slice(0, 2)),
    [["push", "/fake/scrcpy-server"], ["forward", "tcp:0"]],
  );
  assert.equal(adbCalls.find((c) => c.args[0] === "push").args[2], "/data/local/tmp/codedroid-scrcpy-server.jar");
  assert.match(adbCalls.find((c) => c.args[0] === "forward").args[2], /^localabstract:scrcpy_[0-7][0-9a-f]{7}$/, "a 31-bit scid");
  assert.equal(children.length, 1);
  assert.equal(children[0].serial, "emulator-5554");
  assert.match(children[0].command, /app_process \/ com\.genymobile\.scrcpy\.Server 5\.0\.1 .*max_size=720 max_fps=15 /);

  // Starting again is the same cast.
  const again = await tool.handler({ device: "sdk_gphone64_arm64" });
  assert.match(again.content[0].text, /^Already streaming/);
  assert.ok(again.content[0].text.includes(url), "the same URL");
  assert.equal(children.length, 1);

  // The page.
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /VideoDecoder/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/cast/${"0".repeat(32)}/`)).status, 404, "a wrong token");
  assert.equal((await fetch(url, { headers: { Origin: "https://evil.example" } })).status, 403, "a cross-origin page");
  assert.equal((await fetch(`${url}ws`)).status, 426, "the socket path over plain HTTP");

  // A viewer: the hello, then the display size, the config, the key frame, then live frames in order.
  const fake = servers.get("emulator-5554");
  const first = open(url);
  // Listening from the start: the hello and the replay come together.
  const helloSaid = new Promise((resolve) => first.once("message", (data) => resolve(JSON.parse(data))));
  const replay = packetsOf(first, 5);
  const hello = await helloSaid;
  assert.equal(hello.type, "hello");
  assert.equal(hello.mode, "h264");
  assert.equal(hello.width, 576);
  assert.equal(hello.height, 1280);
  assert.equal(hello.settings.maxFps, 15);
  fake.send(fake.frame(false));
  fake.send(fake.frame(false));
  assert.deepEqual(await replay, ["session", "config", "key", "delta", "delta"]);
  const status = JSON.parse((await tool.handler({ action: "status" })).content[0].text);
  assert.equal(status.casts.length, 1);
  assert.equal(status.casts[0].viewers, 1);
  assert.equal(status.casts[0].frames, 3);

  // A viewer joining late gets the config and the frames since the last key frame, not the stream from here on alone.
  const late = open(url);
  const lateFirst = packetsOf(late, 5);
  assert.deepEqual(await lateFirst, ["session", "config", "key", "delta", "delta"]);
  // A new key frame starts the group over: the next late viewer gets only it.
  fake.send(fake.frame(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const latest = open(url);
  assert.deepEqual(await packetsOf(latest, 3), ["session", "config", "key"]);
  // A wrong origin or token gets no socket.
  const refused = new WebSocket(`${url.replace("http", "ws")}ws`, { origin: "https://evil.example" });
  await assert.rejects(new Promise((resolve, reject) => refused.on("open", resolve).on("error", reject)), /403/);
  const unknown = new WebSocket(`ws://127.0.0.1:${port}/cast/${"0".repeat(32)}/ws`, { origin: `http://127.0.0.1:${port}` });
  await assert.rejects(new Promise((resolve, reject) => unknown.on("open", resolve).on("error", reject)), /404/);

  // Stop: the viewers are told, the process is killed, the forward removed.
  const ending = Promise.all([first, late, latest].map(closed));
  assert.equal((await tool.handler({ action: "stop", device: "emulator-5554" })).content[0].text, "Stopped the screencast.");
  for (const end of await ending) assert.deepEqual(end, { code: 1001, reason: "the screencast ended" });
  assert.ok(children[0].killed);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(adbCalls.some((c) => c.serial === "emulator-5554" && c.args[0] === "forward" && c.args[1] === "--remove"), "the forward is removed");
  assert.equal((await tool.handler({ action: "status" })).content[0].text, "No screencast is running.");

  // A cast nobody watches stops by itself; a server that dies ends its cast.
  const idle = await tool.handler({ device: "R5CT1" });
  assert.equal(idle.isError, undefined, idle.content[0].text);
  assert.equal(children.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(children[1].killed, "stopped when nobody watched");
  assert.equal(hub.status().length, 0);
  const dying = await tool.handler({ device: "R5CT1" });
  assert.equal(dying.isError, undefined, dying.content[0].text);
  const watcher = open(/https?:\/\/\S+/.exec(dying.content[0].text)[0]);
  const gone = closed(watcher);
  await new Promise((resolve) => watcher.once("message", resolve));
  children[2].stderr.emit("data", "[server] ERROR: Could not capture\n");
  children[2].emit("exit", 1);
  assert.equal((await gone).code, 1001);
  assert.equal(hub.status().length, 0);

  // A server that never answers: the reply says so, with what it said.
  const silent = new ScreencastHub({
    phones,
    adb: async (args, opts) => {
      if (args[0] !== "forward") return adb(args, opts);
      const nobody = new FakeServer();
      allServers.push(nobody);
      return `${(await nobody.listen()) + 1}\n`;
    },
    spawnShell: (serial, command) => {
      const child = spawnShell(serial, command);
      setTimeout(() => {
        child.stderr.emit("data", "[server] ERROR: Exception on thread\n");
        child.emit("exit", 1);
      }, 30);
      return child;
    },
    serverJar: async () => "/fake/scrcpy-server",
  });
  silent.baseUrl = hub.baseUrl;
  const failed = await createScreencastTool(silent).handler({ device: "emulator-5554" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /scrcpy-server on emulator-5554 exited \(1\)\.\nscrcpy-server said:\n\[server\] ERROR: Exception on thread/);
  await silent.close();

  console.log("screencast.test.mjs: ALL PASS");
} finally {
  await hub.close();
  for (const fake of allServers) await fake.close();
  await new Promise((resolve) => server.close(resolve));
}
