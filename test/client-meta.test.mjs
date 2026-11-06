/**
 * A tool call reaches the phone saying whose it is, whichever proxies it passed: the stdio shim's
 * client when it came through the shim, not the shim.
 *
 * Run: node test/client-meta.test.mjs
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildProxyServer, CLIENT_INFO_META_KEY, SESSION_META_KEY, SHIM_CLIENT_NAME } from "../src/proxy-core.js";

async function connected(clientInfo, server) {
  const client = new Client(clientInfo);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return client;
}

const received = [];
const phone = new Server({ name: "fake-phone", version: "1" }, { capabilities: { tools: {} } });
phone.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
phone.setRequestHandler(CallToolRequestSchema, async (request) => {
  received.push(request.params);
  return { content: [{ type: "text", text: "ok" }] };
});
const phoneClient = await connected({ name: "codedroid-mcp-daemon", version: "1" }, phone);

/** A proxy to [backend], and a client of it. */
async function proxied(clientInfo, backend) {
  const proxy = await buildProxyServer({ getClient: async () => backend, name: "proxy", version: "1" });
  return connected(clientInfo, proxy);
}

/** The _meta the phone receives for a call from [client]. */
async function metaOf(client, call = { name: "tap", arguments: {} }) {
  await client.callTool(call);
  return received.at(-1)._meta;
}

const direct = await proxied({ name: "cursor", version: "2.0" }, phoneClient);
const first = await metaOf(direct, { name: "tap", arguments: { node: 3 } });
assert.deepEqual(first[CLIENT_INFO_META_KEY], { name: "cursor", version: "2.0" }, "a client of the daemon names itself");
assert.match(first[SESSION_META_KEY], /^ses_[0-9a-f-]{36}$/);
assert.deepEqual(received.at(-1).arguments, { node: 3 }, "nothing is added to the tool's arguments");
assert.equal((await metaOf(direct))[SESSION_META_KEY], first[SESSION_META_KEY], "one client, one session");

// Through a second proxy, as the stdio shim is in front of the daemon.
const daemonLink = await proxied({ name: SHIM_CLIENT_NAME, version: "1" }, phoneClient);
const viaShim = await proxied({ name: "claude-code", version: "2.1.0" }, daemonLink);
const shimmed = await metaOf(viaShim);
assert.deepEqual(shimmed[CLIENT_INFO_META_KEY], { name: "claude-code", version: "2.1.0" }, "the shim's client, not the shim");
assert.notEqual(shimmed[SESSION_META_KEY], first[SESSION_META_KEY], "another client, another session");

// A shim from before these stamps, in front of a newer daemon: no client to name, but its own session.
const oldShim = await metaOf(daemonLink);
assert.equal(oldShim[CLIENT_INFO_META_KEY], undefined, "the shim is not named as the client");
assert.match(oldShim[SESSION_META_KEY], /^ses_/);

// Only the name and version go: clientInfo can also hold a title, icons and a website.
const detailed = await proxied({ name: "codex", version: "1", title: "Codex", websiteUrl: "https://example.com" }, phoneClient);
assert.deepEqual((await metaOf(detailed))[CLIENT_INFO_META_KEY], { name: "codex", version: "1" });

// What a client sends in _meta itself still arrives, its own clientInfo included.
const sent = await metaOf(direct, { name: "tap", arguments: {}, _meta: { progressToken: "p1", [CLIENT_INFO_META_KEY]: { name: "real", version: "9" } } });
assert.equal(sent.progressToken, "p1");
assert.deepEqual(sent[CLIENT_INFO_META_KEY], { name: "real", version: "9" });

// A long-lived client's next chat is a new session; a pause under the limit is not.
const realNow = Date.now;
const start = realNow();
const at = (minutes) => { Date.now = () => start + minutes * 60_000; };
try {
  at(0);
  const session = (await metaOf(direct))[SESSION_META_KEY];
  at(29);
  assert.equal((await metaOf(direct))[SESSION_META_KEY], session, "still the same chat");
  at(59);
  assert.notEqual((await metaOf(direct))[SESSION_META_KEY], session, "30 minutes idle starts a new session");
} finally {
  Date.now = realNow;
}

console.log("client-meta.test.mjs: ALL PASS");
process.exit(0);
