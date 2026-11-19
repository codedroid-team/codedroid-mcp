/**
 * Flows: a session recorded as Maestro YAML, a Maestro flow parsed and replayed through tool calls
 * against a scripted phone, with Maestro's semantics where CodeDroid can keep them and a plain
 * failure where it cannot.
 *
 * Run: node test/flow.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASSERT_TIMEOUT_MS, Recorder, flowToYaml, parseFlow, runFlow, stepsForCall, substitute } from "../src/flow.js";

const SCREEN = [
  "app: Contacts (com.android.contacts) 1080x2400 keyboard: hidden",
  "[1] FrameLayout (540,1200)",
  '  [2] Button "Add" id=com.android.contacts:id/fab clickable (980,2200)',
  '  [3] EditText "First name" editable (540,500)',
  '  [4] TextView "All contacts" (540,100)',
].join("\n");

/** A phone that answers from [script]: name → (args) → result; records every call. */
function fakePhone(script = {}) {
  const calls = [];
  const ok = (text) => ({ content: [{ type: "text", text }] });
  const call = async (name, args = {}) => {
    calls.push({ name, args });
    if (script[name]) return script[name](args, calls);
    if (name === "get_screen") return ok(SCREEN);
    if (name === "wait_for") return ok(JSON.stringify({ met: true }));
    if (name === "take_screenshot") return { content: [{ type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" }] };
    return ok(`done\n${JSON.stringify({ after: { screen_changed: true, app: "com.android.contacts" } })}`);
  };
  return { call, calls };
}

// ── Recording: calls become steps; nodes become selectors; failures and reads do not ──
{
  const recorder = new Recorder();
  assert.throws(() => recorder.stop(), /Not recording/);
  recorder.start({ name: "TC-01" });
  assert.throws(() => recorder.start(), /Already recording "TC-01"/);
  const observe = (name, args, result = {}) => recorder.observe({ name, args, result, lastScreen: SCREEN });
  observe("get_screen", {});
  observe("open_app", { package: "com.android.contacts" });
  observe("tap", { node: 2 });
  observe("tap", { node: 3 });
  observe("type_text", { text: "Ada", clear: false });
  observe("tap", { node: 4 });
  observe("tap", { node: 99 }, { isError: true, content: [{ type: "text", text: '{"error":"stale_node"}' }] });
  observe("tap", { x: 10, y: 20 });
  observe("long_press", { text: "Ada" });
  observe("swipe", { x1: 540, y1: 1800, x2: 540, y2: 600, duration_ms: 400 });
  observe("press_key", { key: "home" });
  observe("wait_for", { gone_text: "Saving", timeout_ms: 5000 });
  observe("device_info", {});
  const flow = recorder.stop();
  assert.equal(flow.steps, 10);
  assert.equal(flow.skipped, 0);
  const parsed = parseFlow(flow.yaml, { file: "TC-01.yaml" });
  assert.equal(parsed.appId, "com.android.contacts");
  assert.equal(parsed.name, "TC-01");
  assert.deepEqual(
    parsed.steps.map((s) => [s.command, s.value]),
    [
      ["launchApp", "com.android.contacts"],
      ["tapOn", "Add"],
      ["tapOn", "First name"],
      ["inputText", "Ada"],
      ["tapOn", "All contacts"],
      ["tapOn", { point: "10,20" }],
      ["longPressOn", "Ada"],
      ["swipe", { start: "540,1800", end: "540,600", duration: 400 }],
      ["pressKey", "Home"],
      ["extendedWaitUntil", { notVisible: "Saving", timeout: 5000 }],
      // device_info is a read.
    ].concat([]),
  );
  assert.match(flow.yaml, /^# Recorded by CodeDroid MCP .*\n# Maestro's format/);
}

// ── What Maestro cannot say stays in the file as a comment, not as a step ──
{
  const steps = [
    ...stepsForCall("wait_for", { package: "com.x" }),
    ...stepsForCall("tap", { node: 7 }, { lastScreen: SCREEN }),
    "back",
    ...stepsForCall("clipboard", { text: "x" }),
  ];
  const yaml = flowToYaml({ appId: "com.x", steps });
  assert.match(yaml, /# wait_for package com\.x: Maestro has no wait for an app/);
  assert.match(yaml, /# tap by node 7: the element could not be resolved/);
  assert.match(yaml, /\n- back\n/);
  assert.match(yaml, /# clipboard set to "x": Maestro has no clipboard command\n$/);
  assert.deepEqual(parseFlow(yaml).steps.map((s) => s.command), ["back"]);
  assert.deepEqual(parseFlow(flowToYaml({ steps: [] })).steps, [], "a flow with no steps is still a flow");
}

// ── type_text: clear and submit are Maestro steps around inputText ──────────
assert.deepEqual(stepsForCall("type_text", { text: "x", submit: true }), ["eraseText", { inputText: "x" }, { pressKey: "Enter" }]);
assert.deepEqual(stepsForCall("type_text", { text: "x", clear: false }), [{ inputText: "x" }]);
assert.deepEqual(stepsForCall("open_app", { package: "com.x", activity: ".Main" }), [{ launchApp: { appId: "com.x", arguments: { activity: ".Main" } } }]);
assert.deepEqual(stepsForCall("run_task", { goal: "add Ada" }), [{ codedroidTask: "add Ada" }]);
assert.deepEqual(stepsForCall("take_screenshot", {}, { screenshotIndex: 3 }), [{ takeScreenshot: "step-3" }]);
assert.deepEqual(stepsForCall("open_url", { url: "https://x/y" }), [{ openLink: "https://x/y" }]);
assert.deepEqual(stepsForCall("dismiss_keyboard", {}), ["hideKeyboard"]);
assert.deepEqual(stepsForCall("scroll_until", { text: "About", direction: "up" }), [{ scrollUntilVisible: { element: { text: "About" }, direction: "UP" } }]);
assert.deepEqual(stepsForCall("scroll_until", { text: "About" }), [{ scrollUntilVisible: { element: { text: "About" }, direction: "DOWN" } }]);
assert.match(stepsForCall("alert", { action: "accept" })[0].comment, /^alert accept/);
assert.deepEqual(stepsForCall("notifications", {}), [], "a read is not a step");
assert.deepEqual(stepsForCall("logs", { level: "E" }), []);

// ── Parsing Maestro's own files ─────────────────────────────────────────────
{
  const flow = parseFlow(`appId: com.example\nenv:\n  USER: ada\n---\n- launchApp\n- tapOn: "Sign in"\n- tapOn:\n    id: "email"\n    optional: true\n- inputText: \${USER}@example.com\n- assertVisible:\n    text: "Welcome"\n`);
  assert.equal(flow.appId, "com.example");
  assert.deepEqual(flow.env, { USER: "ada" });
  assert.deepEqual(flow.steps.map((s) => s.command), ["launchApp", "tapOn", "tapOn", "inputText", "assertVisible"]);
  assert.equal(flow.steps[2].optional, true);
  assert.equal(flow.steps[0].value, null);
  assert.deepEqual(parseFlow("- back\n- tapOn: x\n").steps.map((s) => s.command), ["back", "tapOn"], "a list alone is a flow");
  assert.throws(() => parseFlow("appId: x\n---\n- tapOn: a\n  inputText: b\n  c: d\n  e: f\n"), /command 1 is not a command/);
  assert.throws(() => parseFlow("just: a map\n"), /expected a config document/);
  assert.throws(() => parseFlow("- [unclosed\n"), /not YAML|unclosed|flow sequence/i);
  assert.equal(substitute("hi ${USER}, ${NOPE}", { USER: "ada" }), "hi ada, ${NOPE}");
  assert.deepEqual(substitute({ text: "${A}", list: ["${A}"] }, { A: 1 }), { text: "1", list: ["1"] });
}

// ── Replay: each command becomes the right tool call ────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-flow-"));
  try {
    const phone = fakePhone({
      get_task: (args, calls) => ({ content: [{ type: "text", text: JSON.stringify(calls.filter((c) => c.name === "get_task").length < 2 ? { status: "running" } : { status: "done", success: true, reply: "Added Ada\nmore" }) }] }),
      run_task: () => ({ content: [{ type: "text", text: JSON.stringify({ task_id: "t1" }) }] }),
    });
    fs.writeFileSync(path.join(dir, "setup.yaml"), "appId: com.other\n---\n- launchApp\n- back\n");
    const flow = parseFlow(
      [
        "appId: com.android.contacts",
        "env: {NAME: Ada}",
        "---",
        "- launchApp",
        "- launchApp: com.second",
        "- tapOn: Add",
        "- tapOn: {id: first_name}",
        "- eraseText",
        "- inputText: ${NAME}",
        "- inputText: more",
        "- pressKey: Enter",
        "- back",
        "- pressKey: Home",
        "- swipe: {start: '540,1800', end: '540,600', duration: 300}",
        "- swipe: {direction: UP}",
        "- scroll",
        "- longPressOn: {point: '10,20'}",
        "- assertVisible: All contacts",
        "- assertNotVisible: Saving",
        "- extendedWaitUntil: {visible: {id: fab}, timeout: 1000}",
        "- waitForAnimationToEnd: {timeout: 10}",
        "- takeScreenshot: after-save",
        "- runFlow: setup.yaml",
        "- repeat: {times: 2, commands: [{tapOn: Add}]}",
        "- codedroidTask: add a contact",
        "- scrollUntilVisible: {element: {text: All contacts}, direction: DOWN}",
      ].join("\n"),
    );
    const run = await runFlow(flow, phone.call, { baseDir: dir, screenshotDir: path.join(dir, "shots") });
    assert.ok(run.ok, JSON.stringify(run.steps.filter((s) => s.status !== "pass")));
    assert.deepEqual(run.steps.map((s) => s.status), new Array(flow.steps.length).fill("pass"));
    const sent = phone.calls.filter((c) => c.name !== "get_screen").map((c) => [c.name, c.args]);
    assert.deepEqual(sent, [
      ["open_app", { package: "com.android.contacts" }],
      ["open_app", { package: "com.second" }],
      ["tap", { text: "Add" }],
      ["tap", { resource_id: "first_name" }],
      ["type_text", { text: "Ada", clear: true }],
      ["type_text", { text: "more", clear: false }],
      ["press_key", { key: "enter" }],
      ["press_key", { key: "back" }],
      ["press_key", { key: "home" }],
      ["swipe", { x1: 540, y1: 1800, x2: 540, y2: 600, duration_ms: 300 }],
      ["swipe", { x1: 540, y1: 1800, x2: 540, y2: 600 }],
      ["swipe", { x1: 540, y1: 1800, x2: 540, y2: 600 }],
      ["long_press", { x: 10, y: 20 }],
      ["wait_for", { text: "All contacts", timeout_ms: ASSERT_TIMEOUT_MS }],
      ["wait_for", { gone_text: "Saving", timeout_ms: ASSERT_TIMEOUT_MS }],
      // extendedWaitUntil by id polls get_screen from here (no call to the phone but get_screen).
      ["take_screenshot", {}],
      ["open_app", { package: "com.other" }],
      ["press_key", { key: "back" }],
      ["tap", { text: "Add" }],
      ["tap", { text: "Add" }],
      ["run_task", { goal: "add a contact" }],
      ["get_task", { task_id: "t1", wait_s: 50 }],
      ["get_task", { task_id: "t1", wait_s: 50 }],
    ]);
    assert.ok(fs.existsSync(path.join(dir, "shots", "after-save.jpg")), "takeScreenshot writes the image");
    assert.equal(run.steps.find((s) => s.command === "codedroidTask").detail, "Added Ada");
    assert.equal(run.steps.find((s) => s.command === "scrollUntilVisible").detail, "after 0 swipes");
    assert.match(run.screen, /^app: Contacts/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── A failing step stops the run; an optional one only warns ────────────────
{
  const phone = fakePhone({
    tap: (args) => (args.text === "Missing" ? { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "not_found", message: "No element Missing", hint: "Read the screen." }) }] } : { content: [{ type: "text", text: "ok" }] }),
    wait_for: () => ({ content: [{ type: "text", text: JSON.stringify({ met: false }) }] }),
  });
  const flow = parseFlow("- tapOn:\n    text: Missing\n    optional: true\n- tapOn: Add\n- assertVisible: Gone\n- tapOn: Never\n");
  const run = await runFlow(flow, phone.call);
  assert.equal(run.ok, false);
  assert.deepEqual(run.steps.map((s) => [s.status, s.command]), [["warn", "tapOn"], ["pass", "tapOn"], ["fail", "assertVisible"]]);
  assert.equal(run.steps[0].detail, "tap: No element Missing Read the screen.");
  assert.match(run.steps[2].detail, /"Gone" is not on the screen after 7 s/);
  assert.ok(!phone.calls.some((c) => c.args.text === "Never"), "steps after the failure do not run");
}

// ── Commands outside the subset fail where they are, naming the subset ──────
{
  for (const [yaml, message] of [
    ["- copyTextFrom: {text: x}\n", /copyTextFrom is not supported on CodeDroid\. Supported: launchApp, tapOn/],
    ["- openLink:\n    link: https://x\n    autoVerify: true\n", /autoVerify and browser are not supported/],
    ["- launchApp:\n    appId: com.x\n    clearState: true\n", /clearState is not supported/],
    ["- tapOn:\n    index: 2\n", /index is not supported on CodeDroid; select by text or id/],
    ["- tapOn:\n    point: 50%,50%\n", /percentages are not supported/],
    ["- pressKey: Lock\n", /presses Enter, Home, Back or Recents, not Lock/],
    ["- repeat:\n    while:\n      visible: x\n    commands: []\n", /needs times/],
    ["- runFlow:\n    file: nowhere.yaml\n", /cannot read .*nowhere\.yaml/],
    ["- swipe: {direction: SIDEWAYS}\n", /direction must be UP, DOWN, LEFT or RIGHT/],
  ]) {
    const run = await runFlow(parseFlow(yaml), fakePhone().call);
    assert.equal(run.ok, false, yaml);
    assert.match(run.steps[0].detail, message);
  }
}

// ── An id matches whole, or after its package; never as a piece of another id ──
{
  const pass = await runFlow(parseFlow("- assertVisible: {id: fab}\n- assertVisible: {id: 'com.android.contacts:id/fab'}\n"), fakePhone().call);
  assert.ok(pass.ok, JSON.stringify(pass.steps));
  const part = await runFlow(parseFlow("- assertNotVisible: {id: ab}\n"), fakePhone().call);
  assert.ok(part.ok, "'ab' is not the id 'fab'");
}

// ── codedroidTask that asks a question fails the run ────────────────────────
{
  const phone = fakePhone({
    run_task: () => ({ content: [{ type: "text", text: JSON.stringify({ task_id: "t2" }) }] }),
    get_task: () => ({ content: [{ type: "text", text: JSON.stringify({ status: "running", question: "Which account?" }) }] }),
  });
  const run = await runFlow(parseFlow("- codedroidTask: do it\n"), phone.call);
  assert.equal(run.ok, false);
  assert.match(run.steps[0].detail, /asked a question nobody can answer in a flow: Which account\?/);
}

console.log("flow.test.mjs: ALL PASS");
