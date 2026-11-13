/**
 * quality / qualityMd / qualityJson: coverage counted from the e2e model of test/fixtures/e2e-sample.
 * Every expected number is written by hand from the fixture.
 *
 * Run: node test/e2e-quality.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { quality, qualityJson, qualityMd } from "../src/e2e-quality.js";

const fixture = new URL("./fixtures/e2e-sample", import.meta.url).pathname;
const tmps = [];
const copy = (edit) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-quality-"));
  tmps.push(dir);
  fs.cpSync(fixture, dir, { recursive: true });
  edit?.(dir);
  return dir;
};
const sub = (dir, file, from, to) => {
  const p = path.join(dir, file);
  const s = fs.readFileSync(p, "utf8");
  assert.ok(s.includes(from), `${file} has ${from}`);
  fs.writeFileSync(p, s.replace(from, to));
};

try {
  const model = readE2e(fixture);
  const q = quality(model);
  assert.equal(q.ok, true);
  assert.deepEqual(q.problems, []);
  assert.equal(q.verified, "not verified");

  // Capabilities: C1-C6. C1-C5 are in a requirement's Caps (C6 in none). Runnable cases cover C4 (TC-1a),
  // C1+C3 (TC-1c), C2 (TC-3a, TC-3b); C5 only by the manual TC-2a. Reports: TC-1a/1b/1c/3a pass, TC-3b fail.
  // not_seen: C5 ("no: ...") and C6 ("?").
  assert.deepEqual(q.capabilities, { total: 6, in_feature: 5, with_case: 4, exercised: 4, passing: 4, not_seen: 2 });
  // Requirements R1-R4: R3 only has the manual case. Proof: R1 kept (TC-1a kept), R2 screen (TC-1c screen),
  // R4 elsewhere (TC-3a, TC-3b only screen), so at_depth is below with_case.
  assert.deepEqual(q.requirements, { total: 4, with_case: 3, at_depth: 2 });
  // Failures R1.f1, R1.f2 (TC-1b), R2.f1 (no case).
  assert.deepEqual(q.failures, { total: 3, with_case: 2 });
  assert.deepEqual(q.cases, {
    total: 6, by_mode: { phone: 4, task: 1, manual: 1 }, by_tier: { smoke: 1, core: 2, deep: 1, edge: 2 },
  });

  assert.deepEqual(q.by_feature, [
    {
      id: "F1", name: "Notes", priority: "P0",
      // R1 C4, R2 C1+C3, R3 C5; C5 has only the manual case and is not seen.
      capabilities: { total: 4, in_feature: 4, with_case: 3, exercised: 3, passing: 3, not_seen: 1 },
      requirements: { total: 3, with_case: 2, at_depth: 2 },
      failures: { total: 3, with_case: 2 },
      tiers: { smoke: 0, core: 2, deep: 1, edge: 1 }, // TC-1a deep, TC-1b + TC-1c core, TC-2a edge
    },
    {
      id: "F2", name: "Search", priority: "P1",
      capabilities: { total: 1, in_feature: 1, with_case: 1, exercised: 1, passing: 1, not_seen: 0 }, // C2
      requirements: { total: 1, with_case: 1, at_depth: 0 },
      failures: { total: 0, with_case: 0 },
      tiers: { smoke: 1, core: 0, deep: 0, edge: 1 }, // TC-3a smoke, TC-3b edge
    },
  ]);

  assert.deepEqual(q.by_cuj, [
    {
      id: "CUJ-1", title: "Write a note and find it again", requirements: ["R1", "R2"],
      cases: ["TC-1a", "TC-1b", "TC-1c"],
      capabilities: { total: 3, in_feature: 3, with_case: 3, exercised: 3, passing: 3, not_seen: 0 }, // C4 C1 C3
    },
    {
      id: "CUJ-2", title: "Delete a note", requirements: ["R3"], cases: ["TC-2a"],
      capabilities: { total: 1, in_feature: 1, with_case: 0, exercised: 0, passing: 0, not_seen: 1 }, // C5
    },
    {
      id: "CUJ-3", title: "Find a note by title", requirements: ["R4"], cases: ["TC-3a", "TC-3b"],
      capabilities: { total: 1, in_feature: 1, with_case: 1, exercised: 1, passing: 1, not_seen: 0 }, // C2
    },
  ]);

  // C5: only the manual TC-2a. C6: in no requirement.
  assert.deepEqual(q.untested, [
    { id: "C5", screen: `"Edit note" (NoteEditorFragment)`, control: 'description "Delete note"', why: "manual case only" },
    { id: "C6", screen: `"Edit note" (NoteEditorFragment)`, control: 'description "Share"', why: "not in any feature" },
  ]);

  // Markdown.
  const md = qualityMd(q, model);
  assert.match(md, /^# /);
  assert.match(md, /counts of the documents, not test results/);
  assert.match(md, /Nothing has been verified by the verifier yet/);
  assert.doesNotMatch(md, /## Problems/);
  assert.doesNotMatch(md, /NaN/);
  assert.match(md, /F1 · Notes/);
  assert.match(md, /CUJ-2/);
  assert.match(md, /Edit note/);
  assert.match(md, /C5.*Delete note.*manual case only/);
  assert.match(md, /C6.*Share.*not in any feature/);
  assert.match(md, /67%/); // F1 requirements with_case 2 of 3
  assert.match(md, /–/); // F2 failures: zero denominator

  // JSON.
  const now = new Date("2026-01-03T04:05:06.000Z");
  const raw = qualityJson(q, model, now);
  assert.ok(raw.startsWith('{\n  "'), "two-space indented");
  const j = JSON.parse(raw);
  assert.equal(j.generated, "2026-01-03T04:05:06.000Z");
  assert.deepEqual(j.sources, model.files);
  assert.deepEqual(j.capabilities, q.capabilities);
  assert.ok(Object.keys(j.sources).includes("TESTCASES.md"));

  // No reports folder: nothing exercised or passing.
  const noRep = quality(readE2e(copy((d) => fs.rmSync(path.join(d, "reports"), { recursive: true }))));
  assert.equal(noRep.capabilities.exercised, 0);
  assert.equal(noRep.capabilities.passing, 0);
  assert.equal(noRep.capabilities.with_case, 4);

  // A failing case is exercised but not passing: TC-3a not run, TC-3b fail leaves C2 exercised, not passing.
  const rep = quality(readE2e(copy((d) => {
    sub(d, "reports/2026-01-02/REPORT.md", "| TC-3a | pass |", "| TC-3a | not run |");
  })));
  assert.equal(rep.capabilities.exercised, 4); // C2 still via TC-3b fail
  assert.equal(rep.capabilities.passing, 3); // C2 loses its only pass

  // Problems: an undefined capability in a bracket. Reported, never counted, ok false, listed first.
  const bad = readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R1 (C4)", "Covers: R1 (C9)")));
  const qb = quality(bad);
  assert.equal(qb.ok, false);
  assert.deepEqual(qb.problems, [{ file: "TESTCASES.md", line: 5, message: "C9 is referenced but not defined" }]);
  assert.equal(qb.capabilities.total, 6);
  assert.equal(qb.capabilities.with_case, 4); // C9 is dropped; C4 stays covered by TC-1b (R1.f1 (C4))
  const mdb = qualityMd(qb, bad);
  assert.match(mdb, /## Problems\n\n- TESTCASES\.md:5: C9 is referenced but not defined/);
  assert.match(mdb, /counts below may be wrong/);
  assert.ok(mdb.indexOf("## Problems") < mdb.indexOf("## By feature"));

  // An undefined requirement in Covers is ignored too (no crash, no count).
  const bad2 = quality(readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R4\n", "Covers: R4, R9\n"))));
  assert.equal(bad2.ok, false);
  assert.equal(bad2.requirements.total, 4);

  console.log("ok e2e-quality");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
