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

// Open items (no case, no Gap line) are not problems: exit 0, one line before the path.
assert.equal(q.open.length, 2);
assert.equal(lines.at(-2), `2 left open (no case and no Gap line): see ${dir}/QUALITY.md`);
const acked = copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Gaps\n- Gap: R3 · needs a wipe\n- Gap: R2.f1 · cannot be staged\n"));
r = run("report", acked);
assert.equal(r.status, 0, r.stdout + r.stderr);
assert.ok(!r.stdout.includes("left open"), r.stdout);
assert.ok(r.stdout.split("\n")[0].includes("2 acknowledged") || r.stdout.split("\n")[0].includes("1 acknowledged"), r.stdout);
const oneOpen = copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Gaps\n- Gap: R3 · needs a wipe\n"));
r = run("report", oneOpen);
assert.equal(r.stdout.split("\n").at(-3), `1 left open (no case and no Gap line): see ${oneOpen}/QUALITY.md`);
assert.ok(fs.readFileSync(path.join(oneOpen, "QUALITY.md"), "utf8").includes("## Left open"), "the named file has the list");
r = run("report", oneOpen + "/");
assert.ok(r.stdout.includes(`see ${oneOpen}/QUALITY.md`), "no double slash");

// Written in stages: a clean INVENTORY.md alone exits 0 and names what comes next; counts take the singular.
const early = copy((d) => {
  for (const f of ["PRD.md", "CUJs.md", "TESTCASES.md", "reports"]) fs.rmSync(path.join(d, f), { recursive: true });
  fs.writeFileSync(path.join(d, "INVENTORY.md"), '## S1 · ListFragment · "Notes"\n| Id | Control | Does | Source | States | Seen |\n| --- | --- | --- | --- | --- | --- |\n| C1 | text "New" | opens the editor | a.kt:1 | | yes |\n');
});
r = run("report", early);
assert.equal(r.status, 0, r.stdout + r.stderr);
assert.deepEqual(r.stdout.split("\n").slice(0, 2), [
  "1 capability, 0 with a case; 0 requirements, 0 with a case, 0 tested deep enough; 0 failures, 0 with a case; 0 cases.",
  "Not written yet: PRD.md, CUJs.md, TESTCASES.md. Next: PRD.md.",
]);
const one = copy((d) => {
  fs.rmSync(path.join(d, "reports"), { recursive: true });
  const t = fs.readFileSync(path.join(d, "TESTCASES.md"), "utf8");
  fs.writeFileSync(path.join(d, "TESTCASES.md"), t.slice(0, t.indexOf("### TC-1b")));
  subst(d, "PRD.md", "Proof: kept", "Proof: deep");
});
r = run("report", one);
assert.equal(r.status, 1);
assert.match(r.stdout, /; 1 case\.\n1 problem:\n/);

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

// Links never lead a write outside the folder; a refusal writes nothing at all.
const outside = path.join(root, "outside");
fs.mkdirSync(outside);
const target = path.join(outside, "target");
fs.writeFileSync(target, "precious");
const linkedFile = copy((d) => fs.symlinkSync(target, path.join(d, "QUALITY.md")));
r = run("report", linkedFile);
assert.equal(r.status, 2, r.stdout);
assert.equal(r.stdout.trim(), `Refusing to write QUALITY.md: it is a link or leads outside ${linkedFile}`);
assert.equal(fs.readFileSync(target, "utf8"), "precious");
assert.ok(!fs.existsSync(path.join(linkedFile, "PRD.html")), "nothing written after a refusal");
const outDir = path.join(outside, "reports-dir");
fs.mkdirSync(outDir);
const linkedDir = copy((d) => {
  fs.rmSync(path.join(d, "reports/2026-01-02"), { recursive: true });
  fs.cpSync(path.join(fixture, "reports/2026-01-02"), outDir, { recursive: true });
  fs.symlinkSync(outDir, path.join(d, "reports/2026-01-02"));
});
const outBefore = listing(outDir);
r = run("report", linkedDir);
assert.equal(r.status, 2, r.stdout);
assert.ok(r.stdout.startsWith("Refusing to write reports/2026-01-02/REPORT.html"), r.stdout);
assert.deepEqual(listing(outDir), outBefore);
assert.ok(!fs.existsSync(path.join(linkedDir, "QUALITY.md")), "nothing written after a refusal");
const real = copy();
const viaLink = path.join(root, "link-to-e2e");
fs.symlinkSync(real, viaLink);
r = run("report", viaLink);
assert.equal(r.status, 0, r.stdout);
assert.ok(fs.existsSync(path.join(real, "QUALITY.html")), "a linked folder is fine");

// A write failure is exit 2, not 1 (1 means the documents have problems).
if (process.getuid?.() !== 0) {
  const ro = copy();
  fs.chmodSync(ro, 0o555);
  try {
    r = run("report", ro);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout.trim(), /^Cannot write \S+: .+/);
    assert.equal(r.stdout.trim().split("\n").length, 1);
  } finally {
    fs.chmodSync(ro, 0o755);
  }
}

// More than 20 problems: a summary per kind, the first 20, and a pointer to the page.
const many = copy((d) => {
  for (const f of fs.readdirSync(d)) if (f.endsWith(".md")) fs.rmSync(path.join(d, f));
  fs.rmSync(path.join(d, "reports"), { recursive: true });
  fs.writeFileSync(path.join(d, "PRD.md"), "# PRD\n");
  fs.writeFileSync(path.join(d, "TESTCASES.md"), Array.from({ length: 25 }, (_, i) => `### TC-${i + 1}a · P1 · Case ${i}\nFeature: F1 · Type: happy\nTier: core · Depth: screen\nRun mode: phone\n`).join("\n"));
});
const total = readE2e(many).problems.length;
assert.ok(total > 20);
r = run("report", many);
assert.equal(r.status, 1);
const out = r.stdout.split("\n");
assert.equal(out.find((l) => l.endsWith("problems:")), `${total} problems:`);
assert.ok(out.includes("  25 × <id> has no Covers: line"), r.stdout);
assert.equal(out.filter((l) => /^\S+:\d+: /.test(l)).length, 20);
assert.ok(out.includes(`and ${total - 20} more: see ${many}/QUALITY.md`), r.stdout);

assert.deepEqual(fs.readdirSync(home), [], "HOME still empty");
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("e2e command tests passed");
