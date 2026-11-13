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
  assert.deepEqual(q.capabilities, { total: 6, in_feature: 5, with_case: 4, exercised: 4, passing: 4, not_seen: 2, set_aside: 0 });
  assert.deepEqual(q.set_aside, []);
  // Requirements R1-R4: R3 only has the manual case. Proof: R1 kept (TC-1a kept), R2 screen (TC-1c screen),
  // R4 elsewhere (TC-3a, TC-3b only screen), so at_depth is below with_case.
  assert.deepEqual(q.requirements, { total: 4, with_case: 3, at_depth: 2, acknowledged: 0 });
  // Failures R1.f1, R1.f2 (TC-1b), R2.f1 (no case).
  assert.deepEqual(q.failures, { total: 3, with_case: 2, acknowledged: 0 });
  assert.deepEqual(q.cases, {
    total: 6, setup: 0, by_mode: { phone: 4, task: 1, manual: 1 }, by_tier: { smoke: 1, core: 2, deep: 1, edge: 2 },
  });

  assert.deepEqual(q.by_feature, [
    {
      id: "F1", name: "Notes", priority: "P0",
      // R1 C4, R2 C1+C3, R3 C5; C5 has only the manual case and is not seen.
      capabilities: { total: 4, in_feature: 4, with_case: 3, exercised: 3, passing: 3, not_seen: 1 },
      requirements: { total: 3, with_case: 2, at_depth: 2, acknowledged: 0 },
      failures: { total: 3, with_case: 2, acknowledged: 0 },
      tiers: { smoke: 0, core: 2, deep: 1, edge: 1 }, // TC-1a deep, TC-1b + TC-1c core, TC-2a edge
      deep_cases: 1, deep_gap: null,
    },
    {
      id: "F2", name: "Search", priority: "P1",
      capabilities: { total: 1, in_feature: 1, with_case: 1, exercised: 1, passing: 1, not_seen: 0 }, // C2
      requirements: { total: 1, with_case: 1, at_depth: 0, acknowledged: 0 },
      failures: { total: 0, with_case: 0, acknowledged: 0 },
      tiers: { smoke: 1, core: 0, deep: 0, edge: 1 }, // TC-3a smoke, TC-3b edge
      deep_cases: 0, deep_gap: null,
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

  const edited = (...edits) => quality(readE2e(copy((d) => {
    for (const [f, a, b] of edits) sub(d, f, a, b);
  })));
  const block = (id, feature, covers, mode) =>
    `\n### ${id} · P1 · Added\nFeature: ${feature} · Type: happy\nCovers: ${covers}\nTier: core · Depth: screen\nRun mode: ${mode}\n`;
  const withAdded = (text, ...edits) => quality(readE2e(copy((d) => {
    fs.appendFileSync(path.join(d, "TESTCASES.md"), text);
    for (const [f, a, b] of edits) sub(d, f, a, b);
  })));

  // a. CUJ prefix: TC-10a and TC-11b do not belong to CUJ-1 (TC-1 then a letter, not TC-1x digits).
  const pre = withAdded(block("TC-10a", "F1", "R1", "phone") + block("TC-11b", "F1", "R1", "phone"));
  assert.deepEqual(pre.by_cuj[0].cases, ["TC-1a", "TC-1b", "TC-1c"]);

  // a2. Ids are compared as numbers: zero-padded cases belong to their CUJ, TC-10a and TC-B1 do not.
  const padded = withAdded(block("TC-01d", "F1", "R1", "phone") + block("TC-001e", "F1", "R1", "phone") + block("TC-10a", "F1", "R1", "phone") + block("TC-B1", "F1", "R1", "phone"));
  assert.deepEqual(padded.by_cuj[0].cases, ["TC-1a", "TC-1b", "TC-1c", "TC-01d", "TC-001e"]);
  assert.deepEqual(padded.by_cuj[1].cases, ["TC-2a"]);
  // ...and a zero-padded CUJ id (CUJ-01, CUJ-03) matches TC-1a, TC-03b alike.
  const paddedCuj = withAdded(block("TC-03c", "F2", "R4", "phone"), ["CUJs.md", "### CUJ-1 ·", "### CUJ-01 ·"], ["CUJs.md", "### CUJ-3 ·", "### CUJ-03 ·"]);
  assert.deepEqual(paddedCuj.by_cuj.map((j) => [j.id, j.cases]), [["CUJ-01", ["TC-1a", "TC-1b", "TC-1c"]], ["CUJ-2", ["TC-2a"]], ["CUJ-03", ["TC-3a", "TC-3b", "TC-03c"]]]);

  // a3. A setup case is counted on its own: not in by_tier, not in coverage, and what it lists is ignored.
  const setupOnly = "\n### TC-00 · P1 · Remove leftovers\nFeature: all · Type: setup\nRun mode: phone\n";
  const su = withAdded(setupOnly);
  assert.equal(su.ok, true);
  assert.deepEqual(su.cases, { total: 7, setup: 1, by_mode: { phone: 5, task: 1, manual: 1 }, by_tier: q.cases.by_tier });
  assert.deepEqual(su.by_cuj.map((j) => j.cases), q.by_cuj.map((j) => j.cases));
  const faked = withAdded("\n### TC-00 · P1 · Remove leftovers\nFeature: all · Type: setup\nCovers: R3 (C5), R2.f1\nTier: core · Depth: kept\nRun mode: phone\n");
  assert.deepEqual([faked.capabilities, faked.requirements, faked.failures, faked.cases.by_tier], [q.capabilities, q.requirements, q.failures, q.cases.by_tier]);
  assert.deepEqual(faked.untested, q.untested);

  // a4. A Non-goal line sets C6 aside: out of untested, out of the denominators, listed with its reason.
  const aside = (edit) => quality(readE2e(copy((d) => fs.appendFileSync(path.join(d, "PRD.md"), "\n- Non-goal: C6 · sharing needs a second phone\n"))));
  const as = aside();
  assert.equal(as.ok, true);
  assert.deepEqual(as.capabilities, { total: 6, in_feature: 5, with_case: 4, exercised: 4, passing: 4, not_seen: 1, set_aside: 1 });
  assert.deepEqual(as.untested.map((u) => u.id), ["C5"]);
  assert.deepEqual(as.set_aside, [{ id: "C6", screen: `"Edit note" (NoteEditorFragment)`, control: 'description "Share"', reason: "sharing needs a second phone" }]);
  const asModel = readE2e(copy((d) => fs.appendFileSync(path.join(d, "PRD.md"), "\n- Non-goal: C6 · sharing needs a second phone\n")));
  const asMd = qualityMd(as, asModel);
  assert.match(asMd, /\| Capabilities in scope \| 5 \(1 set aside as non-goals\) \|/);
  assert.match(asMd, /\| Capabilities with a case \| 4 of 5 \(80%\) \|/);
  assert.match(asMd, /## Set aside as non-goals\n\n### "Edit note" \(NoteEditorFragment\)\n\n- C6 · description "Share": sharing needs a second phone/);
  assert.doesNotMatch(asMd, /C6.*not in any feature/);
  assert.doesNotMatch(qualityMd(q, model), /set aside|in scope/i, "nothing about set aside when nothing is");
  // A capability set aside and also in a requirement is a problem, and still leaves the counts.
  const both = quality(readE2e(copy((d) => fs.appendFileSync(path.join(d, "PRD.md"), "\n- Non-goal: C5 · never\n"))));
  assert.equal(both.ok, false);
  assert.equal(both.capabilities.set_aside, 1);
  assert.ok(!both.untested.some((u) => u.id === "C5"));

  // a5. Gaps: acknowledged, never covered. Open = neither covered nor acknowledged, most important first.
  assert.deepEqual(q.open, [
    { ref: "R3", kind: "requirement", what: "R3 · Deleting a note asks first and removes it from the list.: no runnable case" },
    { ref: "R2.f1", kind: "failure", what: 'R2.f1 · a note deleted elsewhere shows "Note not found": no runnable case' },
  ]);
  assert.deepEqual(q.gaps, []);
  const gapText = "\n## Gaps\n- Gap: R2.f1 · cannot be staged\n- Gap: R3 · needs a wipe\n- Gap: F2 deep · one screen\n";
  const gapModel = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), gapText)));
  const gq = quality(gapModel);
  assert.equal(gq.ok, true);
  assert.deepEqual(gq.open, []);
  assert.deepEqual(gq.requirements, { total: 4, with_case: 3, at_depth: 2, acknowledged: 1 });
  assert.deepEqual(gq.failures, { total: 3, with_case: 2, acknowledged: 1 });
  assert.deepEqual(gq.by_feature.map((f) => [f.id, f.deep_cases, f.deep_gap, f.requirements.acknowledged, f.failures.acknowledged]), [["F1", 1, null, 1, 1], ["F2", 0, "one screen", 0, 0]]);
  assert.deepEqual(gq.gaps, [
    { ref: "R2.f1", kind: "failure", reason: "cannot be staged" },
    { ref: "R3", kind: "requirement", reason: "needs a wipe" },
    { ref: "F2", kind: "deep", reason: "one screen" },
  ]);
  const gmd = qualityMd(gq, gapModel);
  assert.match(gmd, /## Left open\n\nNothing is left open\./);
  assert.match(gmd, /## Acknowledged gaps\n\n- R2\.f1: cannot be staged\n- R3: needs a wipe\n- F2 deep: one screen/);
  assert.match(gmd, /\| Requirements acknowledged as gaps \| 1 of 4 \|/);
  const omd = qualityMd(q, model);
  assert.match(omd, /## Left open\n\n- R3 · Deleting a note asks first and removes it from the list\.: no runnable case\n- R2\.f1 · /);
  assert.doesNotMatch(omd, /## Acknowledged gaps/);
  assert.match(omd, /\| Left open \| 2 \|/);
  // A P0 feature with no deep case is open, and comes first; a deep gap closes it.
  const noDeep = quality(readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Tier: core · Depth: kept"))));
  assert.deepEqual(noDeep.open[0], { ref: "F1", kind: "deep", what: "F1 · Notes is P0 and has no deep case" });
  assert.equal(noDeep.open.length, 3);
  assert.deepEqual(quality(readE2e(copy((d) => { sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Tier: core · Depth: kept"); fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Gaps\n- Gap: F1 deep · reason\n"); }))).open.map((o) => o.ref), ["R3", "R2.f1"]);
  // A manual deep case is a deep case; a setup case is not a case at all. A manual case leaves a requirement open.
  assert.equal(withAdded("\n### TC-1z · P1 · Added\nFeature: F1 · Type: happy\nCovers: R3\nTier: deep · Depth: screen\nRun mode: manual\n").open.length, 2);
  // A gap that also has a case is a problem and does not count as acknowledged.
  const both2 = quality(readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Gaps\n- Gap: R4 · x\n"))));
  assert.equal(both2.ok, false);
  assert.equal(both2.requirements.acknowledged, 0);

  // b. Manual plus a not-run runnable case on C2: with a case, not exercised, not passing, not untested.
  const mnr = withAdded(block("TC-4a", "F2", "R4 (C2)", "manual"),
    ["reports/2026-01-02/REPORT.md", "| TC-3a | pass |", "| TC-3a | not run |"],
    ["reports/2026-01-02/REPORT.md", "| TC-3b | fail |", "| TC-3b | not run |"]);
  assert.deepEqual(mnr.capabilities, { total: 6, in_feature: 5, with_case: 4, exercised: 3, passing: 3, not_seen: 2, set_aside: 0 });
  assert.deepEqual(mnr.untested.map((u) => u.id), ["C5", "C6"]);

  // c. R2.f1 covered only by a manual case: failures with_case stays 2 (R1.f1, R1.f2).
  assert.deepEqual(withAdded(block("TC-1d", "F1", "R2.f1", "manual")).failures, { total: 3, with_case: 2, acknowledged: 0 });
  // ...and a runnable case does count it.
  assert.deepEqual(withAdded(block("TC-1d", "F1", "R2.f1", "phone")).failures, { total: 3, with_case: 3, acknowledged: 0 });

  // d. Any one case suffices. R4 is elsewhere: TC-3a is screen, TC-3b made elsewhere -> at_depth (3 of 4).
  assert.equal(edited(["TESTCASES.md", "Covers: R4\nTier: edge · Depth: screen", "Covers: R4\nTier: edge · Depth: elsewhere"]).requirements.at_depth, 3);
  // Order does not matter: R1 (kept) is covered by TC-1a (kept, first in the file) and an added shallow TC-1e (screen, last).
  assert.equal(withAdded(block("TC-1e", "F1", "R1", "phone")).requirements.at_depth, 2); // R1 and R2, as in the fixture
  // C2 by TC-3a pass + TC-3b fail (the fixture as is): passing. By TC-3a not run + TC-3b fail: exercised, not passing.
  assert.equal(q.capabilities.passing, 4);
  const nf = edited(["reports/2026-01-02/REPORT.md", "| TC-3a | pass |", "| TC-3a | not run |"]);
  assert.equal(nf.capabilities.exercised, 4);
  assert.equal(nf.capabilities.passing, 3);
  // By TC-3a not run + TC-3b not run: neither.
  const nn = edited(["reports/2026-01-02/REPORT.md", "| TC-3a | pass |", "| TC-3a | not run |"], ["reports/2026-01-02/REPORT.md", "| TC-3b | fail |", "| TC-3b | not run |"]);
  assert.equal(nn.capabilities.exercised, 3);

  // e. Empty bracket alone: R4 lists C2 and C6; TC-3a "R4" reaches both, TC-3b is moved off R4.
  const prd = ["PRD.md", "  Caps: C2\n", "  Caps: C2, C6\n"];
  const off = ["TESTCASES.md", "Covers: R4\nTier: edge", "Covers: R2.f1\nTier: edge"];
  const e1 = edited(prd, off, ["TESTCASES.md", "Covers: R4 (C2)", "Covers: R4"]);
  assert.equal(e1.capabilities.with_case, 5); // C4, C1, C3 plus C2 and C6 through the empty bracket
  assert.ok(!e1.untested.some((u) => u.id === "C2" || u.id === "C6"));
  // With a bracket naming only C6, C2 is not reached.
  const e2 = edited(prd, off, ["TESTCASES.md", "Covers: R4 (C2)", "Covers: R4 (C6)"]);
  assert.equal(e2.capabilities.with_case, 4); // C4, C1, C3, C6
  assert.deepEqual(e2.untested.filter((u) => u.id === "C2").map((u) => u.why), ["no case"]);

  // A bracket naming a capability outside the requirement's Caps (C6 in R4) is a problem and not counted.
  const out = edited(["TESTCASES.md", "Covers: R4 (C2)", "Covers: R4 (C6)"], ["TESTCASES.md", "Covers: R4\nTier: edge", "Covers: R2.f1\nTier: edge"]);
  assert.equal(out.ok, false);
  assert.equal(out.capabilities.with_case, 3); // C4, C1, C3; neither C6 nor C2
  assert.deepEqual(out.untested.map((u) => u.id), ["C2", "C5", "C6"]);

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
