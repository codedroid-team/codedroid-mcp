/**
 * AdbPhoneTransport against a fake phone on a real TCP socket — no adb, no phone.
 *
 * The fake adb answers `forward tcp:0` with the port of a local server that plays the phone's
 * side: read the hello line, answer it, then serve MCP as newline-delimited JSON-RPC (the SDK's
 * stdio framing over the socket), as CodeDroid's mcp/McpServer does.
 *
 * Run: node test/adb-transport.test.mjs
 */
import assert from "node:assert/strict";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdbPhoneTransport, PhoneDeniedError, PhoneUnavailableError, PROTOCOL } from "../src/adb-transport.js";
import { VERSION } from "../src/version.js";

const IDENTITY = () => ({ id: "host-1", name: "test-mbp" });

/** A phone that answers the hello with [reply] (null: never answers; "close": hangs up). */
async function fakePhone(reply) {
  const hellos = [];
  const server = net.createServer((socket) => {
    if (reply === "close") return socket.destroy();
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      hellos.push(JSON.parse(buffer.slice(0, newline)));
      if (reply === null) return;
      socket.write(JSON.stringify(reply) + "\n");
      if (reply.type !== "approved") return socket.end();
      const phone = new Server({ name: "codedroid", version: "1.0" }, { capabilities: { tools: {} }, instructions: "PHONE" });
      phone.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "get_screen", inputSchema: { type: "object", properties: {} } }],
      }));
      phone.setRequestHandler(CallToolRequestSchema, async () => ({
        // Long enough to arrive in several TCP chunks.
        content: [{ type: "text", text: "x".repeat(300_000) }],
      }));
      phone.connect(new StdioServerTransport(socket, socket));
    };
    socket.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, hellos, port: server.address().port };
}

/** A fake adb whose forward points at [port]; [extra] answers anything else. */
function fakeAdb(port, extra = []) {
  const calls = [];
  const adb = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    if (/^devices/.test(line)) return "List of devices attached\nSERIAL1 device model:Googlebook\n";
    if (/get-current-user/.test(line)) return "10\n";
    if (/forward tcp:0 localabstract:codedroid-mcp-10$/.test(line)) return `${port}\n`;
    if (/forward --remove/.test(line)) return "";
    for (const [pattern, answer] of extra) if (pattern.test(line)) return answer;
    throw new Error(`unexpected adb ${line}`);
  };
  adb.calls = calls;
  return adb;
}

// ── Approved: MCP flows both ways, and the forward goes on close ─────
{
  const phone = await fakePhone({ type: "approved", proto: 1, app_version: "1.0" });
  const adb = fakeAdb(phone.port);
  const transport = new AdbPhoneTransport({ adb, env: { CODEDROID_MCP_CLIENT: "Claude Code" }, identity: IDENTITY });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  assert.deepEqual(transport.device, { serial: "SERIAL1", user: 10, socket: "codedroid-mcp-10" });
  assert.deepEqual(phone.hellos[0], {
    type: "hello", proto: PROTOCOL, bridge: VERSION, host_id: "host-1", host: "test-mbp", platform: process.platform, client: "Claude Code",
  });
  assert.equal(client.getInstructions(), "PHONE");
  assert.equal((await client.listTools()).tools[0].name, "get_screen");
  const result = await client.callTool({ name: "get_screen", arguments: {} });
  assert.equal(result.content[0].text.length, 300_000, "a reply split across TCP chunks is reassembled");
  await client.close();
  assert.ok(adb.calls.includes(`-s SERIAL1 forward --remove tcp:${phone.port}`), "the forward is removed");
  phone.server.close();
}

// ── Denied: the phone's reason reaches the user ───────────────────────
{
  const phone = await fakePhone({ type: "denied", reason: "Not allowed on the phone. Try again in 60 s." });
  const adb = fakeAdb(phone.port);
  const transport = new AdbPhoneTransport({ adb, env: {}, identity: IDENTITY });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneDeniedError && /Not allowed on the phone/.test(e.message));
  assert.equal(phone.hellos[0].client, "", "no client is guessed");
  assert.ok(adb.calls.some((c) => c.includes("forward --remove")));
  phone.server.close();
}

// ── Nothing listening: adb hangs up, and the bridge says why ──────────
{
  const phone = await fakePhone("close");
  const adb = fakeAdb(phone.port, [[/pm path/, ""]]);
  const transport = new AdbPhoneTransport({ adb, env: {}, identity: IDENTITY });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneUnavailableError && /CodeDroid is not installed on SERIAL1/.test(e.message));
  phone.server.close();
}

// ── Nobody taps Allow: it gives up, saying what to do ─────────────────
{
  const phone = await fakePhone(null);
  const adb = fakeAdb(phone.port);
  const transport = new AdbPhoneTransport({ adb, env: {}, identity: IDENTITY, approvalTimeoutMs: 200 });
  await assert.rejects(transport.start(), (e) => e instanceof PhoneUnavailableError && /tap Allow/.test(e.message));
  phone.server.close();
}

// ── No device: adb's own state, before any forward ────────────────────
{
  const adb = async (args) => (args[0] === "devices" ? "List of devices attached\n" : assert.fail(args.join(" ")));
  const transport = new AdbPhoneTransport({ adb, env: {}, identity: IDENTITY });
  await assert.rejects(transport.start(), /No Android device on adb/);
}

console.log("adb-transport.test.mjs: ALL PASS");
