/**
 * Shared phones: the bridge's part of the phone's leases — no phone required.
 *
 * Each fake phone keeps a lease the way CodeDroid does (holder = the session in _meta; a call that
 * names none speaks for the whole computer) and refuses other sessions with in_use. The bridge must
 * name the session on every call it makes for one (direct, batch, flow, install), say which phones
 * are free, claim "any" free phone, let go of a session's phones when its client ends it, and keep
 * them held when the daemon itself restarts.
 *
 * Run: node test/leases.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startDaemon } from "../src/daemon.js";
import { daemonTransport } from "../src/daemon-transport.js";
import { CLI_CLIENT_NAME, SESSION_META_KEY } from "../src/proxy-core.js";

const pairingOf = (id, model) => ({ server: "https://orchestrator.example", host_id: `host-${id}`, token: `t-${id}`, device: { id, model } });
const PIXEL = pairingOf("9a1e7c00-1111-4222-8333-444455556666", "Pixel 9");
const GALAXY = pairingOf("5ca1ab1e-1111-4222-8333-444455556666", "Galaxy S24");

/**
 * Per phone id: {holder, calls: [{name, session}], stealNext}. The phone's rules for one computer:
 * the holder is a session (or null, the computer itself); a call naming no session runs under any
 * hold but never releases another's; acting on a free phone holds it even when the action fails.
 */
const phones = new Map([PIXEL, GALAXY].map((p) => [p.device.id, { holder: undefined, calls: [], stealNext: false }]));
const READ_ONLY = new Set(["get_screen", "device_info"]);
const json = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });

function fakePhone(pairing) {
  const state = phones.get(pairing.device.id);
  const phone = new Server({ name: "phone", version: "1" }, { capabilities: { tools: {} }, instructions: "PHONE RULES" });
  phone.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["get_screen", "tap", "fail", "device_info", "claim_device", "release_device", "install_begin"].map((name) => ({
      name,
      inputSchema: { type: "object", properties: {} },
    })),
  }));
  phone.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const session = req.params._meta?.[SESSION_META_KEY] ?? null;
    state.calls.push({ name, session });
    const same = (holder) => holder === session;
    const free = state.holder === undefined;
    if (name === "device_info") {
      return json({ model_name: pairing.device.model, status: free ? "available" : "in_use", lease: free ? null : { holder: `agent ${state.holder}`, yours: same(state.holder) } });
    }
    if (name === "release_device") {
      const released = !free && same(state.holder);
      if (released) state.holder = undefined;
      return json({ released });
    }
    if (state.stealNext) {
      state.stealNext = false;
      state.holder = "someone-else";
    }
    if (state.holder !== undefined && !same(state.holder) && session !== null) return json({ error: "in_use", message: `agent ${state.holder} is using this device` }, true);
    if (name === "claim_device" || (state.holder === undefined && !READ_ONLY.has(name))) state.holder = session;
    if (name === "fail") return json({ error: "stale_node", message: "gone" }, true);
    return json({ ok: name, on: pairing.device.model });
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  phone.connect(serverSide);
  return clientSide;
}

async function connect(port, token, name = "agent") {
  const client = new Client({ name, version: "0" });
  await client.connect(daemonTransport(port, token));
  return client;
}

const text = (result) => result.content.map((c) => c.text).join("\n");
const callsOf = (pairing) => phones.get(pairing.device.id).calls;
const sessionsOf = (pairing, name) => callsOf(pairing).filter((c) => c.name === name).map((c) => c.session);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-leases-"));
const flowFile = path.join(home, "flow.yaml");
fs.writeFileSync(flowFile, "appId: com.example\n---\n- tapOn:\n    point: 10,20\n");
let daemon = await startDaemon({ port: 0, pairings: () => [PIXEL, GALAXY], phoneTransportFactory: fakePhone, home });

try {
  const ana = await connect(daemon.port, daemon.authToken);
  const bo = await connect(daemon.port, daemon.authToken);

  // ── claim_device says it takes "any" ────────────────────────────────
  const claimTool = (await ana.listTools()).tools.find((t) => t.name === "claim_device");
  assert.match(claimTool.inputSchema.properties.device.description, /"any" takes whichever phone is available/);
  assert.match(ana.getInstructions(), /claim_device with device "any"/);

  // ── "any": the first free phone, then the next, then none ───────────
  const anaClaim = await ana.callTool({ name: "claim_device", arguments: { device: "any", purpose: "checkout e2e" } });
  assert.equal(anaClaim.isError, false);
  assert.match(text(anaClaim), new RegExp(`Claimed Pixel 9 \\(${PIXEL.device.id}\\): pass device "${PIXEL.device.id}" on every call`));
  const boClaim = await bo.callTool({ name: "claim_device", arguments: { device: "ANY" } });
  assert.match(text(boClaim), /Claimed Galaxy S24/);
  const carol = await connect(daemon.port, daemon.authToken);
  const none = await carol.callTool({ name: "claim_device", arguments: { device: "any" } });
  assert.equal(none.isError, true);
  assert.match(text(none), /No phone is available now\. Pixel 9 \(.*\): in_use \(agent ses_.*\); Galaxy S24 \(.*\): in_use/);

  // ── Each session's calls name it; the phone keeps others off ────────
  const [anaSession] = sessionsOf(PIXEL, "claim_device");
  const [boSession] = sessionsOf(GALAXY, "claim_device");
  assert.match(anaSession, /^ses_/);
  assert.match(boSession, /^ses_/);
  assert.notEqual(anaSession, boSession, "two clients are two holders");
  const refused = await bo.callTool({ name: "tap", arguments: { device: "Pixel 9" } });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /in_use/);

  // ── codedroid_devices: who holds what, from the phones themselves ───
  const listed = JSON.parse(text(await bo.callTool({ name: "codedroid_devices", arguments: {} }))).devices;
  assert.deepEqual(listed.map((d) => [d.model, d.status, d.lease?.yours]), [["Pixel 9", "in_use", false], ["Galaxy S24", "in_use", true]]);

  // ── batch, flows and installs run as the session that asked ─────────
  callsOf(PIXEL).length = 0;
  const batch = await ana.callTool({ name: "batch", arguments: { device: "Pixel 9", steps: [{ tool: "tap" }, { tool: "get_screen" }] } });
  assert.ok(!batch.isError, text(batch));
  const flow = await ana.callTool({ name: "run_flow", arguments: { device: "Pixel 9", path: flowFile } });
  assert.ok(!flow.isError, text(flow));
  const apk = path.join(home, "app.apk");
  fs.writeFileSync(apk, Buffer.from("PK\u0003\u0004 not really an apk"));
  await ana.callTool({ name: "install_apk", arguments: { device: "Pixel 9", path: apk } });
  const named = callsOf(PIXEL);
  assert.ok(named.some((c) => c.name === "install_begin"), "the install reached the phone");
  assert.deepEqual([...new Set(named.map((c) => c.session))], [anaSession], "every call carried ana's session");

  // ── The CLI's calls name no session: they are the whole computer's ──
  const cli = await connect(daemon.port, daemon.authToken, CLI_CLIENT_NAME);
  callsOf(GALAXY).length = 0;
  await cli.callTool({ name: "get_screen", arguments: { device: "Galaxy" } });
  assert.deepEqual(sessionsOf(GALAXY, "get_screen"), [null]);
  await cli.close();
  assert.equal(phones.get(GALAXY.device.id).holder, boSession, "a CLI run that ends lets go of nothing");

  // ── A raced claim moves on to the next free phone ───────────────────
  await ana.callTool({ name: "release_device", arguments: { device: "Pixel 9" } });
  await bo.callTool({ name: "release_device", arguments: { device: "Galaxy" } });
  phones.get(PIXEL.device.id).stealNext = true;
  assert.match(text(await carol.callTool({ name: "claim_device", arguments: { device: "any" } })), /Claimed Galaxy S24/);
  phones.get(PIXEL.device.id).holder = undefined;

  // ── "any" again: the phone this session holds, not a second one ─────
  assert.match(text(await carol.callTool({ name: "claim_device", arguments: { device: "any" } })), /Claimed Galaxy S24/);
  assert.equal(phones.get(PIXEL.device.id).holder, undefined, "the free phone was left free");
  await carol.callTool({ name: "release_device", arguments: { device: "Galaxy" } });

  // ── A failed action still held the phone: the session lets go of it at its end ──
  const dan = await connect(daemon.port, daemon.authToken);
  assert.equal((await dan.callTool({ name: "fail", arguments: { device: "Galaxy" } })).isError, true);
  const danSession = phones.get(GALAXY.device.id).holder;
  assert.match(danSession, /^ses_/);
  await dan.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(phones.get(GALAXY.device.id).holder, undefined, "released though the action failed");

  // ── A session that only ran a flow lets go of its phone at its end ───
  const eve = await connect(daemon.port, daemon.authToken);
  assert.ok(!(await eve.callTool({ name: "run_flow", arguments: { device: "Galaxy", path: flowFile } })).isError);
  assert.match(phones.get(GALAXY.device.id).holder, /^ses_/);
  await eve.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(phones.get(GALAXY.device.id).holder, undefined, "the flow's hold is released");

  // ── A session its client ends lets go of its phones ─────────────────
  await bo.callTool({ name: "tap", arguments: { device: "Pixel 9" } });
  assert.equal(phones.get(PIXEL.device.id).holder, boSession, "acting on a free phone holds it");
  callsOf(PIXEL).length = 0;
  await bo.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sessionsOf(PIXEL, "release_device"), [boSession], "released as bo, and only bo's phone");
  assert.equal(phones.get(PIXEL.device.id).holder, undefined);

  // ── The daemon restarting keeps them held: its clients come back ────
  await ana.callTool({ name: "claim_device", arguments: { device: "Pixel 9" } });
  callsOf(PIXEL).length = 0;
  await daemon.close();
  assert.deepEqual(sessionsOf(PIXEL, "release_device"), [], "nothing released at shutdown");
  assert.equal(phones.get(PIXEL.device.id).holder, anaSession);
  daemon = null;

  console.log("leases.test.mjs: ALL PASS");
} finally {
  await daemon?.close();
  fs.rmSync(home, { recursive: true, force: true });
}
