/**
 * The daily look at npm: cached for a day, a failed request keeps the last answer, off by env, and
 * what codedroid_status and the daemon's log say about a newer release.
 *
 * Run: node test/update-check.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStatusTool } from "../src/status-tool.js";
import {
  cachedUpdate,
  checkForUpdate,
  compareVersions,
  describeUpdate,
  readUpdateCache,
  REGISTRY_URL,
  startUpdateChecks,
  updateCachePath,
} from "../src/update-check.js";
import { VERSION } from "../src/version.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-update-"));
const home = path.join(root, "home");
const calls = [];
const npm = (version) => async (url, options) => {
  calls.push(url);
  assert.equal(url, REGISTRY_URL);
  assert.ok(options.signal, "a timeout");
  return { ok: true, json: async () => ({ version }) };
};

try {
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.ok(compareVersions(undefined, "0.0.0") < 0);

  assert.equal(readUpdateCache({ home }), null);
  assert.equal(cachedUpdate({ home }), null, "never checked: nothing to say");

  let result = await checkForUpdate({ home, env: {}, fetch: npm("9.9.9"), now: 1000 });
  assert.deepEqual(result, { latest: "9.9.9", checkedAt: 1000 });
  assert.deepEqual(readUpdateCache({ home }), result, "kept");
  result = await checkForUpdate({ home, env: {}, fetch: npm("9.9.10"), now: 1000 + 60_000 });
  assert.equal(result.latest, "9.9.9", "within a day: the cache, and no request");
  assert.equal(calls.length, 1);
  result = await checkForUpdate({ home, env: {}, fetch: npm("9.9.10"), now: 1000 + 25 * 3_600_000 });
  assert.equal(result.latest, "9.9.10", "a day later: asked again");
  assert.equal(calls.length, 2);

  // npm down, or answering nonsense: the last answer stands.
  result = await checkForUpdate({ home, env: {}, fetch: async () => { throw new Error("ENOTFOUND"); }, ttlMs: 0 });
  assert.equal(result.latest, "9.9.10");
  result = await checkForUpdate({ home, env: {}, fetch: async () => ({ ok: false, status: 503 }), ttlMs: 0 });
  assert.equal(result.latest, "9.9.10");
  result = await checkForUpdate({ home, env: {}, fetch: async () => ({ ok: true, json: async () => ({ version: "<script>" }) }), ttlMs: 0 });
  assert.equal(result.latest, "9.9.10");
  assert.equal(await checkForUpdate({ home: path.join(root, "fresh"), env: {}, fetch: async () => { throw new Error("ENOTFOUND"); } }), null, "nothing known and npm down");
  for (const off of ["0", "false"]) {
    assert.equal(await checkForUpdate({ home, env: { CODEDROID_MCP_UPDATE_CHECK: off }, fetch: () => assert.fail("turned off"), ttlMs: 0 }), null);
  }

  // What it tells the agent and the log.
  const update = cachedUpdate({ home });
  assert.equal(update.latest, "9.9.10");
  assert.equal(update.current, VERSION);
  assert.match(update.hint, /9\.9\.10 is out; this is .*restarting the client/);
  assert.equal(describeUpdate(VERSION), null, "current");
  assert.equal(describeUpdate("0.0.1"), null, "an npx cache ahead of npm is not behind");
  assert.equal(describeUpdate(undefined), null);

  // codedroid_status carries it, from the cache alone.
  const phones = { select: () => [], getInstructions: () => null };
  const status = createStatusTool(phones, { update: () => cachedUpdate({ home }) });
  let body = JSON.parse((await status.handler({})).content[0].text);
  assert.equal(body.update.latest, "9.9.10");
  assert.equal(body.bridge, VERSION);
  body = JSON.parse((await createStatusTool(phones).handler({})).content[0].text);
  assert.ok(!("update" in body), "nothing to say by default");

  fs.writeFileSync(updateCachePath(home), "not json");
  assert.equal(readUpdateCache({ home }), null, "a bad cache is no cache");

  // The daemon's: checks at once, and logs a newer release.
  const logged = [];
  const quiet = path.join(root, "quiet");
  const stop = startUpdateChecks({ home: quiet, env: {}, log: (line) => logged.push(line), intervalMs: 3_600_000, fetch: npm("9.9.11") });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /9\.9\.11 is out/);
  assert.equal(readUpdateCache({ home: quiet }).latest, "9.9.11");
  const stopCurrent = startUpdateChecks({ home: path.join(root, "current"), env: {}, log: () => assert.fail("current: nothing to log"), fetch: npm(VERSION) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stopCurrent();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("update-check.test.mjs: ALL PASS");
