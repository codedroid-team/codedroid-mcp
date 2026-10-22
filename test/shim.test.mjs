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

const FAKE_INSTRUCTIONS = "FAKE PHONE INSTRUCTIONS";

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
    if (req.params.name === "get_task") await new Promise((resolve) => setTimeout(resolve, 300));
    return { content: [{ type: "text", text: `echo: ${req.params.arguments?.text}` }] };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  phone.connect(serverSide);
  return clientSide;
}

// Armed, so this also proves the daemon's locally-appended adb guidance and
// tool survive the SECOND proxy hop. The shim registers no local tools of its
// own — it must forward whatever the daemon advertises, instructions included.
// A throwaway home shared with the spawned shim (via HOME) so both read the one daemon token file.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-daemon-"));

const daemon = await startDaemon({
  port: 0,
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
    /com\.codedroid\.app/,
    "the do-not-force-stop-CodeDroid rule must survive both hops",
  );

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["adb", "codedroid_status", "echo"],
    "the shim forwards the daemon's local tool without re-registering it",
  );

  const result = await client.callTool({
    name: "echo",
    arguments: { text: "via-shim" },
  });
  assert.equal(result.content[0].text, "echo: via-shim");

  const order = [];
  await Promise.all([
    client.callTool({ name: "get_task", arguments: { task_id: "t1" } }).then(() => order.push("get_task")),
    new Promise((resolve) => setTimeout(resolve, 20))
      .then(() => client.callTool({ name: "echo", arguments: { text: "meanwhile" } }))
      .then(() => order.push("echo")),
  ]);
  assert.deepEqual(order, ["echo", "get_task"], "the shim's HTTP connection must not block concurrent calls");

  await client.close();
  const health = await fetch(`http://127.0.0.1:${daemon.port}/health`).then((r) => r.json());
  assert.equal(health.sessions, 0, "closing stdio must release the shim's daemon session");
  console.log("shim.test.mjs: ALL PASS");
} finally {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
}
