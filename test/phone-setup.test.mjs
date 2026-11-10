/**
 * setUpPhone: a phone on adb taken from nothing to paired, against a fake adb and a fake
 * get.codedroid.com and CodeDroid server. It never touches a real phone.
 *
 * Run: node test/phone-setup.test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHosts, saveHosts } from "../src/host.js";
import { adbRunner, APK_FEED, parseProviderRow, pickPhone, setUpPhone } from "../src/phone-setup.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-phone-setup-"));
const newHome = () => fs.mkdtempSync(path.join(root, "home-"));
const SERVER = "https://orchestrator.example.com";
const APK = Buffer.from("not really an apk");
const DEVICES = "List of devices attached\nSERIAL1\tdevice\n\n";

/**
 * A phone as adb sees it. `installed`, `accessibility` and `signedIn` change as setup acts;
 * `pairing` answers mcp/pairing in turn, the last one for good.
 */
function fakePhone({ installed = false, accessibility = false, signedIn = true, pairing = [{ code: "ABCD-EFGH" }], devices = DEVICES, computers } = {}) {
  const phone = { installed, accessibility, signedIn, calls: [] };
  const answers = [...pairing];
  phone.adb = async (args, { serial } = {}) => {
    const line = args.join(" ");
    phone.calls.push(line);
    if (line === "devices") return devices;
    assert.equal(serial, "SERIAL1", `${line} runs on the phone setup picked`);
    if (args[0] === "install") {
      assert.deepEqual(fs.readFileSync(args[2]), APK, "installs what was downloaded");
      phone.installed = true;
      return "Performing Streamed Install\nSuccess\n";
    }
    const command = args[1];
    if (command === "am get-current-user") return "10\n";
    if (command === "getprop ro.product.model") return "Pixel 9\n";
    if (command.startsWith("pm path")) {
      assert.match(command, /--user 10 /, "asks the user in front");
      return phone.installed ? "package:/data/app/base.apk\n" : "";
    }
    if (command.includes("enabled_accessibility_services")) {
      phone.accessibility = true;
      return "";
    }
    if (command.startsWith("am start")) return "";
    if (command.includes("content://com.codedroid.agent/device/status")) {
      assert.match(command, /--user 10 /);
      return `Row: 0 result=${JSON.stringify({ deviceId: "dev-1", server: SERVER, signedIn: phone.signedIn, accessibility: phone.accessibility, computers })}\n`;
    }
    if (command.includes("content://com.codedroid.agent/mcp/pairing")) {
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer.code) phone.signedIn = true;
      return `Row: 0 result=${JSON.stringify(answer)}\n`;
    }
    throw new Error(`unexpected adb ${line}`);
  };
  return phone;
}

/** get.codedroid.com and the CodeDroid server's redeem. */
function fakeWeb({ sha256 = createHash("sha256").update(APK).digest("hex") } = {}) {
  const published = sha256;
  const urls = [];
  const fetch = async (url, init = {}) => {
    const href = String(url);
    urls.push(href);
    if (href === APK_FEED) {
      return Response.json({ version: "1.2.3", sha256: published ?? undefined, download_url: "https://get.codedroid.com/download?file=codedroid-1.2.3.apk" });
    }
    if (href.startsWith("https://get.codedroid.com/download")) return new Response(APK);
    if (href === `${SERVER}/v1/mcp/pairings/redeem`) {
      assert.equal(JSON.parse(init.body).code, "ABCD-EFGH");
      return Response.json({ host_id: "host-1", token: "cdmcp_x", device: { id: "dev-1", model: "Pixel 9" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  return { fetch, urls };
}

const run = (phone, web, options = {}) =>
  setUpPhone({ adb: phone.adb, fetch: web.fetch, env: {}, tmpdir: root, pollMs: 1, ...options });

try {
  // ── adb's device list ────────────────────────────────────────────────
  assert.deepEqual(pickPhone(DEVICES, {}), { serial: "SERIAL1" });
  assert.deepEqual(
    pickPhone(`* daemon not running; starting now at tcp:5037\n* daemon started successfully\n${DEVICES}`, {}),
    { serial: "SERIAL1" },
    "adb's own lines, as a first run prints them, are not devices",
  );
  assert.deepEqual(pickPhone("List of devices attached\nemulator-5554\tdevice product:sdk model:Pixel transport_id:1\n", {}), { serial: "emulator-5554" });
  assert.match(pickPhone("List of devices attached\n\n", {}).problem, /No phone/);
  assert.match(pickPhone(`${DEVICES}SERIAL2\tdevice\n`, {}).problem, /CODEDROID_SERIAL/);
  assert.deepEqual(pickPhone(`${DEVICES}SERIAL2\tdevice\n`, { CODEDROID_SERIAL: "SERIAL2" }), { serial: "SERIAL2" });
  assert.match(pickPhone("List of devices attached\nSERIAL1\tunauthorized\n", {}).problem, /Accept the USB debugging prompt/);
  assert.match(pickPhone("List of devices attached\nSERIAL1\tno permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]\n", {}).problem, /udev rules/);
  assert.match(pickPhone("List of devices attached\r\nSERIAL1\toffline\r\n", {}).problem, /The phone is offline on adb/, "CRLF from older adb");
  assert.deepEqual(pickPhone(`${DEVICES}SERIAL2\tdevice\n`, {}, "SERIAL2"), { serial: "SERIAL2" }, "the tool's serial picks among several");
  assert.equal(parseProviderRow('Row: 0 result={"code":"ABCD-EFGH"}\n').code, "ABCD-EFGH");
  assert.equal(parseProviderRow("Error while accessing provider:com.codedroid.agent\n"), null);

  // ── Nothing on the phone: install, turn on, wait for sign-in, pair ───
  {
    const home = newHome();
    const phone = fakePhone({ signedIn: false, pairing: [{ error: "signed_out" }, { error: "Phone not registered" }, { code: "ABCD-EFGH" }] });
    const web = fakeWeb();
    const log = [];
    let asked = null;
    const result = await run(phone, web, { home, log: (line) => log.push(line), confirmInstall: async (model) => (asked = model) && true });
    assert.equal(result.status, "paired", result.detail);
    assert.equal(asked, "Pixel 9", "asks before installing, naming the phone");
    assert.ok(web.urls.some((u) => u.includes("via=cli")), "the download is counted as the CLI's");
    assert.ok(phone.installed && phone.accessibility);
    assert.deepEqual(readHosts({ home }).map((h) => [h.server, h.device.id]), [[SERVER, "dev-1"]], "pairs with the server the phone uses");
    assert.ok(log.some((line) => /sign in with Google/.test(line)), "says to sign in on the phone");
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith("codedroid-")), [], "the download is deleted");
  }

  // ── Declined, or never asked: the phone is left alone ───────────────
  for (const options of [{ confirmInstall: async () => false }, {}]) {
    const phone = fakePhone();
    const result = await run(phone, fakeWeb(), { home: newHome(), ...options });
    assert.equal(result.status, "not-installed");
    assert.equal(result.model, "Pixel 9");
    assert.ok(!phone.calls.some((line) => line.startsWith("install") || line.includes("enabled_accessibility_services")), "nothing installed or turned on");
  }

  // ── Removed on the phone: paired again, replacing the old pairing ───
  {
    const home = newHome();
    saveHosts([{ server: SERVER, host_id: "old-host", token: "t", device: { id: "dev-1", model: "Pixel 9" } }], { home });
    const result = await run(fakePhone({ installed: true, accessibility: true, computers: ["someone-else"] }), fakeWeb(), { home });
    assert.equal(result.status, "paired");
    assert.deepEqual(readHosts({ home }).map((h) => h.host_id), ["host-1"]);
  }

  // ── Ready and already paired: nothing to do ─────────────────────────
  {
    const home = newHome();
    saveHosts([{ server: SERVER, host_id: "h", token: "t", device: { id: "dev-1", model: "Pixel 9" } }], { home });
    const phone = fakePhone({ installed: true, accessibility: true, computers: ["h"] });
    const result = await run(phone, fakeWeb(), { home });
    assert.equal(result.status, "already-paired");
    assert.ok(!phone.calls.some((line) => line.includes("mcp/pairing")), "makes no new code");
  }

  // ── Still signed out when the wait ends ─────────────────────────────
  {
    const phone = fakePhone({ installed: true, accessibility: true, signedIn: false, pairing: [{ error: "signed_out" }] });
    const result = await run(phone, fakeWeb(), { home: newHome(), signInWaitMs: 5 });
    assert.equal(result.status, "signed-out");
    assert.ok(phone.calls.some((line) => line.includes("am start")), "opens CodeDroid to sign in");
  }

  // ── Refusals that waiting will not fix ──────────────────────────────
  {
    let result = await run(fakePhone({ installed: true, accessibility: true, pairing: [{ error: "Unknown endpoint: /mcp/pairing" }] }), fakeWeb(), { home: newHome() });
    assert.equal(result.status, "failed");
    assert.match(result.detail, /update it/, "an older app is told to update");
    result = await run(fakePhone({ installed: true, accessibility: true, pairing: [{ error: "disabled" }] }), fakeWeb(), { home: newHome() });
    assert.match(result.detail, /Allow computers to connect/);
    for (const sha256 of ["0".repeat(64), null]) {
      const phone = fakePhone();
      result = await run(phone, fakeWeb({ sha256 }), { home: newHome(), confirmInstall: async () => true });
      assert.equal(result.status, "failed");
      assert.match(result.detail, /checksum/, "a damaged or unchecked download is never installed");
      assert.ok(!phone.installed);
    }
  }

  // ── No adb, or no phone on it: pair by hand ─────────────────────────
  {
    const missing = Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" });
    let result = await setUpPhone({ adb: async () => Promise.reject(missing), home: newHome() });
    assert.equal(result.status, "no-phone");
    result = await run(fakePhone({ devices: "List of devices attached\n\n" }), fakeWeb(), { home: newHome() });
    assert.equal(result.status, "no-phone");
  }

  // ── adb itself: the next location when one is missing, and what a failing command said ──
  {
    const tried = [];
    const run = (file, args) => {
      tried.push(file);
      if (file === "missing") return Object.assign(Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })), { child: null });
      return Promise.reject(Object.assign(new Error("exit 1"), { code: 1, stdout: "", stderr: "Error: no package" }));
    };
    const adb = adbRunner({ run, env: { ADB: "missing" } });
    await assert.rejects(adb(["devices"]), { code: "ENOENT" }, "the only location missing is adb missing");
    const output = await adbRunner({ run, env: {} })(["shell", "pm path x"], { serial: "S" });
    assert.equal(output, "Error: no package", "a non-zero exit is an answer, not an error");
  }

  console.log("phone-setup tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
