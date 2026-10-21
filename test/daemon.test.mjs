/**
 * Daemon integration test — no phone required.
 *
 * A fake "phone" MCP server is wired in via InMemoryTransport where the real
 * RelayPhoneTransport would sit. Real Streamable HTTP clients then connect
 * to the daemon and must see the phone's instructions/tools and share the
 * single backend connection concurrently.
 *
 * Run: node test/daemon.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { daemonTransport } from "../src/daemon-transport.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startDaemon } from "../src/daemon.js";

const FAKE_INSTRUCTIONS = "FAKE PHONE INSTRUCTIONS — agents must see this at handshake.";
let phoneConnects = 0;
let inFlightCalls = 0;
let maxInFlightCalls = 0;

function makeFakePhoneTransport() {
  phoneConnects++;
  const phone = new Server(
    { name: "fake-phone", version: "9.9.9" },
    { capabilities: { tools: {} }, instructions: FAKE_INSTRUCTIONS },
  );
  phone.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echoes text back.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  }));
  phone.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "get_task") {
      // A task still running: get_task waits on it, off the screen.
      await new Promise((r) => setTimeout(r, 300));
      return { content: [{ type: "text", text: "task done" }] };
    }
    inFlightCalls++;
    maxInFlightCalls = Math.max(maxInFlightCalls, inFlightCalls);
    await new Promise((r) => setTimeout(r, 50)); // simulate a slow screen action
    inFlightCalls--;
    return {
      content: [{ type: "text", text: `echo: ${req.params.arguments?.text}` }],
    };
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  phone.connect(serverSide);
  return clientSide;
}

async function connectHttpClient(port, name) {
  const client = new Client({ name, version: "0.0.1" });
  const transport = daemonTransport(port);
  await client.connect(transport);
  return { client, transport };
}

const daemon = await startDaemon({
  port: 0,
  phoneTransportFactory: makeFakePhoneTransport,
  log: () => {},
  enableAdbTool: false,
});

try {
  // ── Session 1: instructions + tools pass through ────────────────────
  const a = await connectHttpClient(daemon.port, "client-a");
  assert.equal(
    a.client.getInstructions(),
    FAKE_INSTRUCTIONS,
    "instructions must reach the client at handshake, unmodified when adb is off",
  );
  const toolsA = await a.client.listTools();
  // The phone's "echo" and the daemon's own codedroid_status; no adb with CODEDROID_MCP_ADB=0.
  assert.deepEqual(
    toolsA.tools.map((t) => t.name).sort(),
    ["codedroid_status", "echo"],
    "adb must not appear in tools/list when turned off",
  );

  const resultA = await a.client.callTool({
    name: "echo",
    arguments: { text: "hello-from-a" },
  });
  assert.equal(resultA.content[0].text, "echo: hello-from-a");

  // ── Session 2 concurrently: both must work, sharing ONE phone link ──
  const b = await connectHttpClient(daemon.port, "client-b");
  const [resA, resB] = await Promise.all([
    a.client.callTool({ name: "echo", arguments: { text: "again-a" } }),
    b.client.callTool({ name: "echo", arguments: { text: "again-b" } }),
  ]);
  assert.equal(resA.content[0].text, "echo: again-a");
  assert.equal(resB.content[0].text, "echo: again-b");
  assert.equal(phoneConnects, 1, "both sessions must share one phone connection");
  assert.equal(
    maxInFlightCalls,
    1,
    "tool calls must be serialized onto the single screen",
  );

  // ── A get_task waiting on a task holds up nobody's screen calls ────
  const order = [];
  await Promise.all([
    a.client.callTool({ name: "get_task", arguments: { task_id: "t1" } }).then(() => order.push("get_task")),
    new Promise((r) => setTimeout(r, 20))
      .then(() => b.client.callTool({ name: "echo", arguments: { text: "meanwhile" } }))
      .then(() => order.push("echo")),
  ]);
  assert.deepEqual(order, ["echo", "get_task"], "get_task must not queue screen calls behind it");

  // ── /health reflects reality ────────────────────────────────────────
  const health = await fetch(`http://127.0.0.1:${daemon.port}/health`).then((r) =>
    r.json(),
  );
  assert.equal(health.ok, true);
  assert.equal(health.service, "codedroid-mcp-daemon");
  assert.equal(health.phone, "connected");
  assert.equal(health.sessions, 2);
  assert.equal(health.adbToolEnabled, false, "/health must say adb is off");

  // ── Non-loopback Host header is rejected ────────────────────────────
  // (fetch/undici silently strips a custom Host header, so use raw http.)
  const forbiddenStatus = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: daemon.port,
        path: "/health",
        method: "GET",
        headers: { Host: "evil.example.com" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(forbiddenStatus, 403, "DNS-rebinding style requests must be blocked");

  // ── Bad session id → clean JSON-RPC error, not a crash ─────────────
  const bad = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "nonexistent",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
  assert.equal(bad.status, 400);

  // ── Clean session teardown ──────────────────────────────────────────
  await a.transport.terminateSession();
  await a.client.close();
  await b.client.close();
  const closedHealth = await fetch(`http://127.0.0.1:${daemon.port}/health`).then((r) => r.json());
  assert.equal(closedHealth.sessions, 0, "closing clients must release their daemon sessions");

} finally {
  await daemon.close();
}

// ── By default the daemon serves adb ──────────────────────────────────
// Separate daemon rather than a flag on the one above: the gate is a
// construction-time decision, and this proves both sides of it.
const armed = await startDaemon({
  port: 0,
  phoneTransportFactory: makeFakePhoneTransport,
  log: () => {},
});

try {
  const c = await connectHttpClient(armed.port, "client-c");
  const tools = await c.client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["adb", "codedroid_status", "echo"],
    "the daemon merges the host-side adb tool into tools/list",
  );

  const armedHealth = await fetch(`http://127.0.0.1:${armed.port}/health`).then((r) =>
    r.json(),
  );
  assert.equal(armedHealth.adbToolEnabled, true, "/health must advertise the armed state");

  // The phone can't describe a tool it never sees, so the daemon appends a short
  // line about it — otherwise agents never learn there is a second channel. The
  // detail lives in the tool description; the handshake is size-capped.
  const armedInstructions = c.client.getInstructions();
  assert.ok(
    armedInstructions.startsWith(FAKE_INSTRUCTIONS),
    "the phone's instructions must come first and stay unedited",
  );
  assert.match(armedInstructions, /`adb`/, "adb guidance must reach the client");
  assert.match(armedInstructions, /com\.codedroid\.app/, "agents must be told not to force-stop CodeDroid");
  const appendedBytes =
    Buffer.byteLength(armedInstructions, "utf8") - Buffer.byteLength(FAKE_INSTRUCTIONS, "utf8");
  assert.ok(
    appendedBytes <= 402, // 400-byte adb line + the "\n\n" separator
    `the daemon appended ${appendedBytes} bytes; the phone's 1,600 + this must stay under 2,000`,
  );

  await c.client.close();
  console.log("daemon.test.mjs: ALL PASS");
} finally {
  await armed.close();
}
