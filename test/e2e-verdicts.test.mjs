/**
 * `codedroid-mcp e2e verdicts`: validates the verifier's JSON Lines and appends rows to VERIFY.md.
 *
 * Run: node test/e2e-verdicts.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { caseHash } from "../src/e2e-verify.js";
import { recordVerdicts } from "../src/e2e-verdicts.js";

const fixture = new URL("./fixtures/e2e-sample", import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-verdicts-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-verdicts-home-"));
let n = 0;
const copy = (edit) => {
  const dir = path.join(root, `case${n++}`, "e2e");
  fs.mkdirSync(path.dirname(dir));
  fs.cpSync(fixture, dir, { recursive: true });
  edit?.(dir);
  return dir;
};
const NOW = new Date(2026, 10, 20, 12, 0, 0); // local 2026-11-20
const v = (id, verdict, reason = "R1: a reason", by = "independent") => ({ id, verdict, by, reason });
const put = (dir, objs) => {
  const f = path.join(path.dirname(dir), `v${n++}.jsonl`);
  fs.writeFileSync(f, objs.map((o) => (typeof o === "string" ? o : JSON.stringify(o))).join("\n") + "\n");
  return f;
};
const rec = (dir, objs) => recordVerdicts({ dir, file: put(dir, objs), now: NOW });
const verifyBytes = (dir) => fs.readFileSync(path.join(dir, "VERIFY.md"));
const status = (dir, id) => readE2e(dir).cases.find((c) => c.id === id).verify;

try {
  // A valid file: rows appended, readE2e reads the statuses.
  let dir = copy();
  const before = verifyBytes(dir);
  let r = rec(dir, [v("TC-1c", "approved"), v("TC-3b", "repair"), "", v("TC-2a", "reopen")].filter((x, i) => i !== 3));
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.deepEqual(r.lines, ["TC-1c: approved (attempt 2 of 3)", "TC-3b: repair (attempt 1 of 3)", 'Run "e2e report" to update the pages.']);
  const after = verifyBytes(dir);
  assert.ok(after.subarray(0, before.length).equals(before), "existing rows untouched");
  const m = readE2e(dir);
  assert.deepEqual(m.problems, []);
  assert.equal(status(dir, "TC-1c").status, "approved");
  assert.equal(status(dir, "TC-3b").status, "repair");
  assert.equal(status(dir, "TC-3b").attempt, 1);
  const last = m.verify.rows.at(-1);
  assert.deepEqual([last.item, last.attempt, last.date, last.text], ["TC-3b", 1, "2026-11-20", caseHash(m, "TC-3b")]);
  assert.ok(after.toString().endsWith(" |\n"));

  // New file: header written; reopen of an unresolved case then approved is attempt 1 of a new cycle.
  dir = copy((d) => fs.rmSync(path.join(d, "VERIFY.md")));
  r = rec(dir, [v("TC-1a", "repair"), v("TC-1b", "question")]);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.ok(verifyBytes(dir).toString().startsWith("# Verifier verdicts\n\nWritten by `e2e verdicts`. Do not edit by hand.\n\n| Item | Attempt | Verdict | By | Text | Date | Reason |\n| --- | --- | --- | --- | --- | --- | --- |\n| TC-1a | 1 | repair |"));
  assert.equal(status(dir, "TC-1b").status, "question");

  // Three attempts, then a fourth is refused; reopen, then approved starts a new cycle.
  dir = copy();
  assert.equal(status(dir, "TC-3a").status, "unresolved");
  const snap = verifyBytes(dir);
  r = rec(dir, [v("TC-3a", "repair")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /v\d+\.jsonl:1: TC-3a has had three attempts: only "reopen", on the user's word, allows more$/);
  assert.ok(verifyBytes(dir).equals(snap));
  r = rec(dir, [v("TC-3a", "reopen", "the user allowed more")]);
  assert.deepEqual(r.lines, ["TC-3a: reopened", 'Run "e2e report" to update the pages.']);
  assert.ok(verifyBytes(dir).toString().includes("| TC-3a | 0 | reopen |"));
  r = rec(dir, [v("TC-3a", "approved")]);
  assert.equal(r.lines[0], "TC-3a: approved (attempt 1 of 3)");
  assert.equal(status(dir, "TC-3a").status, "approved");

  // Refusals: each leaves VERIFY.md byte-identical and names the line.
  dir = copy();
  const bytes = verifyBytes(dir);
  const refuse = (objs, re, code = 2) => {
    const x = rec(dir, objs);
    assert.equal(x.code, code, x.lines.join("\n"));
    assert.match(x.lines.join("\n"), re);
    assert.ok(verifyBytes(dir).equals(bytes), "VERIFY.md unchanged");
    return x;
  };
  refuse(["{nope"], /:1: .*JSON/);
  refuse([{ id: "TC-1c", verdict: "repair", by: "same" }], /:1: .*missing.*reason/);
  refuse([{ ...v("TC-1c", "repair"), extra: 1 }], /:1: .*unexpected.*extra/);
  refuse([{ ...v("TC-1c", "repair"), reason: 5 }], /:1: .*reason.*string/);
  refuse(["[1]"], /:1: .*object/);
  refuse([v("TC-99", "repair")], /:1: TC-99 is not a current, judged case/);
  refuse([v("TC-1c", "maybe")], /:1: verdict must be approved, repair, question or reopen/);
  refuse([v("TC-1c", "repair", "r", "robot")], /:1: by must be independent or same/);
  refuse([v("TC-1c", "repair", " \n ")], /:1: reason is empty/);
  refuse([v("TC-1c", "repair"), v("TC-1c", "approved")], /:2: TC-1c appears twice/);
  refuse([v("TC-1c", "reopen")], /:1: TC-1c is not unresolved: "reopen" is only for a case that used its three attempts/);
  const multi = refuse([v("TC-1c", "repair"), "{x", v("TC-99", "repair"), v("TC-3b", "repair")], /:2: .*\n.*:3: /);
  assert.equal(multi.lines.length, 2);
  assert.equal(recordVerdicts({ dir, file: path.join(root, "nope.jsonl"), now: NOW }).lines[0], `No such file: ${path.join(root, "nope.jsonl")}`);
  const empty = path.join(root, "empty.jsonl");
  fs.writeFileSync(empty, "\n\n");
  assert.deepEqual(recordVerdicts({ dir, file: empty, now: NOW }), { code: 2, lines: [`${empty} holds no verdicts`] });
  assert.equal(recordVerdicts({ dir: path.join(root, "nodir"), file: empty, now: NOW }).lines[0], `No such folder: ${path.join(root, "nodir")}`);

  // Invalid ledger row for the case; document problems; no table header.
  dir = copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-1c | x | repair | independent | 0123456789abcdef | 2026-11-14 | r |\n"));
  let bytes2 = verifyBytes(dir);
  r = rec(dir, [v("TC-1c", "repair")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /:1: TC-1c has an unreadable row in VERIFY.md: fix the file first$/);
  assert.ok(verifyBytes(dir).equals(bytes2));
  dir = copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-1c · P1 · duplicate\n"));
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.deepEqual(r, { code: 2, lines: ['the documents have problems: run "e2e report" and fix them first'] });
  dir = copy((d) => fs.writeFileSync(path.join(d, "VERIFY.md"), "just notes\n"));
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.deepEqual(r, { code: 2, lines: ["VERIFY.md has no verdict table: delete it or restore it"] });
  assert.equal(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf8"), "just notes\n");

  // A file without a final newline gets one first.
  dir = copy((d) => { const p = path.join(d, "VERIFY.md"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").trimEnd()); });
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.equal(r.code, 0);
  assert.deepEqual(readE2e(dir).problems, []);

  // A reason with pipes, a line break and <script> round-trips.
  dir = copy();
  r = rec(dir, [v("TC-3b", "repair", "a | b\nc <script>alert(1)</script> \\| `x`")]);
  assert.equal(r.code, 0);
  assert.equal(status(dir, "TC-3b").reason, "a | b c <script>alert(1)</script> \\| `x`");

  // A symlinked VERIFY.md leading outside is refused and nothing is written through it.
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, "keep\n");
  dir = copy((d) => { fs.rmSync(path.join(d, "VERIFY.md")); fs.symlinkSync(outside, path.join(d, "VERIFY.md")); });
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /^Refusing to write VERIFY\.md: it is a link or leads outside /);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");

  // The real binary: HOME stays empty; usage errors.
  dir = copy();
  const file = put(dir, [v("TC-3b", "repair")]);
  const run = (...args) => spawnSync(process.execPath, ["src/index.js", "e2e", ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: home, USERPROFILE: home } });
  let b = run("verdicts", file, dir);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, 'TC-3b: repair (attempt 1 of 3)\nRun "e2e report" to update the pages.\n');
  assert.deepEqual(fs.readdirSync(home), []);
  for (const args of [["verdicts"], ["verdicts", file, dir, "extra"]]) {
    b = run(...args);
    assert.equal(b.status, 2);
    assert.equal(b.stderr, "Usage: codedroid-mcp e2e verdicts <file> [dir]\n");
  }
  b = run("verdicts", path.join(root, "nope"), dir);
  assert.equal(b.status, 2);

  // Property: any reason survives the round trip as itself with line breaks folded to one space and the ends trimmed.
  const seed = Number(process.env.SEED ?? Date.now() % 1e9);
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const alphabet = ["|", "\\", "`", "<", ">", '"', "'", " ", "\t", "\n", "\r\n", "a", "Z", "7", "é", "ß", "日", "|", "\\"];
  try {
    for (let i = 0; i < 300; i++) {
      const input = Array.from({ length: 1 + Math.floor(rnd() * 24) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      const want = input.replace(/[\r\n]+/g, " ").trim();
      const d = copy((x) => fs.rmSync(path.join(x, "VERIFY.md")));
      const out = rec(d, [v("TC-3b", "repair", input)]);
      if (!want) { assert.equal(out.code, 2, JSON.stringify(input)); continue; }
      assert.equal(out.code, 0, `${JSON.stringify(input)}: ${out.lines}`);
      const mm = readE2e(d);
      assert.deepEqual(mm.problems, [], JSON.stringify(input));
      assert.equal(mm.cases.find((c) => c.id === "TC-3b").verify.reason, want, JSON.stringify(input));
    }
  } catch (e) {
    console.error(`property test failed with SEED=${seed}`);
    throw e;
  }
  console.log("e2e verdicts: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
