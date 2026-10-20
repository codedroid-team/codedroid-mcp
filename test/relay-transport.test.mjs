/**
 * RelayPhoneTransport against a fake relay on a real WebSocket server — no orchestrator, no phone.
 *
 * The fake relay checks what the bridge sends on the upgrade, answers with the first frame the
 * test asks for, then plays the phone: MCP, one JSON-RPC message per text frame, as the
 * orchestrator relays CodeDroid's mcp/McpServer lines.
 *
 * Run: node test/relay-transport.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import { connectUrl, PhoneDeniedError, PhoneUnavailableError, RelayPhoneTransport } from "../src/relay-transport.js";
import { VERSION } from "../src/version.js";

/** The phone's MCP server on one relayed WebSocket. */
function servePhone(ws) {
  const phone = new Server({ name: "codedroid", version: "1.0" }, { capabilities: { tools: {} }, instructions: "PHONE" });
  phone.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "get_screen", inputSchema: { type: "object", properties: {} } }],
  }));
  phone.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "x".repeat(300_000) }],
  }));
  const transport = {
    async start() {},
    async send(message) {
      ws.send(JSON.stringify(message));
    },
    async close() {
      ws.close();
    },
  };
  ws.on("message", (data) => transport.onmessage?.(JSON.parse(data.toString())));
  ws.on("close", () => transport.onclose?.());
  phone.connect(transport);
}

/**
 * A relay that answers each connect with [reply]: an object (sent as the first frame, then the
 * phone serves MCP if it is approved), a number (the HTTP status refusing the upgrade), "close"
 * (closes without answering), or null (never answers).
 */
async function fakeRelay(reply) {
  const upgrades = [];
  const sockets = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push({ url: req.url, headers: req.headers });
    if (typeof reply === "number") {
      socket.end(`HTTP/1.1 ${reply} Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      if (reply === null) return;
      if (reply === "close") return void ws.close(1000);
      ws.send(JSON.stringify(reply));
      if (reply.type === "approved") servePhone(ws);
      else ws.close(1000);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  };
  return { upgrades, sockets, close, url: `http://127.0.0.1:${server.address().port}` };
}

const pairing = (server) => () => ({
  server,
  host_id: "host-1",
  token: "cdmcp_secret",
  device: { id: "device-1", model: "Pixel 5" },
});

// ── Approved: the right headers, MCP both ways, close reaches onclose ─
{
  const relay = await fakeRelay({ type: "approved", proto: 1, app_version: "1.0" });
  const transport = new RelayPhoneTransport({ host: pairing(relay.url), env: { CODEDROID_MCP_CLIENT: " Claude Code " } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const { url, headers } = relay.upgrades[0];
  assert.equal(url, "/v1/mcp/connect");
  assert.equal(headers.authorization, "Bearer cdmcp_secret");
  assert.equal(headers["x-codedroid-client"], "Claude Code");
  assert.equal(headers["x-codedroid-bridge"], VERSION);
  assert.deepEqual(transport.device, { id: "device-1", model: "Pixel 5", server: relay.url });
  assert.equal(client.getInstructions(), "PHONE");
  assert.equal((await client.listTools()).tools[0].name, "get_screen");
  const result = await client.callTool({ name: "get_screen", arguments: {} });
  assert.equal(result.content[0].text.length, 300_000, "a screenshot-sized reply arrives whole");

  let closed = false;
  client.onclose = () => void (closed = true);
  relay.sockets[0].close(1000);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(closed, "the relay closing reaches onclose");
  await assert.rejects(transport.send({ jsonrpc: "2.0", method: "ping", id: 9 }), /not open/, "a closed link says so, as proxy-core expects");
  await relay.close();
}

// ── Closing from this side closes the relay's socket ──────────────────
{
  const relay = await fakeRelay({ type: "approved", proto: 1 });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new RelayPhoneTransport({ host: pairing(relay.url), env: {} }));
  assert.equal(relay.upgrades[0].headers["x-codedroid-client"], "", "no client is guessed");
  const gone = new Promise((resolve) => relay.sockets[0].on("close", resolve));
  await client.close();
  await gone;
  await relay.close();
}

// ── Denied: the phone's reason reaches the user ───────────────────────
{
  const relay = await fakeRelay({ type: "denied", reason: "Not allowed on the phone. Try again in 60 s." });
  const transport = new RelayPhoneTransport({ host: pairing(relay.url), env: {} });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneDeniedError && /Not allowed on the phone/.test(e.message));
  await relay.close();
}

// ── Unavailable: the server's reason reaches the user ─────────────────
{
  const reason = "The phone is not connected to CodeDroid: open CodeDroid on it and check it is online and signed in.";
  const relay = await fakeRelay({ type: "unavailable", reason });
  const transport = new RelayPhoneTransport({ host: pairing(relay.url), env: {} });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneUnavailableError && e.message === reason);
  await relay.close();
}

// ── Refused upgrade: the pairing is gone, pair again ──────────────────
for (const status of [401, 403]) {
  const relay = await fakeRelay(status);
  const transport = new RelayPhoneTransport({ host: pairing(relay.url), env: {} });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneUnavailableError && /pairing was removed.*Pair a computer/.test(e.message));
  await relay.close();
}

// ── Other refusals, closing unanswered, a frame that is no answer ─────
for (const [reply, message] of [
  [500, /refused the connection \(HTTP 500\)/],
  ["close", /closed the connection before the phone answered/],
  [{ type: "hello" }, /something other than a handshake/],
]) {
  const relay = await fakeRelay(reply);
  const transport = new RelayPhoneTransport({ host: pairing(relay.url), env: {} });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneUnavailableError && message.test(e.message));
  await assert.rejects(transport.send({ jsonrpc: "2.0", method: "ping", id: 1 }), /not open/);
  await relay.close();
}

// ── The relay's URL: wss for https, under any path prefix ─────────────
assert.equal(connectUrl("https://orchestrator.codedroid.com"), "wss://orchestrator.codedroid.com/v1/mcp/connect");
assert.equal(connectUrl("http://127.0.0.1:8000/base"), "ws://127.0.0.1:8000/base/v1/mcp/connect");

// ── Not paired: nothing is dialed, and the steps are given ────────────
{
  const transport = new RelayPhoneTransport({ host: () => null, env: {} });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneUnavailableError && /not paired.*npx -y @codedroid\/mcp pair/.test(e.message));
}

// ── Nobody taps Allow: it gives up, saying what to do ─────────────────
{
  const relay = await fakeRelay(null);
  const transport = new RelayPhoneTransport({ host: pairing(relay.url), env: {}, approvalTimeoutMs: 200 });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneUnavailableError && /tap Allow/.test(e.message));
  await relay.close();
}

// ── No server there: says which ───────────────────────────────────────
{
  const relay = await fakeRelay(null);
  await relay.close();
  const transport = new RelayPhoneTransport({ host: pairing(relay.url), env: {} });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneUnavailableError && e.message.includes(`Could not reach the CodeDroid server at ${relay.url}`));
}

console.log("relay-transport.test.mjs: ALL PASS");
