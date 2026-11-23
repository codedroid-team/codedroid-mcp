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
import { adbRunner, APK_FEED, createSetupPhoneTool, findPhones, parseProviderRow, phoneLines, pickPhone, setUpPhone, setUpPhones } from "../src/phone-setup.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-phone-setup-"));
const newHome = () => fs.mkdtempSync(path.join(root, "home-"));
const SERVER = "https://orchestrator.example.com";
const APK = Buffer.from("not really an apk");
const DEVICES = "List of devices attached\nSERIAL1\tdevice\n\n";

/**
 * A phone as adb sees it. `installed`, `accessibility` and `signedIn` change as setup acts;
 * `pairing` answers mcp/pairing in turn, the last one for good.
 */
function fakePhone({ installed = false, accessibility = false, signedIn = true, pairing = [{ code: "ABCD-EFGH" }], devices = DEVICES, computers, email = "alice@example.com", signin = true, serial: own = "SERIAL1", deviceId = "dev-1", model = "Pixel 9" } = {}) {
  const phone = { installed, accessibility, signedIn, calls: [], email, signedInWith: [] };
  const answers = [...pairing];
  phone.adb = async (args, { serial } = {}) => {
    const line = args.join(" ");
    phone.calls.push(line);
    if (line === "devices") return devices;
    assert.equal(serial, own, `${line} runs on the phone setup picked`);
    if (args[0] === "install") {
      assert.deepEqual(fs.readFileSync(args[2]), APK, "installs what was downloaded");
      phone.installed = true;
      return "Performing Streamed Install\nSuccess\n";
    }
    const command = args[1];
    if (command === "am get-current-user") return "10\n";
    if (command === "getprop ro.product.model") return `${model}\n`;
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
      return `Row: 0 result=${JSON.stringify({ deviceId, server: SERVER, signedIn: phone.signedIn, accessibility: phone.accessibility, computers })}\n`;
    }
    if (command.includes("content://com.codedroid.agent/mcp/signin")) {
      if (!signin) return `Row: 0 result=${JSON.stringify({ error: "Unknown endpoint: /mcp/signin" })}\n`;
      const code = /code=([^\s&]+)/.exec(command)?.[1];
      if (phone.signedIn) return `Row: 0 result=${JSON.stringify({ error: "already_signed_in", email: phone.email })}\n`;
      if (!code) return `Row: 0 result=${JSON.stringify({ error: "no_code" })}\n`;
      phone.signedInWith.push(decodeURIComponent(code));
      phone.signedIn = true;
      return `Row: 0 result=${JSON.stringify({ ok: true, email: phone.email })}\n`;
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

/** Several fake phones on one adb: `devices` lists them, and each command reaches the one it names. */
function fakeFleet(phones, extra = "") {
  const devices = `List of devices attached\n${phones.map((p) => `${p.serial}\tdevice\n`).join("")}${extra}\n`;
  const calls = [];
  const adb = async (args, options = {}) => {
    calls.push([options.serial ?? null, args.join(" ")]);
    if (args[0] === "devices") return devices;
    const phone = phones.find((p) => p.serial === options.serial);
    assert.ok(phone, `${args.join(" ")} names a phone on adb (${options.serial})`);
    return phone.adb(args, options);
  };
  return { adb, calls };
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

  // ── Several devices on adb: listed with their model and state ───────
  {
    const tabs = [
      Object.assign(fakePhone({ serial: "TAB1", deviceId: "dev-1", model: "Galaxy Tab S9" }), { serial: "TAB1" }),
      Object.assign(fakePhone({ serial: "TAB2", deviceId: "dev-2", model: "Galaxy Tab S9", installed: true }), { serial: "TAB2" }),
      Object.assign(fakePhone({ serial: "TAB3", deviceId: "dev-3", model: "Lenovo Tab P12" }), { serial: "TAB3" }),
    ];
    const fleet = fakeFleet(tabs, "TAB4\tunauthorized\n");
    const found = await findPhones({ adb: fleet.adb, env: {} });
    assert.deepEqual(
      found.phones.map((p) => [p.serial, p.label, p.installed ?? null, p.problem ?? null]),
      [
        ["TAB1", "Galaxy Tab S9 (TAB1)", false, null],
        ["TAB2", "Galaxy Tab S9 (TAB2)", true, null],
        ["TAB3", "Lenovo Tab P12", false, null],
        ["TAB4", "TAB4", null, "Accept the USB debugging prompt on the phone, then run this again."],
      ],
      "the same model is told apart by serial; an unauthorized device says what to do",
    );
    assert.deepEqual(phoneLines(found.phones), [
      "  Galaxy Tab S9 (TAB1): CodeDroid not installed",
      "  Galaxy Tab S9 (TAB2): CodeDroid installed",
      "  Lenovo Tab P12 (TAB3): CodeDroid not installed",
      "  TAB4: Accept the USB debugging prompt on the phone, then run this again.",
    ]);
    assert.ok(!fleet.calls.some(([serial]) => serial === "TAB4"), "an unauthorized device is not asked anything");
    assert.deepEqual((await findPhones({ adb: fleet.adb, env: { CODEDROID_SERIAL: "TAB3" } })).phones.map((p) => p.serial), ["TAB3"], "CODEDROID_SERIAL picks one");
    assert.deepEqual((await findPhones({ adb: fleet.adb, env: {}, serial: "TAB2" })).phones.map((p) => p.serial), ["TAB2"], "so does serial");
    assert.match((await findPhones({ adb: fleet.adb, env: {}, serial: "NOPE" })).problem, /NOPE is not on adb/);
    assert.match((await findPhones({ adb: async () => "List of devices attached\n\n", env: {} })).problem, /No phone is on adb/);
    const missing = Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" });
    assert.match((await findPhones({ adb: async () => Promise.reject(missing), env: {} })).problem, /adb is not installed/);
  }

  // ── Several devices from nothing: one download, each signed in as the account, side by side ──
  {
    const home = newHome();
    const ids = { TAB1: "dev-1", TAB2: "dev-2", TAB3: "dev-3" };
    const tabs = Object.entries(ids).map(([serial, deviceId]) =>
      Object.assign(fakePhone({ serial, deviceId, model: serial === "TAB3" ? "Lenovo Tab P12" : "Galaxy Tab S9", signedIn: false, pairing: [{ error: "signed_out" }] }), { serial }),
    );
    const fleet = fakeFleet(tabs, "TAB4\tunauthorized\n");
    const web = fakeWeb();
    const account = { server: SERVER, email: "alice@example.com", refresh_token: "r", devices: [] };
    const log = [];
    let codes = 0;
    let lists = 0;
    let inFlight = 0;
    let together = 0;
    const { phones } = await findPhones({ adb: fleet.adb, env: {} });
    const results = await setUpPhones({
      phones,
      adb: fleet.adb,
      fetch: web.fetch,
      env: {},
      tmpdir: root,
      home,
      account,
      pollMs: 60_000,
      log: (line) => log.push(line),
      confirmInstall: async () => true,
      mintCode: async () => {
        inFlight++;
        together = Math.max(together, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return `cdsi_${++codes}`;
      },
      listDevices: async () => (lists++, Object.values(ids).map((id) => ({ id, model: "Tab", linked: true }))),
    });
    assert.deepEqual(results.map((r) => [r.serial, r.status]), [["TAB1", "paired"], ["TAB2", "paired"], ["TAB3", "paired"], ["TAB4", "no-phone"]]);
    assert.ok(results.slice(0, 3).every((r) => r.host.account), "every tablet is reached as the account, with nothing to pair");
    assert.deepEqual(results.slice(0, 3).map((r) => r.host.device.id), ["dev-1", "dev-2", "dev-3"]);
    assert.match(results[3].detail, /Accept the USB debugging prompt/);
    assert.equal(web.urls.filter((u) => u.startsWith("https://get.codedroid.com/download")).length, 1, "CodeDroid is downloaded once for all of them");
    assert.ok(tabs.every((t) => t.installed && t.accessibility && t.signedIn));
    assert.deepEqual(tabs.map((t) => t.signedInWith.length), [1, 1, 1], "each tablet gets a code of its own");
    assert.equal(together, 3, "the tablets are set up side by side");
    assert.equal(lists, 1, "they share one look at the account's phones");
    assert.ok(log.includes("Galaxy Tab S9 (TAB1): Installing CodeDroid on the phone. If it offers to scan the app, accept."), "lines name their device");
    assert.ok(log.some((l) => /^Downloading CodeDroid 1\.2\.3/.test(l)), "the shared download is said once, for all");
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith("codedroid-")), [], "the download is deleted");
    assert.deepEqual(readHosts({ home }), [], "no pairing was written");
  }

  // ── Several devices: a damaged download fails them all, fetched once; one device's failure leaves the others ──
  {
    const tabs = ["TAB1", "TAB2"].map((serial, i) => Object.assign(fakePhone({ serial, deviceId: `dev-${i + 1}` }), { serial }));
    const fleet = fakeFleet(tabs);
    const web = fakeWeb({ sha256: "0".repeat(64) });
    const { phones } = await findPhones({ adb: fleet.adb, env: {} });
    let results = await setUpPhones({ phones, adb: fleet.adb, fetch: web.fetch, env: {}, tmpdir: root, home: newHome(), pollMs: 1, confirmInstall: async () => true });
    assert.deepEqual(results.map((r) => r.status), ["failed", "failed"]);
    assert.ok(results.every((r) => /checksum/.test(r.detail)));
    assert.equal(web.urls.filter((u) => u.startsWith("https://get.codedroid.com/download")).length, 1, "a bad download is not fetched again for each");
    assert.ok(!tabs.some((t) => t.installed));

    const ready = [
      Object.assign(fakePhone({ serial: "TAB1", installed: true, accessibility: true, pairing: [{ error: "disabled" }] }), { serial: "TAB1" }),
      Object.assign(fakePhone({ serial: "TAB2", deviceId: "dev-2", model: "Pixel 8", installed: true, accessibility: true }), { serial: "TAB2" }),
    ];
    const both = fakeFleet(ready);
    const home = newHome();
    const found = await findPhones({ adb: both.adb, env: {} });
    results = await setUpPhones({ phones: found.phones, adb: both.adb, fetch: fakeWeb().fetch, env: {}, tmpdir: root, home, pollMs: 1 });
    assert.deepEqual(results.map((r) => r.status), ["failed", "paired"]);
    assert.match(results[0].detail, /Allow computers to connect/);
    assert.equal(readHosts({ home }).length, 1, "the other device is paired");

    // Declining the install leaves only that device alone.
    const mixed = [
      Object.assign(fakePhone({ serial: "TAB1" }), { serial: "TAB1" }),
      Object.assign(fakePhone({ serial: "TAB2", deviceId: "dev-2", model: "Pixel 8", installed: true, accessibility: true }), { serial: "TAB2" }),
    ];
    const some = fakeFleet(mixed);
    results = await setUpPhones({ phones: (await findPhones({ adb: some.adb, env: {} })).phones, adb: some.adb, fetch: fakeWeb().fetch, env: {}, tmpdir: root, home: newHome(), pollMs: 1 });
    assert.deepEqual(results.map((r) => r.status), ["not-installed", "paired"]);
    assert.ok(!mixed[0].installed);
  }

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

  // ── Signed in on this computer: the phone is signed in with a code, and reached with no pairing ──
  {
    const home = newHome();
    const phone = fakePhone({ installed: true, accessibility: true, signedIn: false, pairing: [{ error: "signed_out" }] });
    const account = { server: SERVER, email: "alice@example.com", refresh_token: "r", devices: [] };
    const listed = [];
    let minted = 0;
    const result = await run(phone, fakeWeb(), {
      home,
      account,
      mintCode: async (a) => (assert.equal(a, account), minted++, "cdsi_abc"),
      listDevices: async () => (listed.push(1), listed.length < 2 ? [] : [{ id: "dev-1", model: "Pixel 9", linked: true }]),
    });
    assert.equal(result.status, "paired", result.detail);
    assert.equal(minted, 1);
    assert.deepEqual(phone.signedInWith, ["cdsi_abc"], "the code reaches the app over adb");
    assert.ok(phone.signedIn);
    assert.equal(result.host.account, true);
    assert.equal(result.host.device.id, "dev-1");
    assert.match(result.detail, /on your account/);
    assert.ok(!phone.calls.some((line) => line.includes("mcp/pairing")), "nothing to pair");
    assert.ok(!phone.calls.some((line) => line.includes("am start")), "no sign-in screen to open");
    assert.deepEqual(readHosts({ home }), [], "no pairing was written: the account reaches the phone");

    // Already on the account: nothing to do.
    const again = await run(fakePhone({ installed: true, accessibility: true }), fakeWeb(), { home, account: { ...account, devices: [{ id: "dev-1", model: "Pixel 9" }] } });
    assert.equal(again.status, "already-paired");
    assert.equal(again.host.account, true);
  }

  // ── Signed in on this computer, but the phone is someone else's, or too old, or on another server: pair ──
  {
    const account = { server: SERVER, email: "alice@example.com", refresh_token: "r", devices: [] };
    const other = fakePhone({ installed: true, accessibility: true, email: "bob@example.com" });
    const log = [];
    let result = await run(other, fakeWeb(), { home: newHome(), account, log: (l) => log.push(l), mintCode: async () => assert.fail("no code for another account's phone") });
    assert.equal(result.status, "paired");
    assert.ok(!result.host.account, "paired the old way");
    assert.ok(log.some((l) => /signed in as bob@example.com, not alice@example.com/.test(l)));

    result = await run(fakePhone({ installed: true, accessibility: true, signin: false }), fakeWeb(), { home: newHome(), account, mintCode: async () => assert.fail("an app without mcp/signin") });
    assert.equal(result.status, "paired");
    assert.ok(!result.host.account, "an older app pairs");

    result = await run(fakePhone({ installed: true, accessibility: true }), fakeWeb(), { home: newHome(), account: { ...account, server: "https://orchestrator.dev2.codedroid.com" }, mintCode: async () => assert.fail("another server") });
    assert.equal(result.status, "paired");
    assert.ok(!result.host.account, "a phone on another server pairs");

    // Already paired, and the account cannot reach the phone: the pairing is kept, not made again.
    for (const [why, phone] of [
      ["an app without mcp/signin", fakePhone({ installed: true, accessibility: true, signin: false, computers: ["h"] })],
      ["another account's phone", fakePhone({ installed: true, accessibility: true, email: "bob@example.com", computers: ["h"] })],
    ]) {
      const home = newHome();
      saveHosts([{ server: SERVER, host_id: "h", token: "t", device: { id: "dev-1", model: "Pixel 9" } }], { home });
      result = await run(phone, fakeWeb(), { home, account, mintCode: async () => assert.fail(why) });
      assert.equal(result.status, "already-paired", why);
      assert.equal(result.host.token, "t", why);
      assert.ok(!phone.calls.some((line) => line.includes("mcp/pairing")), `${why}: no new pairing`);
    }

    // The code could not be minted: the user signs in on the phone instead, and it is reached as the account once registered.
    const phone = fakePhone({ installed: true, accessibility: true, signedIn: false, pairing: [{ error: "signed_out" }] });
    const quiet = [];
    result = await run(phone, fakeWeb(), {
      home: newHome(),
      account,
      log: (l) => quiet.push(l),
      signInWaitMs: 50,
      pollMs: 5,
      mintCode: async () => { throw new Error("offline"); },
      listDevices: async () => (phone.signedIn ? [{ id: "dev-1", model: "Pixel 9" }] : (phone.signedIn = true, [])),
    });
    assert.equal(result.status, "paired", result.detail);
    assert.ok(quiet.some((l) => /could not be signed in from here \(offline\)/.test(l)));
    assert.ok(phone.calls.some((line) => line.includes("am start")), "opens CodeDroid to sign in");

    // Signed in, but the phone never registers: say so.
    result = await run(fakePhone({ installed: true, accessibility: true }), fakeWeb(), { home: newHome(), account, registerWaitMs: 20, signInWaitMs: 20, pollMs: 5, listDevices: async () => [] });
    assert.equal(result.status, "failed");
    assert.match(result.detail, /not registered with CodeDroid's server yet/);
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
    assert.ok(!phone.calls.some((line) => line.includes("enabled_accessibility_services")), "without turning on again what is on");
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

  // ── The agent's tool: consent, what to do next, and one job across calls ──
  {
    const jobs = new Map();
    let asked;
    let tool = createSetupPhoneTool({
      jobs,
      setUp: async ({ log, confirmInstall, serial }) => {
        asked = { install: await confirmInstall("Pixel 9"), serial };
        log("Installing.");
        return { status: "paired", detail: "Paired with Pixel 9." };
      },
    });
    let result = await tool.handler({ install: true, serial: "S2" });
    assert.deepEqual(asked, { install: true, serial: "S2" });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /Installing\.\nPaired with Pixel 9\.\nAsk the user to tap Allow/);
    await tool.handler({});
    assert.equal(asked.install, false, "installs only when the call says so");

    result = await createSetupPhoneTool({ jobs, setUp: async () => ({ status: "not-installed", detail: "CodeDroid is not on Pixel 9." }) }).handler({});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Ask the user whether to install CodeDroid on it/);

    let started = 0;
    let finish;
    tool = createSetupPhoneTool({
      jobs,
      waitMs: 5,
      setUp: ({ log }) => (started++, log("Downloading CodeDroid..."), new Promise((resolve) => (finish = resolve))),
    });
    result = await tool.handler({ install: true });
    assert.match(result.content[0].text, /Downloading CodeDroid\.\.\.\nStill working/);
    assert.equal(result.isError, false);
    result = await tool.handler({ install: true });
    assert.equal(started, 1, "a second call joins the setup under way");
    finish({ status: "signed-out", detail: "Sign in to CodeDroid on the phone, then try again." });
    result = await tool.handler({});
    assert.match(result.content[0].text, /Ask the user to sign in/);
    assert.equal(jobs.size, 0, "a finished job is gone once reported");

    // A result no call picked up in time is stale: the next call sets up again.
    let clock = 0;
    started = 0;
    tool = createSetupPhoneTool({
      jobs,
      waitMs: 5,
      keepMs: 1_000,
      now: () => clock,
      setUp: () => (started++, new Promise((resolve) => (finish = resolve))),
    });
    await tool.handler({});
    finish({ status: "signed-out", detail: "Sign in to CodeDroid on the phone, then try again." });
    await new Promise((resolve) => setImmediate(resolve));
    clock = 5_000;
    result = await tool.handler({});
    assert.equal(started, 2, "a stale result starts a new setup");
    assert.match(result.content[0].text, /Still working/);
    finish({ status: "signed-out", detail: "Sign in to CodeDroid on the phone, then try again." });
    await new Promise((resolve) => setImmediate(resolve));
    result = await tool.handler({});
    assert.equal(started, 2, "a fresh result is reported, not run again");
    assert.match(result.content[0].text, /Ask the user to sign in/);

    // Another phone's setup under way is not joined, nor its result taken as this phone's.
    const serials = [];
    tool = createSetupPhoneTool({
      jobs,
      waitMs: 5,
      setUp: ({ serial }) => (serials.push(serial), new Promise((resolve) => (finish = resolve))),
    });
    await tool.handler({ serial: "S1" });
    result = await tool.handler({ serial: "S2" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Setting up S1 already/);
    await tool.handler({});
    assert.deepEqual(serials, ["S1"], "a call without serial follows the setup under way");
    finish({ status: "paired", detail: "Paired with Pixel 9." });
    await new Promise((resolve) => setImmediate(resolve));
    await tool.handler({ serial: "S2" });
    assert.deepEqual(serials, ["S1", "S2"], "S1's result is not S2's");
    finish({ status: "paired", detail: "Paired with Pixel 8." });
    await tool.handler({});
  }

  console.log("phone-setup tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
