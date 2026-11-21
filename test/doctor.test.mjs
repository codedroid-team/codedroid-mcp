/**
 * doctor's report from injected probes: every line says ok or fix, and fix says what to do.
 *
 * Run: node test/doctor.test.mjs
 */
import assert from "node:assert/strict";
import { collectDoctorReport, formatDoctorReport } from "../src/doctor.js";
import { VERSION } from "../src/version.js";

const PAIRING = { server: "https://orchestrator.codedroid.com", host_id: "h", token: "t", device: { id: "abc-123", model: "Pixel 9" } };
const ON_ACCOUNT = { server: "https://orchestrator.codedroid.com", account: true, host_id: null, token: null, device: { id: "def-456", model: "Pixel 8" } };
const ACCOUNT = { server: "https://orchestrator.codedroid.com", email: "alice@example.com", refresh_token: "r", devices: [ON_ACCOUNT.device] };

const healthy = {
  nodeVersion: "v22.1.0",
  adbDevices: async () => ({ ok: true, output: "List of devices attached\nR58M1234 device product:x model:Pixel_9\n", where: "/usr/bin/adb" }),
  daemonToken: () => "a".repeat(64),
  account: () => ACCOUNT,
  pairings: () => [ON_ACCOUNT, PAIRING],
  daemonHealth: async () => ({ version: VERSION, sessions: 2, adbToolEnabled: true }),
  phoneStatus: async () => ({ connected: true, devices: [{ id: "abc-123", model: "Pixel 9", connected: true }] }),
  clients: () => [
    { id: "claude-code", name: "Claude Code", installed: () => true, check: () => ({ status: "present", detail: "has the CodeDroid plugin" }) },
    { id: "cursor", name: "Cursor", installed: () => true, check: () => ({ status: "absent", detail: "no codedroid server in ~/.cursor/mcp.json" }) },
    { id: "zed", name: "Zed", installed: () => false, check: () => assert.fail("not installed: never checked") },
    { id: "codex", name: "Codex", installed: () => true, check: () => ({ status: "other", detail: "has a codedroid MCP server added by hand" }) },
  ],
};

// ── All well, but one client to set up ──────────────────────────────────────
{
  const report = await collectDoctorReport(healthy);
  assert.deepEqual(
    report.checks.map((c) => [c.name, c.ok]),
    [["Node.js", true], ["adb", true], ["Daemon token", true], ["Account", true], ["Known phones", true], ["Daemon", true], ["Phone Pixel 9", true], ["Claude Code", true], ["Cursor", false], ["Codex", true]],
  );
  assert.equal(report.ok, false);
  assert.equal(report.checks[1].detail, "/usr/bin/adb: 1 device");
  assert.equal(report.checks[3].detail, "signed in as alice@example.com at https://orchestrator.codedroid.com");
  assert.equal(report.checks[4].detail, "1 on the account: Pixel 8 (def-456); paired: Pixel 9 (abc-123)");
  assert.equal(report.checks[8].fix, "Run npx -y @codedroid/mcp setup --client=cursor.");
  assert.match(report.checks[9].detail, /setup leaves it alone/);
  const lines = formatDoctorReport(report);
  assert.equal(lines[0], "ok   Node.js: v22.1.0");
  assert.match(lines.find((l) => l.startsWith("fix  Cursor")), /^fix  Cursor: no codedroid server in ~\/.cursor\/mcp\.json\n       Run npx -y @codedroid\/mcp setup --client=cursor\.$/);
  assert.equal(lines.at(-1), "1 thing to fix.");
}

// ── Nothing set up yet: every fix line tells the next step ──────────────────
{
  const report = await collectDoctorReport({
    ...healthy,
    nodeVersion: "v18.20.0",
    adbDevices: async () => ({ ok: false, output: "" }),
    daemonToken: () => null,
    account: () => null,
    pairings: () => [],
    daemonHealth: async () => null,
    phoneStatus: async () => assert.fail("no pairing: never asked"),
    clients: () => [],
  });
  assert.deepEqual(
    report.checks.map((c) => [c.name, c.ok]),
    [["Node.js", false], ["adb", false], ["Daemon token", true], ["Account", false], ["Known phones", false], ["Daemon", true], ["Coding clients", true]],
  );
  assert.equal(report.checks[0].fix, "Install Node.js 20 or later.");
  assert.match(report.checks[1].fix, /Android platform-tools on PATH, or ADB=/);
  assert.match(report.checks[3].fix, /npx -y @codedroid\/mcp login/);
  assert.match(report.checks[4].fix, /npx -y @codedroid\/mcp login/);
  assert.match(report.checks[4].fix, /npx -y @codedroid\/mcp setup/);
  assert.equal(report.checks[5].detail, "not running (a client starts it when it connects)");
  assert.equal(formatDoctorReport(report).at(-1), "4 things to fix.");
}

// ── Signed in, but no phone is on the account yet ───────────────────────────
{
  const report = await collectDoctorReport({ ...healthy, pairings: () => [], phoneStatus: async () => assert.fail("no phone: never asked") });
  const phones = report.checks.find((c) => c.name === "Known phones");
  assert.equal(phones.ok, false);
  assert.match(phones.detail, /no phone is on the account/);
  assert.match(phones.fix, /sign in with the same Google account/);
}

// ── A phone that is paired but off, an unauthorized adb device, a bad token file, an old daemon ──
{
  const report = await collectDoctorReport({
    ...healthy,
    adbDevices: async () => ({ ok: true, output: "List of devices attached\nR58M1234 unauthorized usb:1\n* daemon started successfully\n", where: "adb" }),
    daemonToken: () => {
      throw new Error("Cannot read daemon token at /x: the token must be owned by this user with permissions 0600");
    },
    daemonHealth: async () => ({ version: "0.0.1", sessions: 0, adbToolEnabled: false, port: 4826 }),
    phoneStatus: async () => ({ connected: false, devices: [{ id: "abc-123", model: "Pixel 9", connected: false, problem: "Waiting for the phone: tap Allow." }] }),
    clients: () => [{ id: "vscode", name: "VS Code", installed: () => { throw new Error("boom"); } }],
  });
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
  assert.equal(byName.adb.detail, "adb: 1 device, 1 unauthorized");
  assert.equal(byName.adb.fix, "Tap Allow on the phone's USB debugging prompt.");
  assert.match(byName["Daemon token"].fix, /End every CodeDroid daemon process/);
  assert.match(byName.Daemon.detail, /v0\.0\.1 on port 4826, this CLI is .*: the next client of .* replaces it/);
  assert.equal(byName["Phone Pixel 9"].detail, "Waiting for the phone: tap Allow.");
  assert.match(byName["Phone Pixel 9"].fix, /Open CodeDroid on the phone/);
  assert.equal(byName["Coding clients"].detail, "none of the supported clients found on this computer", "a client whose detection throws is not installed");
  assert.equal(report.ok, false);
}

// ── The daemon could not say ────────────────────────────────────────────────
{
  const report = await collectDoctorReport({ ...healthy, phoneStatus: async () => { throw new Error("connect ECONNREFUSED"); } });
  const phones = report.checks.find((c) => c.name === "Phones");
  assert.equal(phones.detail, "connect ECONNREFUSED");
  assert.match(phones.fix, /npx -y @codedroid\/mcp status/);
}

// ── Asking the phones starts the daemon, so its line reports it running ─────
{
  let running = false;
  const report = await collectDoctorReport({
    ...healthy,
    phoneStatus: async () => {
      running = true;
      return { connected: true, devices: [{ id: "abc-123", model: "Pixel 9", connected: true }] };
    },
    daemonHealth: async () => (running ? { version: VERSION, sessions: 1, adbToolEnabled: true } : null),
  });
  assert.match(report.checks.find((c) => c.name === "Daemon").detail, /^v.*, 1 session,/);
  assert.deepEqual(report.checks.map((c) => c.name).slice(5, 7), ["Daemon", "Phone Pixel 9"], "the lines keep their order");
}

// ── This release against npm ────────────────────────────────────────────────
{
  const names = (report) => report.checks.map((c) => c.name);
  assert.ok(!names(await collectDoctorReport(healthy)).includes("Version"), "no probe, no line");
  let report = await collectDoctorReport({ ...healthy, latestVersion: async () => VERSION });
  assert.deepEqual(names(report).slice(0, 2), ["Node.js", "Version"]);
  assert.deepEqual([report.checks[1].ok, report.checks[1].detail], [true, `${VERSION}, the newest on npm`]);
  report = await collectDoctorReport({ ...healthy, latestVersion: async () => "99.0.0" });
  assert.deepEqual([report.checks[1].ok, report.checks[1].detail], [false, `${VERSION}, and 99.0.0 is on npm`]);
  assert.match(report.checks[1].fix, /restart the client/);
  report = await collectDoctorReport({ ...healthy, latestVersion: async () => { throw new Error("offline"); } });
  assert.deepEqual([report.checks[1].ok, report.checks[1].detail], [true, `${VERSION} (could not ask npm for the newest)`]);
  report = await collectDoctorReport({ ...healthy, latestVersion: async () => "0.0.1" });
  assert.equal(report.checks[1].ok, true, "an npx cache ahead of npm is not a problem");
}

console.log("doctor.test.mjs: ALL PASS");
