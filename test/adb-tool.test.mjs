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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const result = await tool.handler({ command: "shell dumpsys" });
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
  const result = await tool.handler({ command: "shell dumpsys" });
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
  assert.match(tool.instructions, /com\.codedroid\.agent/, "the handshake line must carry the don't-force-stop rule");
  assert.match(tool.definition.description, /com\.codedroid\.agent/, "so must the description, where the detail lives");
  assert.equal(tool.definition.annotations.destructiveHint, true, "clients must ask before running adb");
}

// ── The client's directory, not the daemon's, resolves relative paths ──
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-adb-")));
const outside = path.join(os.homedir(), ".codedroid-adb-test-outside");
{
  const run = makeRunner();
  await createAdbTool({ run, env: {}, cwd: project }).handler({ command: "install app/app-debug.apk" });
  assert.equal(run.calls[0].opts.cwd, project);
}

// ── Without a project directory, relative paths are refused, not guessed ──
for (const cwd of [null, os.homedir(), "/", path.join(project, "gone")]) {
  for (const command of ["install app-debug.apk", "pull /sdcard/x", "push a.txt /sdcard/"]) {
    const run = makeRunner();
    const result = await createAdbTool({ run, env: {}, cwd }).handler({ command });
    assert.equal(result.isError, true, `${cwd}: ${command}`);
    assert.match(result.content[0].text, /no project directory/);
    assert.equal(run.calls.length, 0);
  }
  const run = makeRunner();
  const result = await createAdbTool({ run, env: {}, cwd }).handler({ command: "install /any/where/app-debug.apk" });
  assert.equal(result.isError, undefined, "install takes any absolute path");
}

// ── Host files stay out of reach, and other adb servers with them ──────
for (const command of [
  `pull /sdcard/x ${outside}`,
  `push ${outside} /sdcard/`,
  "push ../../secret /sdcard/",
  `-s X pull -a /sdcard/x ${outside}`,
  `bugreport ${outside}`,
  `backup -f ${outside} -all`,
  `restore ${outside}`,
  "push -- -/../../../secret /sdcard/",
  "pull -- /sdcard/x -/../../../outside",
  `push -- -z ${outside} /sdcard/`,
  `pull -- /sdcard/x -z ${outside}`,
  `push -z lz4 -- ${outside} /sdcard/`,
  "bugreport -/../../../outside",
  "restore -/../../../outside",
  `backup -f ok.ab -f ${outside} -all`,
  "--one-device X nodaemon server",
  "--reply-fd 5 nodaemon server",
  "fork-server server",
  "-H 10.0.0.5 devices",
  "-H10.0.0.5 devices",
  "-P 5038 devices",
  "-L tcp:10.0.0.5:5037 devices",
  "keygen /tmp/key",
  "nodaemon server",
  "-a start-server",
  "-a devices",
  "start-server",
  "--one-device X start-server",
  "kill-server",
  "attach",
  "detach",
  "sync",
  "sync system",
  "-s X sync",
]) {
  const run = makeRunner();
  const result = await createAdbTool({ run, env: {}, cwd: project }).handler({ command });
  assert.equal(result.isError, true, command);
  assert.equal(run.calls.length, 0, `${command} must not reach adb`);
}
for (const command of [
  "pull /sdcard/x",
  "pull /sdcard/x out/x",
  `pull -z lz4 /sdcard/x ${path.join(project, "x")}`,
  `pull /sdcard/x ${path.join(os.tmpdir(), "x")}`,
  "push --sync a.txt /sdcard/",
  "pull -- /sdcard/x out/x",
  "pull -a -- /sdcard/-x/y",
  "pull -z lz4 -- /sdcard/x out/x",
  "push -- -z a.txt /sdcard/",
  "backup -f",
  "backup -f a.ab -f b.ab -all",
  "shell cat /etc/hosts",
  "reverse tcp:8081 tcp:8081",
  "pull -a /sdcard/x out/x",
  "reconnect offline",
]) {
  const run = makeRunner();
  const result = await createAdbTool({ run, env: {}, cwd: project }).handler({ command });
  assert.equal(result.isError, undefined, command);
  assert.equal(run.calls.length, 1, command);
}

// ── A symlink in the project does not lead out of it ────────────────────
{
  fs.symlinkSync(os.homedir(), path.join(project, "link"));
  const run = makeRunner();
  const result = await createAdbTool({ run, env: {}, cwd: project }).handler({ command: "pull /sdcard/x link/x" });
  assert.equal(result.isError, true);
  assert.equal(run.calls.length, 0);
}
fs.rmSync(project, { recursive: true, force: true });

// ── adb is found outside a GUI client's PATH ───────────────────────────
{
  const run = makeRunner((file) => {
    if (file !== path.join("/sdk", "platform-tools", "adb")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { stdout: "found", stderr: "" };
  });
  const result = await createAdbTool({ run, env: { ANDROID_HOME: "/sdk" } }).handler({ command: "devices" });
  assert.equal(result.content[0].text, "found");
  assert.deepEqual(run.calls.map((call) => call.file), ["adb", path.join("/sdk", "platform-tools", "adb")]);
}
{
  const run = makeRunner(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
  await createAdbTool({ run, env: { ADB: "/mine/adb" } }).handler({ command: "devices" });
  assert.deepEqual(run.calls.map((call) => call.file), ["/mine/adb"], "ADB is the only place when set");
}

// ── Failures say what to do ─────────────────────────────────────────────
const failing = (stderr, extra = {}) => makeRunner((file, args) => {
  if (args[0] === "devices") return { stdout: "List of devices attached\nA device\nB device", stderr: "" };
  throw Object.assign(new Error(`Command failed: adb\n${stderr}`), { stdout: "", stderr, code: 1, ...extra });
});
for (const [stderr, hint] of [
  ["adb: no devices/emulators found", /USB debugging/],
  ["error: device 'X' not found", /USB debugging/],
  ["error: device unauthorized.", /accept the USB debugging prompt/],
  ["error: device offline", /reconnect/],
  ["adb: failed to install a.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: x]", /signature.*ask the user/],
  ["adb: failed to install a.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]", /-d/],
  ["adb: failed to install a.apk: Failure [INSTALL_FAILED_TEST_ONLY]", /-t/],
  ["adb: failed to install a.apk: Failure [INSTALL_FAILED_USER_RESTRICTED]", /Developer options/],
]) {
  const result = await createAdbTool({ run: failing(stderr), env: {} }).handler({ command: "install /a.apk" });
  assert.equal(result.isError, true, stderr);
  assert.ok(result.content[0].text.includes(stderr), "adb's own message stays");
  assert.match(result.content[0].text, hint);
}
{
  const result = await createAdbTool({ run: failing("adb: more than one device/emulator"), env: {} }).handler({ command: "shell ls" });
  assert.match(result.content[0].text, /-s <serial>[^]*A device\nB device/, "several phones: lists them");
}

// ── Older platform-tools exit 0 from a failed install ───────────────────
{
  const run = makeRunner(() => ({ stdout: "Failure [INSTALL_FAILED_OLDER_SDK]", stderr: "" }));
  const result = await createAdbTool({ run, env: {} }).handler({ command: "install /a.apk" });
  assert.equal(result.isError, true);
}

// ── A timeout says so, keeps the output, and transfers get longer ───────
{
  const run = failing("", { killed: true, signal: "SIGTERM", code: null, stdout: "partial" });
  const result = await createAdbTool({ run, env: {} }).handler({ command: "logcat", timeout_s: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /partial\nadb was stopped after 2s/);
  assert.equal(run.calls[0].opts.timeout, 2000);
}
{
  const run = makeRunner();
  const tool = createAdbTool({ run, env: {} });
  await tool.handler({ command: "install /a.apk" });
  await tool.handler({ command: "shell ls" });
  assert.deepEqual(run.calls.map((call) => call.opts.timeout), [300_000, 60_000]);
}

{
  const run = failing("", { killed: true, signal: "SIGTERM", code: null, stdout: "x".repeat(MAX_OUTPUT_CHARS + 1) });
  const result = await createAdbTool({ run, env: {} }).handler({ command: "logcat", timeout_s: 2 });
  assert.match(result.content[0].text, /truncated[^]*adb was stopped after 2s/, "long output must not push out the reason");
}

// ── Too much output is not a failure; the server notice is not output ───
{
  const run = makeRunner(() => {
    throw Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "x".repeat(MAX_OUTPUT_CHARS + 1), stderr: "" });
  });
  const result = await createAdbTool({ run, env: {} }).handler({ command: "logcat -d" });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /truncated/);
}
{
  const run = makeRunner(() => ({ stdout: "List", stderr: "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n" }));
  const result = await createAdbTool({ run, env: {} }).handler({ command: "devices" });
  assert.equal(result.content[0].text, "List");
}

// ── stdin closes, so a bare `shell` cannot wait on it ───────────────────
{
  let ended = false;
  const run = () => Object.assign(Promise.resolve({ stdout: "", stderr: "" }), { child: { stdin: { end: () => { ended = true; } } } });
  await createAdbTool({ run, env: {} }).handler({ command: "shell" });
  assert.equal(ended, true);
}

// ── An attached -s picks the device too ─────────────────────────────────
{
  const run = makeRunner();
  await createAdbTool({ run, env: { CODEDROID_SERIAL: "ABC" } }).handler({ command: "-sOTHER shell ls" });
  assert.deepEqual(run.calls[0].args, ["-sOTHER", "shell", "ls"]);
}

// ── logcat keeps its newest lines, at a line boundary ───────────────────
for (const command of ["logcat -d", "shell logcat -d | grep x"]) {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const run = makeRunner(() => ({ stdout: lines, stderr: "" }));
  const { content: [{ text }] } = await createAdbTool({ run, env: {} }).handler({ command });
  assert.match(text, /^…\(truncated, \d+ earlier chars\)\nline \d+ x+\n/, command);
  assert.ok(text.endsWith("line 4999 " + "x".repeat(20)), command);
  assert.ok(text.length <= MAX_OUTPUT_CHARS + 50, command);
}
// Past the buffer only the oldest output is left, and the reply must say so.
{
  const run = makeRunner(() => {
    throw Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "old\n", stderr: "" });
  });
  const result = await createAdbTool({ run, env: {} }).handler({ command: "logcat -d" });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /newest lines are missing/);
}

// ── Binary output is never returned as damaged text ─────────────────────
{
  const run = makeRunner(() => ({ stdout: "�PNG\r\n\u001a\n\0\0\0\rIHDR", stderr: "" }));
  const result = await createAdbTool({ run, env: {} }).handler({ command: "exec-out screencap -p" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /binary[^]*save_to/);
  assert.ok(!result.content[0].text.includes("IHDR"));
}

// ── save_to writes stdout's exact bytes, within the same roots as pull ──
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-save-")));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]);
  const run = makeRunner(() => ({ stdout: bytes, stderr: Buffer.from("* daemon started successfully\n") }));
  const tool = createAdbTool({ run, env: {}, cwd: dir });
  const result = await tool.handler({ command: "exec-out screencap -p", save_to: "shots/a.png" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, `Saved 8 bytes to ${path.join(dir, "shots/a.png")}`);
  assert.deepEqual(fs.readFileSync(path.join(dir, "shots/a.png")), bytes);
  assert.equal(run.calls[0].opts.encoding, "buffer");

  for (const [save_to, why] of [[path.join(os.homedir(), ".codedroid-save-test"), /can only use local files/], ["../../../../escape", /can only use local files/], ["", /must be a file path/], [7, /must be a file path/]]) {
    const refusedRun = makeRunner();
    const refused = await createAdbTool({ run: refusedRun, env: {}, cwd: dir }).handler({ command: "exec-out screencap -p", save_to });
    assert.equal(refused.isError, true, String(save_to));
    assert.match(refused.content[0].text, why);
    assert.equal(refusedRun.calls.length, 0);
  }
  const relative = await createAdbTool({ run, env: {}, cwd: null }).handler({ command: "exec-out screencap -p", save_to: "a.png" });
  assert.match(relative.content[0].text, /no project directory/);

  // Nothing is written from a command that failed, wrote nothing, or wrote too much.
  const empty = await createAdbTool({ run: makeRunner(() => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("nope") })), env: {}, cwd: dir }).handler({ command: "exec-out x", save_to: "empty.bin" });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /wrote nothing[^]*nope/);
  const failed = await createAdbTool({
    run: makeRunner(() => { throw Object.assign(new Error("Command failed"), { code: 1, stdout: bytes, stderr: Buffer.from("error: device offline") }); }),
    env: {},
    cwd: dir,
  }).handler({ command: "exec-out x", save_to: "failed.bin" });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /device offline[^]*reconnect/);
  assert.ok(!failed.content[0].text.includes("PNG"));
  const huge = await createAdbTool({
    run: makeRunner(() => { throw Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: bytes, stderr: Buffer.alloc(0) }); }),
    env: {},
    cwd: dir,
  }).handler({ command: "exec-out x", save_to: "huge.bin" });
  assert.equal(huge.isError, true);
  assert.match(huge.content[0].text, /nothing was saved/);
  for (const name of ["empty.bin", "failed.bin", "huge.bin"]) assert.ok(!fs.existsSync(path.join(dir, name)), name);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── device finds the paired phone's adb serial by its model ─────────────
{
  const phones = { select: (selector) => {
    if (selector === "nope") throw new Error('No paired phone is "nope".');
    return [{ pairing: { device: { model: selector === "Samsung" ? "samsung SM-S918B" : selector === "Twin" ? "Google Pixel 7" : selector === "Pro" ? "Google Pixel 9 Pro" : "Google Pixel 9" } } }];
  } };
  const listing = [
    "List of devices attached",
    "AAA device usb:1 product:tokay model:Pixel_9 device:tokay transport_id:1",
    "BBB device usb:2 product:dm3q model:SM_S918B device:dm3q transport_id:2",
    "CCC device product:panther model:Pixel_7 device:panther transport_id:3",
    "DDD device product:panther model:Pixel_7 device:panther transport_id:4",
    "EEE unauthorized usb:5 transport_id:5",
  ].join("\n");
  const makeTool = (env = {}) => {
    const run = makeRunner((file, args) => (args[0] === "devices" ? { stdout: listing, stderr: "" } : { stdout: "ok", stderr: "" }));
    return { run, tool: createAdbTool({ run, env, phones }) };
  };
  for (const [device, serial] of [["Pixel 9", "AAA"], ["Samsung", "BBB"]]) {
    const { run, tool } = makeTool({ CODEDROID_SERIAL: "ENV" });
    const result = await tool.handler({ command: "shell ls", device });
    assert.equal(result.isError, undefined, device);
    assert.deepEqual(run.calls.at(-1).args, ["-s", serial, "shell", "ls"], "device outranks CODEDROID_SERIAL");
  }
  {
    const { run, tool } = makeTool();
    await tool.handler({ command: "-s OTHER shell ls", device: "Pixel 9" });
    assert.deepEqual(run.calls.map((c) => c.args), [["-s", "OTHER", "shell", "ls"]], "-s in the command wins, with no lookup");
  }
  for (const [device, why] of [["Twin", /Several devices[^]*-s <serial>[^]*CCC/], ["Pro", /Google Pixel 9 Pro is not on this computer's adb[^]*AAA/], ["nope", /No paired phone/]]) {
    const { run, tool } = makeTool();
    const result = await tool.handler({ command: "shell ls", device });
    assert.equal(result.isError, true, device);
    assert.match(result.content[0].text, why);
    assert.ok(!run.calls.some((c) => c.args.includes("shell")), `${device}: must not run on a guessed phone`);
  }
  const lost = await createAdbTool({
    run: makeRunner(() => ({ stdout: "List of devices attached\n\n", stderr: "" })),
    env: {},
    phones,
  }).handler({ command: "shell ls", device: "Pixel 9" });
  assert.match(lost.content[0].text, /\(none\)[^]*USB debugging/);
}

// ── am instrument: a summary of the run, whatever am exited with ────────
const statusBlock = (test, code, stack) => [
  `INSTRUMENTATION_STATUS: class=com.x.FooTest`,
  `INSTRUMENTATION_STATUS: current=1`,
  `INSTRUMENTATION_STATUS: numtests=4`,
  ...(stack ? [`INSTRUMENTATION_STATUS: stack=${stack}`] : []),
  `INSTRUMENTATION_STATUS: stream=`,
  `INSTRUMENTATION_STATUS: test=${test}`,
  `INSTRUMENTATION_STATUS_CODE: ${code}`,
];
const am = "shell am instrument -w -r com.x.test/androidx.test.runner.AndroidJUnitRunner";
const instrumented = (output) => createAdbTool({ run: makeRunner(() => ({ stdout: output, stderr: "" })), env: {} }).handler({ command: am });
{
  const stack = "java.lang.AssertionError: boom\n\tat com.x.FooTest.b(FooTest.kt:9)\n\n";
  const result = await instrumented([
    ...statusBlock("a", 1), ...statusBlock("a", 0),
    ...statusBlock("b", 1), ...statusBlock("b", -2, stack),
    ...statusBlock("c", 1), ...statusBlock("c", -1, "java.lang.IllegalStateException: bad"),
    ...statusBlock("d", -3),
    "INSTRUMENTATION_RESULT: stream=", "", "Time: 1.5", "", "FAILURES!!!", "Tests run: 3,  Failures: 2", "",
    "INSTRUMENTATION_CODE: -1",
  ].join("\n"));
  const text = result.content[0].text;
  assert.equal(result.isError, undefined, "failed tests are a result, not a failed tool");
  assert.match(text, /^Instrumentation finished: 4 tests, 1 passed, 1 errored, 1 failed, 1 ignored, in 1\.5s\./);
  assert.match(text, /FAILED com\.x\.FooTest#b\njava\.lang\.AssertionError: boom\n\tat com\.x\.FooTest\.b\(FooTest\.kt:9\)/);
  assert.match(text, /ERRORED com\.x\.FooTest#c\njava\.lang\.IllegalStateException: bad/);
  assert.ok(!text.includes("INSTRUMENTATION_STATUS"), "the raw lines are gone");
}
{
  const result = await instrumented([...statusBlock("a", 1), ...statusBlock("a", 0), "INSTRUMENTATION_CODE: -1"].join("\n"));
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /finished: 1 test, 1 passed\.$/);
}
// am exits 0 from a crash: it must not read as a pass.
{
  const result = await instrumented([
    ...statusBlock("a", 1), ...statusBlock("a", 0), ...statusBlock("b", 1),
    "INSTRUMENTATION_RESULT: shortMsg=Process crashed.",
    "INSTRUMENTATION_RESULT: longMsg=java.lang.NullPointerException",
    "INSTRUMENTATION_CODE: 0",
  ].join("\n"));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /did not finish: Process crashed\. 1 of 4 tests ended \(1 passed\)\.\nWas running com\.x\.FooTest#b\.\njava\.lang\.NullPointerException\n[^]*logcat -d -b crash/);
}
{
  const result = await instrumented("INSTRUMENTATION_RESULT: stream=\n\nTime: 0\n\nOK (0 tests)\n\nINSTRUMENTATION_CODE: -1");
  assert.equal(result.isError, true, "no tests ran: not a pass");
  assert.match(result.content[0].text, /no tests ran[^]*OK \(0 tests\)/);
}
{
  const result = await instrumented("INSTRUMENTATION_FAILED: com.x.test/androidx.test.runner.AndroidJUnitRunner\nINSTRUMENTATION_STATUS: Error=Unable to find instrumentation info\nINSTRUMENTATION_STATUS_CODE: -1");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /did not start[^]*Unable to find[^]*pm list instrumentation/);
}
// Stopped at the timeout: says what ran, and why it ended.
{
  const run = makeRunner(() => {
    throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM", code: null, stderr: "", stdout: [...statusBlock("a", 1), ...statusBlock("a", 0), ...statusBlock("b", 1)].join("\n") });
  });
  const result = await createAdbTool({ run, env: {} }).handler({ command: am, timeout_s: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /did not finish[^]*Was running com\.x\.FooTest#b[^]*adb was stopped after 2s/);
}
// A long stack is cut; other commands and runs without -r are left as they are.
{
  const stack = Array.from({ length: 200 }, (_, i) => `\tat frame${i}`).join("\n");
  const { content: [{ text }] } = await instrumented([...statusBlock("a", 1), ...statusBlock("a", -2, `Boom\n${stack}`), "INSTRUMENTATION_CODE: -1"].join("\n"));
  assert.match(text, /frame28\n…\(171 more lines\)$/);
}
for (const [command, output] of [[am, "com.x.FooTest:.\n\nTime: 1\n\nOK (1 test)"], ["shell cat log.txt", "INSTRUMENTATION_CODE: -1"], [`${am} | grep STATUS_CODE`, "INSTRUMENTATION_STATUS_CODE: 1"]]) {
  const result = await createAdbTool({ run: makeRunner(() => ({ stdout: output, stderr: "" })), env: {} }).handler({ command });
  assert.equal(result.content[0].text, output, command);
}

console.log("adb-tool.test.mjs: ALL PASS");
