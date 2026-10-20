/**
 * adb tool unit test — no real adb, no phone.
 *
 * createAdbTool() takes its runner as a dependency precisely so this file can
 * assert on the argv adb *would* have received, and on how the handler shapes
 * adb's output back into an MCP result.
 *
 * Run: node test/adb-tool.test.mjs
 */
import assert from "node:assert/strict";
import { adbArgv, createAdbTool, MAX_OUTPUT_CHARS } from "../src/adb-tool.js";

/** Records every invocation and replays a canned result. */
function makeRunner(impl) {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return impl ? impl(file, args, opts) : { stdout: "ok", stderr: "" };
  };
  run.calls = calls;
  return run;
}

// ── An empty or missing command must never reach adb ──────────────────
for (const args of [undefined, {}, { command: "" }, { command: "   " }, { command: 42 }]) {
  const run = makeRunner();
  const tool = createAdbTool({ run, env: {} });
  const result = await tool.handler(args);
  assert.equal(result.isError, true, `must reject ${JSON.stringify(args)}`);
  assert.match(result.content[0].text, /non-empty string/);
  assert.equal(run.calls.length, 0, "adb must not be invoked for a blank command");
}

// ── Host-side words split on whitespace; no serial anywhere → no -s ───
{
  const run = makeRunner();
  const tool = createAdbTool({ run, env: {} });
  await tool.handler({ command: "  logcat   -d -t 300 *:E " });
  assert.deepEqual(run.calls[0].args, ["logcat", "-d", "-t", "300", "*:E"]);
  assert.equal(run.calls[0].file, "adb");
}

// ── Quotes group a host-side path with spaces into one argument ────────
assert.deepEqual(adbArgv('install -r -g "/Users/me/My App/app-debug.apk"'), ["install", "-r", "-g", "/Users/me/My App/app-debug.apk"]);
assert.deepEqual(adbArgv("push 'a b.txt' /sdcard/"), ["push", "a b.txt", "/sdcard/"]);

// ── After shell, the phone's shell gets the line as written ────────────
// adb joins shell arguments with spaces and does not escape them (as ssh does), so one argument
// holding the line is what the phone's shell would get anyway, quotes and whitespace kept.
assert.deepEqual(adbArgv("  shell   pm list packages -3 "), ["shell", "pm list packages -3"]);
assert.deepEqual(adbArgv('shell "dumpsys window" | grep  mCurrentFocus'), ["shell", '"dumpsys window" | grep  mCurrentFocus']);
assert.deepEqual(adbArgv("shell -t ls -l"), ["shell", "-t", "ls -l"], "adb shell's own flags stay flags");
assert.deepEqual(adbArgv("-s X exec-out screencap -p"), ["-s", "X", "exec-out", "screencap -p"]);
assert.deepEqual(adbArgv("-s shell shell ls"), ["-s", "shell", "shell", "ls"], "an option's value is not the subcommand");

// ── CODEDROID_SERIAL (or ANDROID_SERIAL) prepends -s <serial> ─────────
for (const env of [{ CODEDROID_SERIAL: "ABC123" }, { ANDROID_SERIAL: "ABC123" }]) {
  const run = makeRunner();
  const tool = createAdbTool({ run, env });
  await tool.handler({ command: "logcat -d" });
  assert.deepEqual(run.calls[0].args, ["-s", "ABC123", "logcat", "-d"]);
}

// ── A command that picks its device itself is left alone ──────────────
for (const command of ["-s OTHER logcat -d", "-d shell ls", "-e devices"]) {
  const run = makeRunner();
  const tool = createAdbTool({ run, env: { CODEDROID_SERIAL: "ABC123" } });
  await tool.handler({ command });
  assert.equal(run.calls[0].args.filter((a) => a === "ABC123").length, 0, command);
}

// ── Metacharacters never reach a HOST shell ────────────────────────────
// execFile runs adb directly. The phone's shell does chain them (`adb shell a; b`), which is
// inherent to adb shell; the boundary execFile defends is this computer.
{
  const run = makeRunner();
  const tool = createAdbTool({ run, env: {} });
  await tool.handler({ command: "shell ls; rm -rf /" });
  assert.deepEqual(run.calls[0].args, ["shell", "ls; rm -rf /"]);
  assert.equal(run.calls[0].opts.shell, undefined);
}

// ── stdout and stderr are combined ────────────────────────────────────
{
  const run = makeRunner(() => ({ stdout: "line-out", stderr: "line-err" }));
  const tool = createAdbTool({ run, env: {} });
  const result = await tool.handler({ command: "devices" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, "line-out\nline-err");
}

// ── Silent success still returns something the model can read ─────────
{
  const run = makeRunner(() => ({ stdout: "", stderr: "" }));
  const tool = createAdbTool({ run, env: {} });
  const result = await tool.handler({ command: "shell true" });
  assert.equal(result.content[0].text, "(no output)");
}

// ── Output past MAX_OUTPUT_CHARS is truncated, not dumped ─────────────
{
  const overflow = 500;
  const run = makeRunner(() => ({ stdout: "x".repeat(MAX_OUTPUT_CHARS + overflow), stderr: "" }));
  const tool = createAdbTool({ run, env: {} });
  const result = await tool.handler({ command: "logcat -d" });
  const text = result.content[0].text;
  assert.ok(text.length < MAX_OUTPUT_CHARS + overflow, "must be shorter than the raw output");
  assert.match(text, /…\(truncated, \d+ more chars\)$/);
  assert.equal(text.slice(0, MAX_OUTPUT_CHARS), "x".repeat(MAX_OUTPUT_CHARS));
}

// ── A failing adb returns isError, and does not throw past the boundary ─
{
  const run = makeRunner(() => {
    const err = new Error("Command failed: adb devices");
    err.stdout = "";
    err.stderr = "error: device unauthorized";
    throw err;
  });
  const tool = createAdbTool({ run, env: {} });
  const result = await tool.handler({ command: "devices" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /device unauthorized/);
  assert.match(result.content[0].text, /Command failed/);
}

// ── No adb on this computer: say how to get it ────────────────────────
{
  const run = makeRunner(() => {
    const err = new Error("spawn adb ENOENT");
    err.code = "ENOENT";
    throw err;
  });
  const tool = createAdbTool({ run, env: {} });
  const result = await tool.handler({ command: "devices" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /adb was not found.*platform-tools/);
}

// ── A non-Error rejection is still reported, not swallowed ────────────
{
  const run = makeRunner(() => {
    throw "adb not found";
  });
  const tool = createAdbTool({ run, env: {} });
  const result = await tool.handler({ command: "devices" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /adb not found/);
}

// ── Truncation applies to the error path too ──────────────────────────
{
  const run = makeRunner(() => {
    const err = new Error("boom");
    err.stderr = "e".repeat(MAX_OUTPUT_CHARS + 100);
    throw err;
  });
  const tool = createAdbTool({ run, env: {} });
  const result = await tool.handler({ command: "logcat" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /…\(truncated, \d+ more chars\)$/);
}

// ── Handshake budget: the phone owns 1,600 bytes, this line at most 400 ──
// Claude Code keeps ~2 KB of instructions and cuts the end, which is where this
// text lands. Over budget, the safety rule below is what gets cut.
{
  const tool = createAdbTool({ env: {} });
  const bytes = Buffer.byteLength(tool.instructions, "utf8");
  assert.ok(bytes <= 400, `adb handshake line is ${bytes} bytes; budget is 400`);
  assert.match(tool.instructions, /com\.codedroid\.app/, "the handshake line must carry the don't-force-stop rule");
  assert.match(tool.definition.description, /com\.codedroid\.app/, "so must the description, where the detail lives");
  assert.equal(tool.definition.annotations.destructiveHint, true, "clients must ask before running adb");
}

console.log("adb-tool.test.mjs: ALL PASS");
