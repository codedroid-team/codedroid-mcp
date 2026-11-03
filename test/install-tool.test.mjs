/**
 * install_apk against a scripted phone: the pieces it sends, and what it does when the link drops,
 * the phone refuses, or the install outlasts a call.
 *
 * Run: node test/install-tool.test.mjs
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInstallTool } from "../src/install-tool.js";
import { Phones } from "../src/phones.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-install-")));
const apkBytes = Buffer.concat([Buffer.from("PK"), randomBytes(2_500_000)]);
fs.mkdirSync(path.join(dir, "out"));
const apk = path.join(dir, "out", "app.apk");
fs.writeFileSync(apk, apkBytes);
const sha256 = createHash("sha256").update(apkBytes).digest("hex");

const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (error, message, hint) => ({ ...reply({ success: false, error, message, hint }), isError: true });
const INSTALLED = { installed: true, package: "com.example", version_name: "2", version_code: 2 };

/** The phone's end: holds what arrived, by offset, and answers commit once it is all there. */
function fakePhones(overrides = {}) {
  const phone = { held: Buffer.alloc(0), calls: [], commits: 0, chunkSizes: [] };
  phone.request = async ({ params: { name, arguments: args } }) => {
    phone.calls.push(name);
    const override = overrides[name]?.(args, phone);
    if (override) return override;
    if (name === "install_begin") return reply({ offset: phone.held.length });
    if (name === "install_write") {
      const data = Buffer.from(args.data, "base64");
      phone.chunkSizes.push(data.length);
      if (args.offset === phone.held.length) phone.held = Buffer.concat([phone.held, data]);
      return reply({ offset: phone.held.length });
    }
    if (name === "install_commit") {
      phone.commits++;
      assert.equal(createHash("sha256").update(phone.held).digest("hex"), args.sha256, "commit must follow the whole file");
      return reply(INSTALLED);
    }
    return reply(INSTALLED);
  };
  return phone;
}

const tool = (phones, extra = {}) => createInstallTool({ phones, cwd: dir, jobs: new Map(), retryDelayMs: 1, ...extra });
const read = (result) => JSON.parse(result.content[0].text);
const failOnce = (name, message) => {
  let failed = false;
  return {
    [name]: () => {
      if (failed) return null;
      failed = true;
      throw new Error(message);
    },
  };
};

try {
  // ── The whole file arrives in small pieces, and the answer says what went in ──
  {
    const phones = fakePhones();
    const result = await tool(phones).handler({ path: apk });
    assert.equal(result.isError, undefined);
    assert.deepEqual(read(result), INSTALLED);
    assert.deepEqual(phones.held, apkBytes);
    assert.ok(phones.chunkSizes.every((size) => size <= 1024 * 1024), "pieces stay well under the relay's frame limit");
  }

  // ── A relative path starts from the client's directory ───────────────
  {
    const phones = fakePhones();
    assert.deepEqual(read(await tool(phones).handler({ path: "out/app.apk" })), INSTALLED);
  }
  for (const cwd of [null, os.homedir(), "/"]) {
    const phones = fakePhones();
    const result = await tool(phones, { cwd }).handler({ path: "out/app.apk" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no project directory/);
    assert.equal(phones.calls.length, 0);
    assert.deepEqual(read(await tool(fakePhones(), { cwd }).handler({ path: apk })), INSTALLED, "an absolute path needs none");
  }

  // ── A bad path costs no upload ───────────────────────────────────────
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a zip");
  fs.writeFileSync(path.join(dir, "empty.apk"), "");
  for (const zip of ["app.aab", "secrets.zip"]) fs.writeFileSync(path.join(dir, zip), "PK");
  for (const [args, pattern] of [
    [{ path: "missing.apk" }, /cannot read.*ENOENT/],
    [{ path: "notes.txt" }, /not an APK/],
    [{ path: "app.aab" }, /not an APK/],
    [{ path: "secrets.zip" }, /not an APK/],
    [{ path: "empty.apk" }, /not an APK/],
    [{ path: "out" }, /not an APK/],
    [{}, /must be the path/],
    [undefined, /must be the path/],
  ]) {
    const phones = fakePhones();
    const result = await tool(phones).handler(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, pattern);
    assert.equal(phones.calls.length, 0);
  }

  // ── A phone unreachable from the start says so, rather than "still working" ──
  {
    const phones = new Phones({ pairings: () => [], createManager: () => assert.fail("nothing is paired") });
    const result = await tool(phones, { waitMs: 500, retryDelayMs: 1000 }).handler({ path: apk });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not paired/);
  }
  {
    const phones = fakePhones({ install_begin: () => { throw new Error("CodeDroid on the phone is not connected: denied"); } });
    const result = await tool(phones).handler({ path: apk });
    assert.equal(result.isError, true);
    assert.deepEqual(phones.calls, ["install_begin"]);
  }

  // ── The link drops mid-upload: it carries on from what the phone holds ─
  {
    const phones = fakePhones(failOnce("install_write", "MCP error -32000: Connection closed"));
    assert.deepEqual(read(await tool(phones).handler({ path: apk })), INSTALLED);
    assert.deepEqual(phones.held, apkBytes);
  }

  // ── A piece lost on the way: the phone says where to carry on ─────────
  {
    let lost = false;
    const phones = fakePhones({
      install_write: (args, phone) => {
        if (lost || args.offset === 0) return null;
        lost = true;
        return reply({ offset: phone.held.length - 1000 });
      },
    });
    const result = await tool(phones).handler({ path: apk });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.deepEqual(phones.held.subarray(0, 1000), apkBytes.subarray(0, 1000));
  }

  // ── The link drops during commit, as when CodeDroid replaces itself ───
  {
    const phones = fakePhones(failOnce("install_commit", "MCP error -32000: Connection closed"));
    assert.deepEqual(read(await tool(phones).handler({ path: apk })), INSTALLED);
    assert.equal(phones.calls.filter((name) => name === "install_commit").length, 2, "the phone's commit is safe to repeat");
  }

  // ── A phone that is still installing is asked again ───────────────────
  {
    let asked = 0;
    const phones = fakePhones({
      install_commit: () => reply({ installed: false, status: "installing" }),
      install_status: () => (++asked < 3 ? reply({ installed: false, status: "installing" }) : null),
    });
    const started = Date.now();
    assert.deepEqual(read(await tool(phones, { retryDelayMs: 20 }).handler({ path: apk })), INSTALLED);
    assert.equal(asked, 3);
    assert.ok(Date.now() - started >= 50, "it waits between asking");
  }

  // ── The phone's refusal comes back as it is, and stops the install ────
  {
    const phones = fakePhones({ install_begin: () => refusal("needs_setup", "Not allowed yet.", "Allow it.") });
    const result = await tool(phones).handler({ path: apk });
    assert.equal(result.isError, true);
    assert.deepEqual(read(result), { installed: false, error: "needs_setup", message: "Not allowed yet.", hint: "Allow it." });
    assert.deepEqual(phones.calls, ["install_begin"]);
  }
  {
    const phones = fakePhones({ install_commit: () => refusal("install_failed", "INSTALL_FAILED_VERSION_DOWNGRADE", "Raise versionCode.") });
    const result = await tool(phones).handler({ path: apk });
    assert.equal(result.isError, true);
    assert.equal(read(result).message, "INSTALL_FAILED_VERSION_DOWNGRADE");
    assert.equal(phones.calls.at(-1), "install_commit", "a refusal is not repeated");
  }

  // ── An app from before this tool: say to update it ────────────────────
  {
    const phones = fakePhones({ install_begin: () => refusal("bad_args", "No tool named install_begin", "Call one from tools/list.") });
    const result = await tool(phones).handler({ path: apk });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /too old.*Update CodeDroid/);
  }

  // ── Anything but a lost link fails at once ────────────────────────────
  {
    const phones = fakePhones({ install_begin: () => { throw new Error("2 phones are paired; say which"); } });
    const result = await tool(phones).handler({ path: apk });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /2 phones are paired/);
    assert.equal(phones.calls.length, 1);
  }

  // ── An install that outlasts the call: the next call picks it up ──────
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const jobs = new Map();
    const phones = fakePhones();
    const plain = phones.request;
    phones.request = async (request) => {
      if (request.params.name === "install_commit") await gate;
      return plain(request);
    };
    const waiting = tool(phones, { jobs, waitMs: 50 });
    const first = read(await waiting.handler({ path: apk }));
    assert.equal(first.installed, false);
    assert.equal(first.total_bytes, apkBytes.length);
    assert.match(first.hint, /call install_apk again/i);
    assert.ok(["sending", "installing"].includes(first.status));

    release();
    const otherSession = tool(phones, { jobs, waitMs: 2000 });
    assert.deepEqual(read(await otherSession.handler({ path: apk })), INSTALLED, "another session can pick it up");
    assert.equal(phones.calls.filter((name) => name === "install_begin").length, 1, "and nothing is sent twice");
    assert.equal(jobs.size, 0);
  }

  // ── The device reaches the phone request, which routes on it ──────────
  {
    const devices = new Set();
    const phones = fakePhones({ install_begin: (args) => void devices.add(args.device) });
    await tool(phones).handler({ path: apk, device: "Pixel" });
    assert.deepEqual([...devices], ["Pixel"]);
  }

  assert.equal(sha256.length, 64);
  console.log("install-tool.test.mjs: ALL PASS");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
