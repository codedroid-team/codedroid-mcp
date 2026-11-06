/**
 * Full-chain shim test — no phone required.
 *
 * stdio client (this test) ── spawns `codedroid-mcp` shim ── HTTP ── daemon
 * (in-process, fake phone) ── InMemoryTransport ── fake phone server.
 *
 * Run: node test/shim.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startDaemon } from "../src/daemon.js";
import { CLIENT_INFO_META_KEY, SESSION_META_KEY } from "../src/proxy-core.js";

const FAKE_INSTRUCTIONS = "FAKE PHONE INSTRUCTIONS";
let lastCallMeta;

/** How many times the phone got `tap`. The first never answers, as if its answer were lost. */
let taps = 0;

function makeFakePhoneTransport() {
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
    lastCallMeta = req.params._meta;
    if (req.params.name === "get_task") await new Promise((resolve) => setTimeout(resolve, 300));
    if (req.params.name === "tap" && ++taps === 1) await new Promise(() => {});
    return { content: [{ type: "text", text: `echo: ${req.params.arguments?.text}` }] };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  phone.connect(serverSide);
  return clientSide;
}

/** The one phone these tests pair with; the daemon reads no host.json. */
const PAIRING = { server: "https://orchestrator.example", host_id: "h1", token: "t1", device: { id: "phone-1", model: "Pixel 5" } };

// Armed, so this also proves the daemon's locally-appended adb guidance and
// tool survive the SECOND proxy hop. The shim registers no local tools of its
// own — it must forward whatever the daemon advertises, instructions included.
// A throwaway home shared with the spawned shim (via HOME) so both read the one daemon token file.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-daemon-"));

let daemon = await startDaemon({
  port: 0,
  pairings: () => [PAIRING],
  phoneTransportFactory: makeFakePhoneTransport,
  log: () => {},
  enableAdbTool: true,
  home,
});

const indexPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

const client = new Client({ name: "shim-test-client", version: "0.0.1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [indexPath, `--port=${daemon.port}`],
  // HOME points the shim at the same ~/.codedroid, so readDaemonToken() finds this daemon's token.
  env: { ...process.env, HOME: home },
  stderr: "ignore",
});

try {
  await client.connect(transport);

  const instructions = client.getInstructions();
  assert.ok(
    instructions.startsWith(FAKE_INSTRUCTIONS),
    "instructions must survive the double proxy (shim → daemon → phone)",
  );
  assert.match(
    instructions,
    /`adb`/,
    "the daemon's local adb guidance must reach a stdio client too",
  );
  assert.match(
    instructions,
    /com\.codedroid\.agent/,
    "the do-not-force-stop-CodeDroid rule must survive both hops",
  );

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["adb", "codedroid_devices", "codedroid_status", "echo", "install_apk"],
    "the shim forwards the daemon's local tool without re-registering it",
  );

  const result = await client.callTool({
    name: "echo",
    arguments: { text: "via-shim" },
  });
  assert.equal(result.content[0].text, "echo: via-shim");
  assert.equal(lastCallMeta[CLIENT_INFO_META_KEY].name, "shim-test-client", "the phone hears of the shim's client, past both proxies");
  assert.equal(lastCallMeta[CLIENT_INFO_META_KEY].version, "0.0.1");
  assert.match(lastCallMeta[SESSION_META_KEY], /^ses_/);

  const order = [];
  await Promise.all([
    client.callTool({ name: "get_task", arguments: { task_id: "t1" } }).then(() => order.push("get_task")),
    new Promise((resolve) => setTimeout(resolve, 20))
      .then(() => client.callTool({ name: "echo", arguments: { text: "meanwhile" } }))
      .then(() => order.push("echo")),
  ]);
  assert.deepEqual(order, ["echo", "get_task"], "the shim's HTTP connection must not block concurrent calls");

  // ── The daemon restarts under the shim: its session is gone, the IDE's is not ──
  const { port } = daemon;
  await daemon.close();
  daemon = await startDaemon({ port, pairings: () => [PAIRING], phoneTransportFactory: makeFakePhoneTransport, enableAdbTool: true, home });
  const afterRestart = await client.callTool({ name: "echo", arguments: { text: "after-restart" } });
  assert.equal(afterRestart.content[0].text, "echo: after-restart", "the shim opens a new daemon session and sends the call again");
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["adb", "codedroid_devices", "codedroid_status", "echo", "install_apk"]);

  // ── A tap in flight as the daemon restarts: the model is told, and it is not sent again ──
  const inFlight = client.callTool({ name: "tap", arguments: {} });
  while (taps === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  await daemon.close();
  daemon = await startDaemon({ port, pairings: () => [PAIRING], phoneTransportFactory: makeFakePhoneTransport, enableAdbTool: true, home });
  // Unqueued, unlike a tool call, which would wait behind the tap. Its lost session opens a new one.
  await client.listTools();
  const lostTap = await inFlight;
  assert.equal(lostTap.isError, true, "a tap whose answer was lost is a tool error");
  assert.match(lostTap.content[0].text, /may or may not have happened/);
  await client.callTool({ name: "echo", arguments: { text: "after-lost-tap" } });
  assert.equal(taps, 1, "the tap must not be replayed on the new session");

  // ── A reconnect that fails does not strand the shim: the next request tries again ──
  // What answers the port meanwhile drops the shim's session and refuses a new one (a legacy daemon).
  await daemon.close();
  const impostor = http.createServer((req, res) => {
    const legacy = req.url === "/health";
    res.writeHead(legacy ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(legacy ? { ok: true, service: "codedroid-mcp-daemon" } : { error: "Session not found" }));
  });
  await new Promise((resolve) => impostor.listen(port, "127.0.0.1", resolve));
  const refused = await client.callTool({ name: "echo", arguments: { text: "refused" } });
  assert.equal(refused.isError, true, "a reconnect that fails is a tool error");
  assert.match(refused.content[0].text, /authentication upgrade/);
  await new Promise((resolve) => impostor.close(resolve));
  daemon = await startDaemon({ port, pairings: () => [PAIRING], phoneTransportFactory: makeFakePhoneTransport, enableAdbTool: true, home });
  const recovered = await client.callTool({ name: "echo", arguments: { text: "recovered" } });
  assert.equal(recovered.content[0].text, "echo: recovered", "the next request opens a new daemon session");

  await client.close();
  const health = await fetch(`http://127.0.0.1:${daemon.port}/health`).then((r) => r.json());
  assert.equal(health.sessions, 0, "closing stdio must release the shim's daemon session");
  console.log("shim.test.mjs: ALL PASS");
} finally {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
}
