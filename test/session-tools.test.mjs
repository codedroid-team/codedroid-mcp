/**
 * The daemon's session tools against a fake phone over real Streamable HTTP: get_screen's options,
 * batch with the screen held, and a flow recorded in one session then replayed from its file.
 *
 * Run: node test/session-tools.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CLIENT_CWD_HEADER } from "../src/daemon-transport.js";
import { startDaemon } from "../src/daemon.js";

const SCREEN_A = [
  "app: Contacts (com.android.contacts) 1080x2400 keyboard: hidden",
  "[1] FrameLayout (540,1200)",
  '  [2] Button "Add" id=com.android.contacts:id/fab clickable (980,2200)',
  '  [3] TextView "All contacts" (540,100)',
].join("\n");
const SCREEN_B = [
  "app: Contacts (com.android.contacts) 1080x2400 keyboard: shown",
  "[1] FrameLayout (540,1200)",
  '  [4] EditText "First name" editable focused (540,500)',
  '  [5] Button "Save" clickable (980,100)',
].join("\n");

const phoneCalls = [];
let inFlight = 0;
let overlapped = false;
let screen = SCREEN_A;
const ok = (text) => ({ content: [{ type: "text", text }] });
const after = (changed) => `\n${JSON.stringify({ after: { screen_changed: changed, app: "com.android.contacts" } })}`;

function fakePhoneTransport() {
  const phone = new Server({ name: "fake-phone", version: "1" }, { capabilities: { tools: {} }, instructions: "PHONE" });
  phone.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "get_screen", inputSchema: { type: "object", properties: { screenshot: { type: "boolean" } } } },
      { name: "tap", inputSchema: { type: "object", properties: { node: { type: "integer" }, text: { type: "string" } } } },
      { name: "type_text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "wait_for", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "open_app", inputSchema: { type: "object", properties: { package: { type: "string" } } } },
      { name: "take_screenshot", inputSchema: { type: "object", properties: {} } },
      { name: "get_task", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  phone.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const { name, arguments: args = {} } = params;
    phoneCalls.push({ name, args });
    inFlight++;
    if (inFlight > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    switch (name) {
      case "get_screen":
        return args.screenshot ? { content: [{ type: "text", text: screen }, { type: "image", data: "aGk=", mimeType: "image/jpeg" }] } : ok(screen);
      case "tap":
        if (args.text === "Nope") return { ...ok(JSON.stringify({ error: "not_found", message: "No element Nope", hint: "Read the screen." })), isError: true };
        if (args.node === 2 || args.text === "Add") screen = SCREEN_B;
        if (args.node === 5 || args.text === "Save") screen = SCREEN_A;
        return ok(`tapped${after(true)}`);
      case "type_text":
        return ok(`typed${after(false)}`);
      case "wait_for":
        return ok(JSON.stringify({ met: screen.includes(args.text) }));
      case "open_app":
        screen = SCREEN_A;
        return ok(`opened${after(true)}`);
      case "take_screenshot":
        return { content: [{ type: "image", data: "aGk=", mimeType: "image/jpeg" }] };
      default:
        return ok("{}");
    }
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  phone.connect(serverSide);
  return clientSide;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-session-home-"));
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-session-project-")));
const daemon = await startDaemon({
  port: 0,
  pairings: () => [{ server: "https://orchestrator.example", host_id: "h1", token: "t1", device: { id: "phone-1", model: "Pixel 5" } }],
  phoneTransportFactory: fakePhoneTransport,
  enableAdbTool: false,
  home,
});
const text = (result) => result.content.find((c) => c.type === "text")?.text ?? "";

async function connect(cwd = project) {
  const client = new Client({ name: "session-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${daemon.authToken}`, [CLIENT_CWD_HEADER]: encodeURIComponent(cwd) } },
    }),
  );
  return client;
}

try {
  const a = await connect();

  // ── tools/list: get_screen gained its options; the loop tools are marked to load upfront ──
  const tools = (await a.listTools()).tools;
  const getScreen = tools.find((t) => t.name === "get_screen");
  assert.deepEqual(Object.keys(getScreen.inputSchema.properties).sort(), ["device", "diff", "interactive_only", "max_depth", "screenshot"]);
  assert.equal(getScreen._meta["anthropic/alwaysLoad"], true);
  assert.equal(tools.find((t) => t.name === "tap")._meta["anthropic/alwaysLoad"], true);
  assert.equal(tools.find((t) => t.name === "codedroid_status")._meta["anthropic/alwaysLoad"], true);
  assert.equal(tools.find((t) => t.name === "get_task")._meta, undefined, "a tool outside the loop stays deferrable");
  assert.equal(tools.find((t) => t.name === "run_flow").inputSchema.properties.device.type, "string");

  // ── get_screen: options stay on this computer; the phone sees only its own arguments ──
  phoneCalls.length = 0;
  const plain = await a.callTool({ name: "get_screen", arguments: {} });
  assert.equal(text(plain), SCREEN_A);
  const interactive = await a.callTool({ name: "get_screen", arguments: { interactive_only: true, screenshot: true } });
  assert.deepEqual(phoneCalls.at(-1).args, { screenshot: true }, "interactive_only never reaches the phone");
  assert.deepEqual(text(interactive).split("\n").slice(1, -1), ['  [2] Button "Add" id=com.android.contacts:id/fab clickable (980,2200)']);
  assert.equal(interactive.content[1].type, "image", "the screenshot still comes");
  const same = await a.callTool({ name: "get_screen", arguments: { diff: true } });
  assert.match(text(same), /^app: Contacts.*\nScreen unchanged since your last get_screen: 3 elements/);
  await a.callTool({ name: "tap", arguments: { node: 2 } });
  const changed = await a.callTool({ name: "get_screen", arguments: { diff: true } });
  assert.match(text(changed), /keyboard: shown\n2 added, 2 removed, 1 unchanged:\n\+ \[4\] EditText "First name".*\n\+ \[5\] Button "Save".*\n- Button "Add".*\n- TextView "All contacts"/);

  // ── A second session has its own first read ────────────────────────────────
  const b = await connect();
  assert.equal(text(await b.callTool({ name: "get_screen", arguments: { diff: true } })), SCREEN_B);

  // ── batch: steps run in order with the screen held; a failure stops it ──
  phoneCalls.length = 0;
  overlapped = false;
  const [batch] = await Promise.all([
    a.callTool({
      name: "batch",
      arguments: {
        steps: [
          { tool: "tap", arguments: { text: "Save" } },
          { tool: "wait_for", arguments: { text: "All contacts" } },
          { tool: "get_screen", arguments: { interactive_only: true } },
          { tool: "tap", arguments: { text: "Nope" } },
          { tool: "type_text", arguments: { text: "never" } },
        ],
      },
    }),
    // Another session taps while the batch runs: it must wait for the whole batch.
    new Promise((r) => setTimeout(r, 5)).then(() => b.callTool({ name: "tap", arguments: { text: "Add" } })),
  ]);
  assert.equal(batch.isError, true);
  const lines = text(batch).split("\n");
  assert.deepEqual(
    lines.filter((l) => l.startsWith("#")),
    ['#1 tap {"text":"Save"}', '#2 wait_for {"text":"All contacts"}', '#3 get_screen {"interactive_only":true}', '#4 tap {"text":"Nope"} FAILED'],
  );
  assert.ok(lines.includes('{"met":true}'));
  assert.ok(lines.some((l) => /^  \[2\] Button "Add"/.test(l)), "get_screen inside a batch honours its options");
  assert.ok(!lines.some((l) => l.includes("All contacts\" (540,100)")), "the plain label is filtered out");
  assert.match(lines.at(-1), /^Stopped at step 4; 1 step did not run\. Read the screen before going on\.$/);
  assert.equal(overlapped, false, "no call overlapped on the phone");
  const order = phoneCalls.map((c) => `${c.name}:${c.args.text ?? ""}`);
  assert.deepEqual(order.slice(0, 4), ["tap:Save", "wait_for:All contacts", "get_screen:", "tap:Nope"], "the batch ran uninterrupted");
  assert.equal(order[4], "tap:Add", "the other session's tap came after the batch");
  assert.ok(!order.includes("type_text:never"));
  assert.match(text(await a.callTool({ name: "batch", arguments: { steps: [{ tool: "take_screenshot" }] } })), /must name one of/);
  assert.match(text(await a.callTool({ name: "batch", arguments: { steps: [{ tool: "get_screen", arguments: { screenshot: true } }] } })), /screenshots are not allowed/);

  // ── record, then replay from the file ──────────────────────────────────────
  screen = SCREEN_A;
  assert.match(text(await a.callTool({ name: "record_start", arguments: { name: "TC-01" } })), /^Recording "TC-01"/);
  assert.equal((await a.callTool({ name: "record_start", arguments: {} })).isError, true, "one recording at a time");
  await a.callTool({ name: "open_app", arguments: { package: "com.android.contacts" } });
  await a.callTool({ name: "get_screen", arguments: {} });
  await a.callTool({ name: "tap", arguments: { node: 2 } });
  await a.callTool({ name: "get_screen", arguments: { interactive_only: true } });
  await a.callTool({ name: "tap", arguments: { node: 4 } });
  await a.callTool({ name: "type_text", arguments: { text: "Ada" } });
  await a.callTool({ name: "tap", arguments: { text: "Nope" } });
  await a.callTool({ name: "tap", arguments: { text: "Save" } });
  await a.callTool({ name: "wait_for", arguments: { text: "All contacts" } });
  await b.callTool({ name: "tap", arguments: { text: "Add" } });
  screen = SCREEN_A;
  const outside = await a.callTool({ name: "record_stop", arguments: { save_to: path.join(os.homedir(), "flow.yaml") } });
  assert.equal(outside.isError, true);
  assert.match(text(outside), /^record_stop: 'save_to' can only use local files in .*\. Use a path there\.$/);
  const stopped = await a.callTool({ name: "record_stop", arguments: { save_to: "e2e/flows/TC-01.yaml" } });
  assert.equal(stopped.isError, undefined, text(stopped));
  const file = path.join(project, "e2e", "flows", "TC-01.yaml");
  assert.match(text(stopped), new RegExp(`^Wrote ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: 7 steps\\.`));
  const yaml = fs.readFileSync(file, "utf8");
  assert.ok(!yaml.includes("Nope"), "a failed tap is not a step");
  assert.ok(!yaml.includes("Add\n- tapOn: Add"), "another session's actions are not steps");
  assert.deepEqual(
    yaml.split("---\n")[1].trim().split("\n"),
    ["- launchApp: com.android.contacts", "- tapOn: Add", "- tapOn: First name", "- eraseText", "- inputText: Ada", "- tapOn: Save", "- extendedWaitUntil:", "    visible: All contacts"],
  );

  phoneCalls.length = 0;
  const replayed = await a.callTool({ name: "run_flow", arguments: { path: "e2e/flows/TC-01.yaml" } });
  assert.equal(replayed.isError, undefined, text(replayed));
  assert.match(text(replayed), /^Passed: 7 steps of .*TC-01\.yaml\.\nPASS 1\. launchApp com\.android\.contacts\nPASS 2\. tapOn Add \(screen_changed: true\)/);
  assert.deepEqual(
    phoneCalls.filter((c) => c.name !== "get_screen").map((c) => [c.name, c.args]),
    [
      ["open_app", { package: "com.android.contacts" }],
      ["tap", { text: "Add" }],
      ["tap", { text: "First name" }],
      ["type_text", { text: "Ada", clear: true }],
      ["tap", { text: "Save" }],
      ["wait_for", { text: "All contacts", timeout_ms: 7000 }],
    ],
  );

  // ── Inline YAML, a failure, and the screen at the failure ──────────────────
  const failed = await a.callTool({ name: "run_flow", arguments: { yaml: "- tapOn: Save\n- tapOn: Nope\n- tapOn: Add\n" } });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /^Failed at step 2\.\nPASS 1\. tapOn Save \(screen_changed: true\)\nFAIL 2\. tapOn Nope \(tap: No element Nope Read the screen\.\)\n\nScreen now:\napp: Contacts/);
  assert.match(text(await a.callTool({ name: "run_flow", arguments: {} })), /pass path or yaml/);
  assert.match(text(await a.callTool({ name: "run_flow", arguments: { path: "missing.yaml" } })), /ENOENT|no such file/i);
  assert.match(text(await a.callTool({ name: "run_flow", arguments: { yaml: "- openLink: x\n" } })), /FAIL 1\. openLink x \(openLink is not supported on CodeDroid/);

  // ── A client with no project directory needs absolute paths ────────────────
  const c = await connect(os.homedir());
  await c.callTool({ name: "record_start", arguments: {} });
  assert.match(text(await c.callTool({ name: "record_stop", arguments: { save_to: "flow.yaml" } })), /is relative and this client has no project directory/);
  // A recording that never opened an app says the flow starts wherever the phone is.
  assert.match(text(await c.callTool({ name: "record_stop", arguments: {} })), /^Recorded 0 steps; no launchApp, so it starts wherever the phone is \(call record_start before open_app/);
  await c.close();

  await a.close();
  await b.close();
  console.log("session-tools.test.mjs: ALL PASS");
} finally {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
}
