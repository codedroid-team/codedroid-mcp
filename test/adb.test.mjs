/**
 * Finding the phone and saying why CodeDroid did not answer — no real adb.
 *
 * Run: node test/adb.test.mjs
 */
import assert from "node:assert/strict";
import { ACCESSIBILITY_SERVICE, currentUser, diagnose, parseDevices, pickDevice, withCodeDroidService } from "../src/adb.js";

/** A fake adb: answers by the joined argv, records every call. */
function fakeAdb(answers) {
  const calls = [];
  const adb = async (args) => {
    calls.push(args.join(" "));
    for (const [pattern, answer] of answers) {
      if (pattern.test(args.join(" "))) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    throw new Error(`unexpected adb ${args.join(" ")}`);
  };
  adb.calls = calls;
  return adb;
}

const DEVICES = `List of devices attached
GOOGLE000000299        device usb:1-1 product:googlebook model:Googlebook device:gb transport_id:3
emulator-5554          offline transport_id:1
0A241FDD4002HY         unauthorized usb:1-2 transport_id:4

`;

// ── adb devices -l ────────────────────────────────────────────────────
assert.deepEqual(parseDevices(DEVICES), [
  { serial: "GOOGLE000000299", state: "device", model: "Googlebook" },
  { serial: "emulator-5554", state: "offline", model: undefined },
  { serial: "0A241FDD4002HY", state: "unauthorized", model: undefined },
]);
assert.deepEqual(parseDevices("List of devices attached\n\n"), []);

// ── One ready device is the phone ─────────────────────────────────────
assert.equal(await pickDevice(fakeAdb([[/^devices/, DEVICES]]), {}), "GOOGLE000000299");

// ── Several ready: the user has to say which ──────────────────────────
{
  const two = "List of devices attached\nA device model:Pixel_5\nB device\n";
  await assert.rejects(pickDevice(fakeAdb([[/^devices/, two]]), {}), /Several Android devices.*CODEDROID_SERIAL/);
  assert.equal(await pickDevice(fakeAdb([[/^devices/, two]]), { CODEDROID_SERIAL: "B" }), "B");
  assert.equal(await pickDevice(fakeAdb([[/^devices/, two]]), { ANDROID_SERIAL: "A" }), "A");
}

// ── A named device that is missing or not ready says why ──────────────
await assert.rejects(pickDevice(fakeAdb([[/^devices/, DEVICES]]), { CODEDROID_SERIAL: "NOPE" }), /NOPE is not attached/);
await assert.rejects(pickDevice(fakeAdb([[/^devices/, DEVICES]]), { CODEDROID_SERIAL: "0A241FDD4002HY" }), /tap Allow on "Allow USB debugging\?"/);
await assert.rejects(pickDevice(fakeAdb([[/^devices/, "List of devices attached\nX offline\n"]]), {}), /X is offline/);
await assert.rejects(pickDevice(fakeAdb([[/^devices/, "List of devices attached\n"]]), {}), /No Android device on adb/);

// ── The user in front ─────────────────────────────────────────────────
assert.equal(await currentUser(fakeAdb([[/get-current-user/, "10\n"]]), "S"), 10);
assert.equal(await currentUser(fakeAdb([[/get-current-user/, "Error: unknown\n"]]), "S"), 0);

// ── Turning accessibility on adds CodeDroid to what is there ──────────
assert.equal(withCodeDroidService("null"), ACCESSIBILITY_SERVICE);
assert.equal(withCodeDroidService(""), ACCESSIBILITY_SERVICE);
assert.equal(withCodeDroidService("com.other/.Svc\n"), `com.other/.Svc:${ACCESSIBILITY_SERVICE}`);
assert.equal(withCodeDroidService(`${ACCESSIBILITY_SERVICE}:com.other/.Svc`), `${ACCESSIBILITY_SERVICE}:com.other/.Svc`);

// ── diagnose: every check runs as the user in front ───────────────────
{
  const adb = fakeAdb([[/pm path/, ""]]);
  assert.match(await diagnose(adb, "S", 10), /not installed on S \(Android user 10\)/);
  assert.ok(adb.calls[0].includes("--user 10"));
}
{
  const status = 'Row: 0 result={"deviceId":"d","accessibility":false,"keyboard":true}';
  const adb = fakeAdb([
    [/pm path/, "package:/data/app/base.apk\n"],
    [/content query/, status],
    [/settings get/, "com.other/.Svc\n"],
  ]);
  const said = await diagnose(adb, "S", 10);
  assert.match(said, /accessibility service is off on S/);
  assert.ok(said.includes(`settings put --user 10 secure enabled_accessibility_services 'com.other/.Svc:${ACCESSIBILITY_SERVICE}'`), said);
  assert.ok(adb.calls.every((c) => !/content query|settings/.test(c) || c.includes("--user 10")), adb.calls.join("\n"));
}
{
  const adb = fakeAdb([
    [/pm path/, "package:/data/app/base.apk\n"],
    [/content query/, 'Row: 0 result={"accessibility":false}'],
    [/settings get/, `${ACCESSIBILITY_SERVICE}\n`],
  ]);
  assert.match(await diagnose(adb, "S", 0), /turned on but not running/);
}
{
  const adb = fakeAdb([
    [/pm path/, "package:/data/app/base.apk\n"],
    [/content query/, 'Row: 0 result={"accessibility":true,"keyboard":true}'],
  ]);
  assert.match(await diagnose(adb, "S", 0), /Settings > Computers/);
}
{
  const adb = fakeAdb([
    [/pm path/, "package:/data/app/base.apk\n"],
    [/content query/, new Error("Error while accessing provider")],
  ]);
  assert.match(await diagnose(adb, "S", 0), /did not answer/);
}

console.log("adb.test.mjs: ALL PASS");
