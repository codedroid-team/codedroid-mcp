/**
 * A tool call is never replayed, and failures reach the model as tool errors — no phone.
 *
 * Run: node test/no-replay.test.mjs
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startDaemon } from "../src/daemon.js";

async function connect(port) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

// ── The link drops while a tap is in flight: one tap, and the model is told ─
{
  let taps = 0;
  const factory = () => {
    const phone = new Server({ name: "phone", version: "1" }, { capabilities: { tools: {} } });
    phone.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "tap", inputSchema: { type: "object", properties: {} } }],
    }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    phone.setRequestHandler(CallToolRequestSchema, async () => {
      taps++;
      // The tap happened; its answer is lost with the link.
      await serverSide.close();
      return new Promise(() => {});
    });
    phone.connect(serverSide);
    return clientSide;
  };
  const daemon = await startDaemon({ port: 0, phoneTransportFactory: factory, enableAdbTool: false });
  try {
    const client = await connect(daemon.port);
    const result = await client.callTool({ name: "tap", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /may or may not have happened/);
    assert.equal(taps, 1, "the tap must not be replayed on a new link");
    await client.close();
  } finally {
    await daemon.close();
  }
}

// ── No phone: the session still opens, and a phone tool says why ──────
{
  const factory = () => {
    throw new Error("No Android device on adb. Plug the phone in with USB debugging on.");
  };
  const daemon = await startDaemon({ port: 0, phoneTransportFactory: factory, enableAdbTool: false });
  try {
    const client = await connect(daemon.port);
    assert.match(client.getInstructions(), /not connected yet: No Android device on adb/);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["codedroid_status"]);
    const call = await client.callTool({ name: "get_screen", arguments: {} });
    assert.equal(call.isError, true);
    assert.match(call.content[0].text, /not connected: No Android device on adb/);
    const status = JSON.parse((await client.callTool({ name: "codedroid_status", arguments: {} })).content[0].text);
    assert.equal(status.connected, false);
    assert.match(status.problem, /No Android device/);
    await client.close();
  } finally {
    await daemon.close();
  }
}

// ── A phone still waiting on Allow: the session opens without waiting it out ─
{
  let allow;
  const allowed = new Promise((resolve) => (allow = resolve));
  const factory = async () => {
    await allowed;
    const phone = new Server({ name: "phone", version: "1" }, { capabilities: { tools: {} }, instructions: "PHONE RULES" });
    phone.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "get_screen", inputSchema: { type: "object", properties: {} } }],
    }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    phone.connect(serverSide);
    return clientSide;
  };
  const daemon = await startDaemon({ port: 0, phoneTransportFactory: factory, enableAdbTool: false });
  try {
    const started = Date.now();
    const client = await connect(daemon.port);
    let changed = false;
    client.setNotificationHandler(
      (await import("@modelcontextprotocol/sdk/types.js")).ToolListChangedNotificationSchema,
      () => void (changed = true),
    );
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["codedroid_status"]);
    assert.ok(Date.now() - started < 8_000, "neither initialize nor tools/list waits for the tap");
    allow();
    const status = JSON.parse((await client.callTool({ name: "codedroid_status", arguments: {} })).content[0].text);
    assert.equal(status.connected, true);
    assert.equal(status.instructions, "PHONE RULES", "the phone's rules reach a session that opened before it");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(changed, "the session hears that the phone's tools arrived");
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["codedroid_status", "get_screen"]);
    await client.close();
  } finally {
    await daemon.close();
  }
}

console.log("no-replay.test.mjs: ALL PASS");
