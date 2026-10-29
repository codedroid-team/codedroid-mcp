/**
 * Several paired phones behind one daemon — no phone required.
 *
 * Each pairing gets a fake phone that answers with its own name. Sessions must reach the phone a
 * call names, run calls to different phones side by side, keep working when one phone is down,
 * and pick up a pairing made or removed while the daemon runs, without a restart.
 *
 * Run: node test/multi-phone.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startDaemon } from "../src/daemon.js";
import { daemonTransport } from "../src/daemon-transport.js";

const pairingOf = (id, model) => ({ server: "https://orchestrator.example", host_id: `host-${id}`, token: `t-${id}`, device: { id, model } });
const XPS = pairingOf("630bc5c2-40b6-4dd7-9e28-db71f509af4b", "XPS Googlebook");
const PIXEL = pairingOf("9a1e7c00-1111-4222-8333-444455556666", "Pixel 9");
const TABLET = pairingOf("77aa0000-1111-4222-8333-444455556666", "Pixel Tablet");
const GALAXY = pairingOf("5ca1ab1e-1111-4222-8333-444455556666", "Galaxy S24");

let paired = [XPS, PIXEL];
/** Phones that refuse to connect, by device id. */
const offline = new Set();
const connects = new Map();
/** Phones whose link opens only once their promise resolves (a person yet to tap Allow), by device id. */
const gated = new Map();
/** Device ids whose link the daemon closed. */
const closedLinks = new Set();
const inFlight = new Map();
const maxInFlight = new Map();
let maxInFlightTotal = 0;

function fakePhone(pairing) {
  const id = pairing.device.id;
  if (offline.has(id)) throw new Error(`${pairing.device.model} is not online.`);
  connects.set(id, (connects.get(id) ?? 0) + 1);
  const phone = new Server(
    { name: "phone", version: "1" },
    { capabilities: { tools: {}, resources: {} }, instructions: "PHONE RULES" },
  );
  phone.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "tap", inputSchema: { type: "object", properties: { node: { type: "number" } } } },
      { name: "get_task", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  phone.setRequestHandler(CallToolRequestSchema, async (req) => {
    const running = (inFlight.get(id) ?? 0) + 1;
    inFlight.set(id, running);
    maxInFlight.set(id, Math.max(maxInFlight.get(id) ?? 0, running));
    maxInFlightTotal = Math.max(maxInFlightTotal, [...inFlight.values()].reduce((a, b) => a + b, 0));
    await new Promise((r) => setTimeout(r, 80));
    inFlight.set(id, inFlight.get(id) - 1);
    return { content: [{ type: "text", text: `${pairing.device.model}: ${req.params.name} ${JSON.stringify(req.params.arguments)}` }] };
  });
  phone.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "codedroid://device", name: "This phone" }],
  }));
  phone.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, text: `${pairing.device.model} at ${req.params.uri}` }],
  }));
  phone.onclose = () => closedLinks.add(id);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  phone.connect(serverSide);
  return gated.has(id) ? gated.get(id).then(() => clientSide) : clientSide;
}

async function connect(port, token) {
  const client = new Client({ name: "multi", version: "0" });
  await client.connect(daemonTransport(port, token));
  return client;
}

const text = (result) => result.content[0].text;
const status = async (client, args = {}) => JSON.parse(text(await client.callTool({ name: "codedroid_status", arguments: args })));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-multi-"));
const daemon = await startDaemon({ port: 0, pairings: () => paired, phoneTransportFactory: fakePhone, home });

try {
  const client = await connect(daemon.port, daemon.authToken);
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void listChanged++);

  // ── One list of tools, each taking the phone to run on ──────────────
  assert.match(client.getInstructions(), /^PHONE RULES\n\nSeveral phones are paired: pass `device`/);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name), ["tap", "get_task", "codedroid_devices", "codedroid_status"], "a tool every phone has is listed once");
  for (const tool of tools.filter((t) => t.name !== "codedroid_devices")) {
    assert.equal(tool.inputSchema.properties.device.type, "string", `${tool.name} takes device`);
  }
  assert.deepEqual(tools[0].inputSchema.properties.node, { type: "number" }, "the phone's own arguments are kept");

  // ── Calls reach the phone they name, which never sees `device` ──────
  assert.equal(text(await client.callTool({ name: "tap", arguments: { device: XPS.device.id, node: 1 } })), 'XPS Googlebook: tap {"node":1}');
  assert.equal(text(await client.callTool({ name: "tap", arguments: { device: "pixel 9", node: 2 } })), 'Pixel 9: tap {"node":2}');
  assert.equal(text(await client.callTool({ name: "tap", arguments: { device: "630b", node: 3 } })), 'XPS Googlebook: tap {"node":3}');

  // ── Without a phone, or naming none of them: said, and nothing runs ─
  const unnamed = await client.callTool({ name: "tap", arguments: { node: 4 } });
  assert.equal(unnamed.isError, true);
  assert.match(text(unnamed), /2 phones are paired; say which with the device argument.*XPS Googlebook \(630bc5c2.*\), Pixel 9 \(9a1e7c00/);
  const unknown = await client.callTool({ name: "tap", arguments: { device: "Galaxy", node: 5 } });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /No paired phone is "Galaxy"\. Paired: XPS Googlebook/);
  assert.equal(text(await client.callTool({ name: "tap", arguments: { device: "Pixel", node: 6 } })), 'Pixel 9: tap {"node":6}', "part of a model names the one phone that has it");

  // ── Two screens, two queues: side by side across phones, one at a time on each ──
  maxInFlight.clear();
  maxInFlightTotal = 0;
  const other = await connect(daemon.port, daemon.authToken);
  const started = Date.now();
  await Promise.all([
    client.callTool({ name: "tap", arguments: { device: "XPS Googlebook", node: 1 } }),
    client.callTool({ name: "tap", arguments: { device: "XPS Googlebook", node: 2 } }),
    other.callTool({ name: "tap", arguments: { device: "Pixel 9", node: 1 } }),
    other.callTool({ name: "tap", arguments: { device: "Pixel 9", node: 2 } }),
  ]);
  assert.equal(maxInFlight.get(XPS.device.id), 1, "one phone's screen calls are serialized");
  assert.equal(maxInFlight.get(PIXEL.device.id), 1);
  assert.equal(maxInFlightTotal, 2, "different phones do not wait on each other");
  assert.ok(Date.now() - started < 300, `two queues of two 80 ms calls took ${Date.now() - started} ms`);
  assert.equal(connects.get(XPS.device.id), 1, "every session shares each phone's one link");
  assert.equal(connects.get(PIXEL.device.id), 1);
  await other.close();

  // ── Resources: one per phone, read from that phone ──────────────────
  const resources = (await client.listResources()).resources;
  assert.deepEqual(resources.map((r) => r.uri), [
    `codedroid://device?device=${XPS.device.id}`,
    `codedroid://device?device=${PIXEL.device.id}`,
  ]);
  assert.deepEqual(resources.map((r) => r.name), ["This phone (XPS Googlebook)", "This phone (Pixel 9)"]);
  const read = await client.readResource({ uri: resources[1].uri });
  assert.equal(read.contents[0].text, "Pixel 9 at codedroid://device", "the phone reads its own URI");
  await assert.rejects(client.readResource({ uri: "codedroid://device" }), /2 phones are paired/);

  // ── codedroid_devices: every paired phone and its link, without connecting ──
  const listed = JSON.parse(text(await client.callTool({ name: "codedroid_devices", arguments: {} })));
  assert.deepEqual(listed.devices, [
    { id: XPS.device.id, model: "XPS Googlebook", server: XPS.server, state: "connected" },
    { id: PIXEL.device.id, model: "Pixel 9", server: PIXEL.server, state: "connected" },
  ]);

  // ── Status: every phone, or the one named ───────────────────────────
  const both = await status(client);
  assert.equal(both.connected, true);
  assert.deepEqual(both.devices.map((d) => [d.model, d.connected]), [["XPS Googlebook", true], ["Pixel 9", true]]);
  assert.equal(both.device, undefined, "device is for a status of one phone");
  const one = await status(client, { device: "Pixel 9" });
  assert.deepEqual(one.device, { id: PIXEL.device.id, model: "Pixel 9", server: PIXEL.server });
  assert.match((await status(client, { device: "Galaxy" })).problem, /No paired phone is "Galaxy"/);

  // ── A third phone paired while the daemon runs: no restart, sessions keep going ──
  paired = [...paired, TABLET];
  listChanged = 0;
  assert.equal(text(await client.callTool({ name: "tap", arguments: { device: "Pixel Tablet", node: 7 } })), 'Pixel Tablet: tap {"node":7}');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(listChanged >= 1, "a phone that connects announces its tools");
  assert.equal((await status(client)).devices.length, 3);
  const health = await fetch(`http://127.0.0.1:${daemon.port}/health`).then((r) => r.json());
  assert.deepEqual(health.phones, { paired: 3, connected: 3 });
  assert.equal(health.phone, "connected");

  // ── One phone down: the others still work, and status says which ────
  offline.add(PIXEL.device.id);
  paired = paired.map((p) => (p === PIXEL ? { ...PIXEL, token: "t-repaired" } : p)); // re-paired: its link is replaced
  const down = await client.callTool({ name: "tap", arguments: { device: "Pixel 9", node: 8 } });
  assert.equal(down.isError, true);
  assert.match(text(down), /CodeDroid on Pixel 9 \(9a1e7c00.*\) is not connected: Pixel 9 is not online\./);
  assert.equal(text(await client.callTool({ name: "tap", arguments: { device: "XPS Googlebook", node: 9 } })), 'XPS Googlebook: tap {"node":9}');
  const connectsBefore = connects.get(TABLET.device.id);
  const devices = JSON.parse(text(await client.callTool({ name: "codedroid_devices", arguments: {} }))).devices;
  assert.deepEqual(devices.map((d) => d.state), ["connected", "disconnected", "connected"]);
  assert.equal(devices[1].problem, "Pixel 9 is not online.", "a phone that failed says why");
  assert.equal(connects.get(TABLET.device.id), connectsBefore, "listing devices connects nothing");
  const partial = await status(client);
  assert.equal(partial.connected, false);
  assert.deepEqual(partial.devices.map((d) => d.connected), [true, false, true]);
  assert.match(partial.problem, /^Pixel 9 \(9a1e7c00.*\): Pixel 9 is not online\.$/);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["tap", "get_task", "codedroid_devices", "codedroid_status"], "a phone down hides no tools");

  // ── Unpaired while the daemon runs: that phone is gone, the rest stay ──
  paired = [XPS];
  const gone = await client.callTool({ name: "tap", arguments: { device: "Pixel Tablet", node: 10 } });
  assert.match(text(gone), /No paired phone is "Pixel Tablet"\. Paired: XPS Googlebook/);
  // With one phone left, device is optional again.
  assert.equal(text(await client.callTool({ name: "tap", arguments: { node: 11 } })), 'XPS Googlebook: tap {"node":11}');
  assert.deepEqual((await client.listResources()).resources.map((r) => r.uri), ["codedroid://device"]);

  // ── Unpaired while its link is still opening: the link is closed once it opens, never used ──
  let allow;
  gated.set(GALAXY.device.id, new Promise((resolve) => (allow = resolve)));
  paired = [XPS, GALAXY];
  const waiting = client.callTool({ name: "tap", arguments: { device: "Galaxy", node: 12 } });
  await new Promise((r) => setTimeout(r, 20));
  paired = [XPS];
  await client.callTool({ name: "codedroid_devices", arguments: {} });
  listChanged = 0;
  allow();
  const late = await waiting;
  assert.equal(late.isError, true);
  assert.match(text(late), /CodeDroid on Galaxy S24 \(5ca1ab1e.*\) is not connected: This phone's link is closed/);
  assert.ok(closedLinks.has(GALAXY.device.id), "a link that opens after its pairing is gone is closed");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(listChanged, 0, "a phone no longer paired announces nothing");

  await client.close();
  console.log("multi-phone.test.mjs: ALL PASS");
} finally {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
}
