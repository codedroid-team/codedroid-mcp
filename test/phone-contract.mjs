/**
 * The bridge against CodeDroid's real MCP server code — run by the app's JVM test
 * (CodeDroid-app/.../mcp/McpBridgeContractTest), which serves mcp/McpProtocol and mcp/McpTools over
 * a scripted screen on 127.0.0.1:<port>, one line per message, and checks this script exits 0.
 *
 * Everything between an MCP client and the phone is real: the daemon, the proxy, RelayPhoneTransport
 * and the TypeScript SDK's schema checks on every reply. Only the orchestrator is faked: a relay that,
 * for each /v1/mcp/connect, dials that port, sends the hello the server would build, then turns
 * lines into frames and back.
 *
 * Run: node test/phone-contract.mjs <port>
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketServer } from "ws";
import { startDaemon } from "../src/daemon.js";
import { RelayPhoneTransport } from "../src/relay-transport.js";
import { VERSION } from "../src/version.js";

const port = Number(process.argv[2]);
assert.ok(port > 0, "usage: node test/phone-contract.mjs <port>");

const relay = http.createServer();
const wss = new WebSocketServer({ server: relay, path: "/v1/mcp/connect" });
wss.on("connection", (ws) => {
  const phone = net.connect(port, "127.0.0.1");
  phone.setEncoding("utf8");
  phone.write(
    JSON.stringify({ type: "hello", proto: 1, host_id: "contract-host", host: "contract", platform: "test", client: "", bridge: VERSION }) + "\n",
  );
  let buffer = "";
  phone.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) ws.send(line);
    }
  });
  ws.on("message", (data) => phone.write(data.toString("utf8") + "\n"));
  ws.on("close", () => phone.destroy());
  phone.on("close", () => ws.close());
  phone.on("error", () => ws.close());
});
await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));

const host = () => ({
  server: `http://127.0.0.1:${relay.address().port}`,
  host_id: "contract-host",
  token: "t",
  device: { id: "contract-device", model: "Fake" },
});
const factory = () => new RelayPhoneTransport({ host, env: {} });
const daemon = await startDaemon({ port: 0, phoneTransportFactory: factory });

const text = (result) => result.content[0].text;
const errorOf = (result) => {
  assert.equal(result.isError, true, text(result));
  return JSON.parse(text(result));
};

try {
  const client = new Client({ name: "contract", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`)));

  // Handshake: the phone's rules first, adb's after, inside what Claude Code keeps.
  const instructions = client.getInstructions();
  assert.ok(instructions.startsWith("CodeDroid drives a REAL Android phone"), instructions);
  assert.ok(Buffer.byteLength(instructions) <= 2000, `instructions are ${Buffer.byteLength(instructions)} bytes`);
  assert.equal(client.getServerVersion().name, "codedroid (via daemon)");

  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name);
  for (const name of ["get_screen", "tap", "type_text", "swipe", "run_task", "get_task", "adb", "codedroid_status"]) {
    assert.ok(names.includes(name), `tools/list lacks ${name}: ${names}`);
  }
  assert.equal(tools.find((t) => t.name === "get_screen").annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "tap").annotations.readOnlyHint, false);

  // Looking.
  const screen = text(await client.callTool({ name: "get_screen", arguments: {} }));
  assert.match(screen, /^app: Settings \(com\.android\.settings\)/);
  assert.match(screen, /\[3\] TextView "Display" clickable \(540,240\)/);
  const withShot = await client.callTool({ name: "get_screen", arguments: { screenshot: true } });
  assert.equal(withShot.content[1].type, "image");
  assert.equal(withShot.content[1].mimeType, "image/jpeg");

  // Acting, and what it says changed.
  const tapped = await client.callTool({ name: "tap", arguments: { node: 3 } });
  assert.notEqual(tapped.isError, true, text(tapped));
  const after = JSON.parse(text(tapped).split("\n").at(-1)).after;
  assert.equal(after.screen_changed, true);
  assert.deepEqual(after.top, ["Brightness level", "Dark theme"]);
  assert.equal(errorOf(await client.callTool({ name: "tap", arguments: { node: 2 } })).error, "stale_node");
  assert.equal(errorOf(await client.callTool({ name: "tap", arguments: {} })).error, "bad_args");
  assert.equal(errorOf(await client.callTool({ name: "swipe", arguments: { x1: 1 } })).error, "bad_args");
  assert.equal(errorOf(await client.callTool({ name: "no_such_tool", arguments: {} })).error, "bad_args");
  const typed = await client.callTool({ name: "type_text", arguments: { text: "héllo wörld ✓", submit: true } });
  assert.notEqual(typed.isError, true, text(typed));

  const waited = JSON.parse(text(await client.callTool({ name: "wait_for", arguments: { text: "dark theme", timeout_ms: 2000 } })));
  assert.equal(waited.met, true);
  assert.match(text(await client.callTool({ name: "list_apps", arguments: { query: "clock" } })), /com\.google\.android\.deskclock/);
  assert.equal(JSON.parse(text(await client.callTool({ name: "device_info", arguments: {} }))).model_name, "Pixel 5");

  // A task, start to finish.
  const started = JSON.parse(text(await client.callTool({ name: "run_task", arguments: { goal: "Set an alarm for 7:15" } })));
  assert.equal(started.task_id, "t1");
  assert.equal(JSON.parse(text(await client.callTool({ name: "get_task", arguments: { task_id: "t1", wait_s: 0 } }))).status, "running");
  assert.equal(JSON.parse(text(await client.callTool({ name: "cancel_task", arguments: { task_id: "t1" } }))).cancelled, true);

  // Resources.
  const resources = (await client.listResources()).resources.map((r) => r.uri);
  assert.deepEqual(resources, ["codedroid://guide", "codedroid://device"]);
  const guide = await client.readResource({ uri: "codedroid://guide" });
  assert.match(guide.contents[0].text, /^# Driving a phone with CodeDroid/);
  await assert.rejects(client.readResource({ uri: "codedroid://nope" }), /No resource/);

  await client.ping();
  const status = JSON.parse(text(await client.callTool({ name: "codedroid_status", arguments: {} })));
  assert.equal(status.connected, true);
  assert.deepEqual(status.device, { id: "contract-device", model: "Fake", server: host().server });

  await client.close();
  console.log("phone-contract.mjs: ALL PASS");
} finally {
  await daemon.close();
  for (const ws of wss.clients) ws.terminate();
  relay.close();
}
