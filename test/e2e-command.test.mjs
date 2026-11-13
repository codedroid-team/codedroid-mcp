/**
 * `codedroid-mcp e2e report`: the real binary on copies of test/fixtures/e2e-sample.
 * It writes only inside the folder, and never touches the daemon, a port or the HOME directory.
 *
 * Run: node test/e2e-command.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { quality } from "../src/e2e-quality.js";

const fixture = new URL("./fixtures/e2e-sample", import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cmd-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cmd-home-"));
let n = 0;
const copy = (edit) => {
  const dir = path.join(root, `case${n++}`, "e2e");
  fs.mkdirSync(path.dirname(dir));
  fs.cpSync(fixture, dir, { recursive: true });
  edit?.(dir);
  return dir;
};
const run = (...args) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, ["src/index.js", "e2e", ...args], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.ok(Date.now() - t < 3000, "finishes quickly: no daemon, no phone");
  return r;
};
const listing = (dir) => fs.readdirSync(dir, { recursive: true }).sort();
const subst = (dir, file, from, to) => {
  const p = path.join(dir, file);
  assert.ok(fs.readFileSync(p, "utf8").includes(from), `${file} has ${from}`);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(from, to));
};

// Fixture: exit 0, seven files written, headline counts, path of QUALITY.html last.
const dir = copy();
const parent = path.dirname(dir);
const parentBefore = listing(parent);
const model = readE2e(dir);
const q = quality(model);
const before = listing(dir);
let r = run("report", dir);
assert.equal(r.status, 0, r.stdout + r.stderr);
const written = listing(dir).filter((f) => !before.includes(f)).sort();
assert.deepEqual(written, ["PRD.html", "CUJs.html", "QUALITY.html", "QUALITY.md", "TESTCASES.html", "quality.json", "reports/2026-01-02/REPORT.html"].sort());
const lines = r.stdout.trimEnd().split("\n");
assert.ok(lines[0].includes(`${q.capabilities.total} capabilities`), lines[0]);
assert.ok(lines[0].includes(`${q.cases.total} cases`), lines[0]);
assert.equal(lines.at(-1), `Open ${path.resolve(dir, "QUALITY.html")}`);
assert.ok(!r.stdout.includes("problems:"));
assert.deepEqual(listing(parent).filter((f) => !f.startsWith("e2e")), parentBefore.filter((f) => !f.startsWith("e2e")), "nothing outside the folder");
assert.deepEqual(fs.readdirSync(home), [], "HOME untouched: no daemon state");

// --check: current, then stale after an edit, and missing generated files named.
r = run("report", dir, "--check");
assert.equal(r.status, 0, r.stdout);
assert.equal(r.stdout.trim(), "All pages are current.");
const stamp = fs.statSync(path.join(dir, "QUALITY.md")).mtimeMs;
subst(dir, "PRD.md", "#", "# ");
r = run("report", dir, "--check");
assert.equal(r.status, 1);
assert.ok(r.stdout.includes("stale: PRD.html"), r.stdout);
assert.equal(fs.statSync(path.join(dir, "QUALITY.md")).mtimeMs, stamp, "--check writes nothing");
run("report", dir);
fs.rmSync(path.join(dir, "quality.json"));
r = run("report", dir, "--check");
assert.equal(r.status, 1);
assert.equal(r.stdout.trim(), "stale: quality.json");

// --check on a folder that never had pages: all of them, exit 1, nothing written.
const fresh = copy();
const freshBefore = listing(fresh);
r = run("report", "--check", fresh);
assert.equal(r.status, 1);
for (const f of ["PRD.html", "QUALITY.html", "QUALITY.md", "quality.json"]) assert.ok(r.stdout.includes(`stale: ${f}`), f);
assert.deepEqual(listing(fresh), freshBefore);

// Broken reference: exit 1, problem listed as file:line: message, files still written, path still last.
const broken = copy((d) => subst(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R99"));
r = run("report", broken);
assert.equal(r.status, 1);
assert.match(r.stdout, /^\d+ problems?:$/m);
assert.match(r.stdout, /^TESTCASES\.md:\d+: .*R99/m);
assert.ok(fs.existsSync(path.join(broken, "QUALITY.html")));
assert.ok(r.stdout.trimEnd().split("\n").at(-1).startsWith("Open "));

// Default dir is ./e2e of the working directory.
const cwdRun = spawnSync(process.execPath, [path.resolve("src/index.js"), "e2e", "report", "--check"], { cwd: path.dirname(dir), encoding: "utf8", env: { ...process.env, HOME: home } });
assert.equal(cwdRun.status, 1);
assert.equal(cwdRun.stdout.trim(), "stale: quality.json", "reads ./e2e");

// Usage errors and a missing folder: exit 2.
r = run("report", path.join(root, "nope"));
assert.equal(r.status, 2);
assert.equal(r.stdout.trim(), `No such folder: ${path.join(root, "nope")}`);
for (const args of [[], ["nonsense"]]) {
  r = run(...args);
  assert.equal(r.status, 2);
  assert.ok((r.stdout + r.stderr).includes("Usage: codedroid-mcp e2e report [dir] [--check]"));
}

// Direct call.
const { runE2eReport } = await import("../src/e2e-report.js");
assert.equal(runE2eReport({ dir: copy() }).code, 0);

assert.deepEqual(fs.readdirSync(home), [], "HOME still empty");
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("e2e command tests passed");
