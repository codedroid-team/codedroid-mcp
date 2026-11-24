/**
 * The phones on adb, reached over adb (local-transport.js), against a fake adb whose `forward`
 * opens a real TCP port to a fake CodeDroid: what McpLocal on the phone does at the other end.
 *
 * Run: node test/local-transport.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startDaemon } from "../src/daemon.js";
import { daemonTransport } from "../src/daemon-transport.js";
import { LocalPhones, LocalPhoneTransport, PROBE_MS, withLocal } from "../src/local-transport.js";
import { PhoneDeniedError, PhoneUnavailableError } from "../src/relay-transport.js";
import { VERSION } from "../src/version.js";

/** One line-framed MCP server per socket, after answering the hello with [answer](hello). */
function servePhone(socket, answer, model) {
  let buffered = "";
  let transport = null;
  socket.setEncoding("utf8");
  // The bridge drops a socket it refuses: a reset here is that, not a failure.
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (transport) {
        transport.onmessage?.(JSON.parse(line));
        continue;
      }
      const hello = JSON.parse(line);
      const reply = answer(hello);
      socket.write(`${JSON.stringify(reply)}\n`);
      if (reply.type !== "approved") return void socket.end();
      const phone = new Server({ name: "codedroid", version: "1.0" }, { capabilities: { tools: {} } });
      phone.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "get_screen", inputSchema: { type: "object" } }] }));
      phone.setRequestHandler(CallToolRequestSchema, async (req) => ({
        content: [{ type: "text", text: `${model} over adb from ${hello.host_id}: ${req.params.name}` }],
      }));
      transport = {
        async start() {},
        async send(message) {
          socket.write(`${JSON.stringify(message)}\n`);
        },
        async close() {
          socket.end();
        },
      };
      socket.on("close", () => transport.onclose?.());
      phone.connect(transport);
    }
  });
}

/**
 * A fake adb with [devices] ({serial: {state, status, answer}}): `devices`, the status query, and
 * `forward`, which listens on a real port and hands each connection to servePhone.
 */
function fakeAdb(devices) {
  const calls = [];
  const servers = new Map();
  const hellos = [];
  const adb = async (args, { serial } = {}) => {
    calls.push([serial ?? null, ...args]);
    if (args[0] === "devices") {
      return `List of devices attached\n${Object.entries(devices).map(([s, d]) => `${s}\t${d.state ?? "device"}`).join("\n")}\n`;
    }
    const device = devices[serial];
    if (args[0] === "shell") return device.status ? `Row: 0 result=${JSON.stringify(device.status)}\n` : "No result found.\n";
    if (args[0] === "forward" && args[1] === "--remove") {
      const server = servers.get(args[2]);
      servers.delete(args[2]);
      server?.close();
      return "";
    }
    if (args[0] === "forward") {
      assert.equal(args[2], `localabstract:${device.status.local.socket}`);
      const server = net.createServer((socket) =>
        servePhone(socket, (hello) => (hellos.push(hello), device.answer(hello)), device.status.metadata.model_name),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      servers.set(`tcp:${server.address().port}`, server);
      return `${server.address().port}\n`;
    }
    throw new Error(`unexpected adb ${args.join(" ")}`);
  };
  return { adb, calls, servers, hellos };
}

const status = (id, model, local = { socket: "com.codedroid.agent.mcp.0", key: `key-${id}` }) => ({
  deviceId: id,
  metadata: { model_name: model },
  ...(local ? { local } : {}),
});
const approve = (key) => () => ({ type: "approved", proto: 1, app_version: "1", key });

// ── Scanning: phones with a local link, not older apps or unauthorized ones ─────
{
  let now = 0;
  const devices = {
    "emulator-5554": { status: status("emu-1", "sdk_gphone64"), answer: approve("key-emu-1") },
    ZL83: { status: status("moto-1", "moto g power", null) },
    R5CT: { state: "unauthorized" },
  };
  const { adb, calls } = fakeAdb(devices);
  const local = new LocalPhones({ adb, now: () => now });
  assert.deepEqual(await local.scan(), [
    { serial: "emulator-5554", id: "emu-1", model: "sdk_gphone64", socket: "com.codedroid.agent.mcp.0", key: "key-emu-1" },
  ]);
  assert.equal(local.serialOf("emu-1"), "emulator-5554");
  assert.equal(calls.filter((c) => c[1] === "shell").length, 2, "only devices adb is authorized for are asked");

  await local.scan();
  assert.equal(calls.filter((c) => c[1] === "shell").length, 2, "a recent answer stands");
  now += PROBE_MS;
  devices.ZL83.status = status("moto-1", "moto g power");
  devices.ZL83.answer = approve("key-moto-1");
  assert.deepEqual((await local.scan()).map((p) => p.serial), ["emulator-5554", "ZL83"], "an updated app is found on the next probe");
  delete devices["emulator-5554"];
  assert.deepEqual((await local.scan()).map((p) => p.serial), ["ZL83"], "a phone unplugged is dropped at once");

  const failing = new LocalPhones({ adb: async () => Promise.reject(Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" })) });
  assert.deepEqual(await failing.scan(), [], "no adb is no phone, not an error");
}

// ── Merging: a phone on adb and on the account is one phone, with its serial ───
{
  const account = { server: "https://s", account: true, host_id: null, token: null, device: { id: "moto-1", model: "moto g power" } };
  const merged = withLocal([account], [
    { serial: "ZL83", id: "moto-1", model: "moto g power" },
    { serial: "emulator-5554", id: "emu-1", model: "sdk_gphone64" },
  ]);
  assert.deepEqual(merged, [
    { ...account, serial: "ZL83" },
    { local: true, server: null, host_id: null, token: null, device: { id: "emu-1", model: "sdk_gphone64" }, serial: "emulator-5554" },
  ]);
}

// ── The transport: hello, key, MCP both ways, and the forward removed after ───
{
  const devices = { "emulator-5554": { status: status("emu-1", "sdk_gphone64"), answer: approve("key-emu-1") } };
  const { adb, servers, hellos } = fakeAdb(devices);
  const transport = new LocalPhoneTransport({ serial: "emulator-5554", hostId: "adb:test", adb, env: { CODEDROID_MCP_CLIENT: "claude-code" } });
  await transport.start();
  await transport.start();
  assert.equal(hellos.length, 1, "start() is idempotent: the daemon starts it before the client does");
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  assert.deepEqual(hellos[0], { type: "hello", host_id: "adb:test", host: os.hostname(), client: "claude-code", platform: os.platform(), bridge: VERSION });
  assert.deepEqual(transport.device, { id: "emu-1", model: "sdk_gphone64", server: null, adb: "emulator-5554" });
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["get_screen"]);
  const big = await client.callTool({ name: "get_screen", arguments: {} });
  assert.equal(big.content[0].text, "sdk_gphone64 over adb from adb:test: get_screen");
  assert.equal(servers.size, 1);
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(servers.size, 0, "closing removes the forward");

  devices["emulator-5554"].answer = approve("key-of-someone-else");
  await assert.rejects(new LocalPhoneTransport({ serial: "emulator-5554", hostId: "adb:test", adb }).start(), (e) =>
    e instanceof PhoneUnavailableError && /Something other than CodeDroid/.test(e.message),
  );
  devices["emulator-5554"].answer = () => ({ type: "denied", reason: "Stopped on the device. Try again in 50 s." });
  await assert.rejects(new LocalPhoneTransport({ serial: "emulator-5554", hostId: "adb:test", adb }).start(), PhoneDeniedError);
  assert.equal(servers.size, 0, "a refused start removes its forward");
  devices["emulator-5554"].status = status("emu-1", "sdk_gphone64", null);
  await assert.rejects(new LocalPhoneTransport({ serial: "emulator-5554", hostId: "adb:test", adb }).start(), /not listening for adb: update it/);
}

// ── The daemon: a phone only on adb is reached with no pairing or sign-in ─────
{
  const devices = { "emulator-5554": { status: status("emu-1", "sdk_gphone64"), answer: approve("key-emu-1") } };
  const { adb, hellos } = fakeAdb(devices);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-local-"));
  const daemon = await startDaemon({ port: 0, home, pairings: () => [], local: new LocalPhones({ adb }), accountDevices: async () => null });
  try {
    const client = new Client({ name: "local", version: "0" });
    await client.connect(daemonTransport(daemon.port, daemon.authToken));
    const listed = JSON.parse((await client.callTool({ name: "codedroid_devices", arguments: {} })).content[0].text);
    assert.equal(listed.devices[0].id, "emu-1");
    assert.equal(listed.devices[0].adb, "emulator-5554");
    const result = await client.callTool({ name: "get_screen", arguments: {} });
    assert.match(result.content[0].text, /^sdk_gphone64 over adb from adb:[0-9a-f]{16}: get_screen$/);
    assert.equal(hellos.length, 1);
    await client.close();
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ── A paired phone on adb: over adb as its pairing, the relay when adb fails, never after a refusal ──
{
  const devices = { ZL83: { status: status("moto-1", "moto g power"), answer: approve("key-moto-1") } };
  const { adb, hellos } = fakeAdb(devices);
  const paired = { server: "http://127.0.0.1:9", host_id: "host-7", token: "cdmcp_t", device: { id: "moto-1", model: "moto g power" } };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-local-"));
  const local = new LocalPhones({ adb });
  const daemon = await startDaemon({ port: 0, home, pairings: () => [paired], local, accountDevices: async () => null });
  const call = async () => {
    const client = new Client({ name: "paired", version: "0" });
    await client.connect(daemonTransport(daemon.port, daemon.authToken));
    try {
      return await client.callTool({ name: "get_screen", arguments: {} });
    } finally {
      await client.close();
    }
  };
  try {
    assert.equal((await call()).content[0].text, "moto g power over adb from host-7: get_screen", "the pairing's host id: one holder on both paths");
    await daemon.phones.close();
  } finally {
    await daemon.close();
  }
  const again = await startDaemon({ port: 0, home, pairings: () => [paired], local, accountDevices: async () => null });
  const callAgain = async () => {
    const client = new Client({ name: "paired", version: "0" });
    await client.connect(daemonTransport(again.port, again.authToken));
    try {
      return await client.callTool({ name: "get_screen", arguments: {} });
    } finally {
      await client.close();
    }
  };
  try {
    devices.ZL83.answer = () => ({ type: "denied", reason: "Stopped on the device. Try again in 59 s." });
    const refused = await callAgain();
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /refused this computer: Stopped on the device/, "a Stop is not got round through the relay");
    await again.phones.close();
  } finally {
    await again.close();
  }
  const third = await startDaemon({ port: 0, home, pairings: () => [paired], local, accountDevices: async () => null });
  try {
    devices.ZL83.status = status("moto-1", "moto g power", null);
    const client = new Client({ name: "paired", version: "0" });
    await client.connect(daemonTransport(third.port, third.authToken));
    const relayed = await client.callTool({ name: "get_screen", arguments: {} });
    assert.equal(relayed.isError, true);
    assert.match(relayed.content[0].text, /Could not reach the CodeDroid server at http:\/\/127\.0\.0\.1:9/, "no local link: the relay instead");
    await client.close();
  } finally {
    await third.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.equal(hellos.at(-1).host_id, "host-7");
}

console.log("local-transport: ok");
