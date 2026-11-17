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
import { pct, quality, qualityJson, qualityMd } from "../src/e2e-quality.js";

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
  // C2 is exercised but not passing: TC-3b on it failed. not_seen: C5 ("no: ...") and C6 ("?").
  assert.deepEqual(q.capabilities, { total: 6, in_feature: 5, with_case: 4, exercised: 4, passing: 3, not_seen: 2, set_aside: 0 });
  assert.deepEqual(q.set_aside, []);
  // Requirements R1-R4: R3 only has the manual case. Proof: R1 kept (TC-1a kept), R2 screen (TC-1c screen),
  // R4 elsewhere (TC-3a, TC-3b only screen), so at_depth is below with_case.
  assert.deepEqual(q.requirements, { total: 4, with_case: 3, at_depth: 2, acknowledged: 0, depth_acknowledged: 0, no_cuj: [] });
  // Failures R1.f1, R1.f2 (TC-1b), R2.f1 (no case).
  assert.deepEqual(q.failures, { total: 3, with_case: 2, acknowledged: 0 });
  assert.deepEqual(q.cases, {
    total: 6, setup: 0, retired: 0, by_mode: { phone: 4, task: 1, manual: 1 }, by_tier: { smoke: 1, core: 2, deep: 1, edge: 2 },
  });

  assert.deepEqual(q.by_feature, [
    {
      id: "F1", name: "Notes", priority: "P0",
      // R1 C4, R2 C1+C3, R3 C5; C5 has only the manual case and is not seen.
      capabilities: { total: 4, in_feature: 4, with_case: 3, exercised: 3, passing: 3, not_seen: 1 },
      requirements: { total: 3, with_case: 2, at_depth: 2, acknowledged: 0, depth_acknowledged: 0 },
      failures: { total: 3, with_case: 2, acknowledged: 0 },
      tiers: { smoke: 0, core: 2, deep: 1, edge: 1 }, // TC-1a deep, TC-1b + TC-1c core, TC-2a edge
      deep_cases: 1, deep_gap: null,
    },
    {
      id: "F2", name: "Search", priority: "P1",
      capabilities: { total: 1, in_feature: 1, with_case: 1, exercised: 1, passing: 0, not_seen: 0 }, // C2: TC-3b failed
      requirements: { total: 1, with_case: 1, at_depth: 0, acknowledged: 0, depth_acknowledged: 0 },
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
      capabilities: { total: 1, in_feature: 1, with_case: 1, exercised: 1, passing: 0, not_seen: 0 }, // C2: TC-3b failed
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
  assert.match(md, /66%/); // F1 requirements with_case 2 of 3, rounded down
  assert.match(md, /–/); // F2 failures: zero denominator

  // JSON.
  const raw = qualityJson(q, model);
  assert.ok(raw.startsWith('{\n  "'), "two-space indented");
  const j = JSON.parse(raw);
  assert.ok(!("generated" in j), "no timestamp");
  const twice = [copy(), copy()].map((d) => { const m = readE2e(d); return qualityJson(quality(m), m); });
  assert.equal(twice[0], twice[1], "two copies of the same folder give the same quality.json");
  assert.deepEqual(j.sources, Object.fromEntries(Object.entries(model.files).map(([n, f]) => [n, f.sha256])), "sources: name relative to the folder, sha256 only");
  assert.deepEqual(j.capabilities, q.capabilities);
  assert.ok(Object.keys(j.sources).includes("TESTCASES.md"));

  // No reports folder: nothing exercised or passing, and the rows say there is no report rather than 0%.
  const noRepModel = readE2e(copy((d) => fs.rmSync(path.join(d, "reports"), { recursive: true })));
  const noRep = quality(noRepModel);
  assert.equal(noRep.capabilities.exercised, 0);
  assert.equal(noRep.capabilities.passing, 0);
  assert.equal(noRep.capabilities.with_case, 4);
  const noRepMd = qualityMd(noRep, noRepModel);
  assert.match(noRepMd, /\| Capabilities exercised in the last report \| no report yet \|/);
  assert.match(noRepMd, /\| Capabilities passing in the last report \| no report yet \|/);
  assert.match(md, /\| Capabilities exercised in the last report \| 4 of 6 \(66%\) \|/, "with a report: the count");

  // Labels and rounding. Percentages round down; 100% only when all, 0% only when none, <1% below 1%.
  assert.match(md, /\| Requirements with a case deep enough \| 2 of 4 \(50%\) \|/);
  assert.doesNotMatch(md, /tested deep enough/);
  assert.deepEqual([pct(199, 200), pct(1, 201), pct(200, 200), pct(0, 7), pct(2, 3), pct(1, 100), pct(0, 0)], ["99%", "<1%", "100%", "0%", "66%", "1%", "–"]);
  assert.match(md, /## By feature\n[\s\S]*?\n\nA control used by requirements of two features is counted in both rows, so the rows can add up to more than the headline\.\n/);
  // Cases with no valid run mode: the split says how many.
  const noModeModel = readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: core · Depth: screen\nRun mode: task\n", "Tier: core · Depth: screen\n")));
  assert.match(qualityMd(quality(noModeModel), noModeModel), /\| Cases \| 6 \(4 phone, 0 task, 1 manual, 1 with no run mode\) \|/);
  assert.match(md, /\| Cases \| 6 \(4 phone, 1 task, 1 manual\) \|/, "nothing appended when the parts add up");
  // A requirement with no valid Proof: is never deep enough, and is not called too shallow either (it is a problem).
  for (const bad of ["  Proof: deep\n", ""]) {
    const np = quality(readE2e(copy((d) => sub(d, "PRD.md", "  Caps: C1, C3\n  Proof: screen\n", `  Caps: C1, C3\n${bad}`))));
    assert.equal(np.ok, false);
    assert.equal(np.requirements.at_depth, 1, `R2 with ${JSON.stringify(bad)}: only R1 is deep enough`);
    assert.equal(np.by_feature[0].requirements.at_depth, 1);
    assert.ok(!np.open.some((o) => o.ref === "R2"), "R2 is not listed as too shallow");
  }

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
  assert.deepEqual(su.cases, { total: 7, setup: 1, retired: 0, by_mode: { phone: 5, task: 1, manual: 1 }, by_tier: q.cases.by_tier });
  assert.deepEqual(su.by_cuj.map((j) => j.cases), q.by_cuj.map((j) => j.cases));
  const faked = withAdded("\n### TC-00 · P1 · Remove leftovers\nFeature: all · Type: setup\nCovers: R3 (C5), R2.f1\nTier: core · Depth: kept\nRun mode: phone\n");
  assert.deepEqual([faked.capabilities, faked.requirements, faked.failures, faked.cases.by_tier], [q.capabilities, q.requirements, q.failures, q.cases.by_tier]);
  assert.deepEqual(faked.untested, q.untested);

  // a4. A Non-goal line sets C6 aside: out of untested, out of the denominators, listed with its reason.
  const aside = (edit) => quality(readE2e(copy((d) => fs.appendFileSync(path.join(d, "PRD.md"), "\n- Non-goal: C6 · sharing needs a second phone\n"))));
  const as = aside();
  assert.equal(as.ok, true);
  assert.deepEqual(as.capabilities, { total: 6, in_feature: 5, with_case: 4, exercised: 4, passing: 3, not_seen: 1, set_aside: 1 });
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
    { ref: "R4", kind: "shallow", what: "R4 must be checked at elsewhere; the deepest case checks screen" },
    { ref: "R2.f1", kind: "failure", what: 'R2.f1 · a note deleted elsewhere shows "Note not found": no runnable case' },
  ]);
  assert.deepEqual(q.gaps, []);
  const gapText = "\n## Gaps\n- Gap: R2.f1 · cannot be staged\n- Gap: R3 · needs a wipe\n- Gap: F2 deep · one screen\n- Gap: R4 depth · no second screen\n";
  const gapModel = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), gapText)));
  const gq = quality(gapModel);
  assert.equal(gq.ok, true);
  assert.deepEqual(gq.open, []);
  assert.deepEqual(gq.requirements, { total: 4, with_case: 3, at_depth: 2, acknowledged: 1, depth_acknowledged: 1, no_cuj: [] });
  assert.deepEqual(gq.failures, { total: 3, with_case: 2, acknowledged: 1 });
  assert.deepEqual(gq.by_feature.map((f) => [f.id, f.deep_cases, f.deep_gap, f.requirements.acknowledged, f.failures.acknowledged]), [["F1", 1, null, 1, 1], ["F2", 0, "one screen", 0, 0]]);
  assert.deepEqual(gq.gaps, [
    { ref: "R2.f1", kind: "failure", reason: "cannot be staged" },
    { ref: "R3", kind: "requirement", reason: "needs a wipe" },
    { ref: "F2", kind: "deep", reason: "one screen" },
    { ref: "R4", kind: "depth", reason: "no second screen" },
  ]);
  const gmd = qualityMd(gq, gapModel);
  assert.match(gmd, /## Left open\n\nNothing is left open\./);
  assert.match(gmd, /## Acknowledged gaps\n\n- R2\.f1: cannot be staged\n- R3: needs a wipe\n- F2 deep: one screen\n- R4 depth: no second screen/);
  assert.match(gmd, /\| Requirements acknowledged as gaps \| 1 of 4 \|/);
  const omd = qualityMd(q, model);
  assert.match(omd, /## Left open\n\nNothing below has a runnable case that settles it, or a Gap line. Write the case or the Gap line.\n\n- R3 · Deleting a note asks first and removes it from the list\.: no runnable case\n- R4 must be checked at elsewhere; the deepest case checks screen\n- R2\.f1 · /);
  assert.doesNotMatch(omd, /## Acknowledged gaps/);
  assert.match(omd, /\| Left open \| 3 \|/);
  // A P0 feature with no deep case is open, and comes first; a deep gap closes it.
  const noDeep = quality(readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Tier: core · Depth: kept"))));
  assert.deepEqual(noDeep.open[0], { ref: "F1", kind: "deep", what: "F1 · Notes is P0 and has no deep case" });
  assert.equal(noDeep.open.length, 4);
  assert.deepEqual(quality(readE2e(copy((d) => { sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Tier: core · Depth: kept"); fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Gaps\n- Gap: F1 deep · reason\n"); }))).open.map((o) => o.ref), ["R3", "R4", "R2.f1"]);
  // A manual case leaves a requirement open (and a manual deep case is not a deep case: see a8).
  assert.equal(withAdded("\n### TC-1z · P1 · Added\nFeature: F1 · Type: happy\nCovers: R3\nTier: deep · Depth: screen\nRun mode: manual\n").open.length, 3);
  // A gap that also has a case is a problem and does not count as acknowledged.
  const both2 = quality(readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Gaps\n- Gap: R4 · x\n"))));
  assert.equal(both2.ok, false);
  assert.equal(both2.requirements.acknowledged, 0);

  // a6. Failure lines are open only under a P0 or P1 feature; P2 ones still count in failures.
  const p2 = quality(readE2e(copy((d) => sub(d, "PRD.md", "### F1 · Notes · P0", "### F1 · Notes · P2"))));
  assert.deepEqual(p2.open.map((o) => o.ref), ["R3", "R4"], "R2.f1 is in a P2 feature: not open");
  assert.deepEqual(p2.failures, { total: 3, with_case: 2, acknowledged: 0 });
  assert.deepEqual(q.open.map((o) => o.ref), ["R3", "R4", "R2.f1"], "a P0 feature's failure is open");
  assert.ok(quality(readE2e(copy((d) => sub(d, "PRD.md", "### F1 · Notes · P0", "### F1 · Notes · P1")))).open.some((o) => o.ref === "R2.f1"), "P1 too");
  // a7. Caps: none: no capability, still a requirement.
  const none = quality(readE2e(copy((d) => { sub(d, "PRD.md", "  Caps: C2\n", "  Caps: none\n"); sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R4"); })));
  assert.equal(none.ok, true);
  assert.equal(none.requirements.total, 4);
  assert.equal(none.capabilities.in_feature, 4);
  assert.equal(none.requirements.with_case, 3, "a Caps: none requirement is covered as usual");

  // a8. Only a runnable deep case is a deep case; a setup case is none, and is in no tier count.
  const manualOnlyDeep = quality(readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: deep · Depth: kept\nRun mode: phone", "Tier: deep · Depth: kept\nRun mode: manual"))));
  assert.deepEqual(manualOnlyDeep.open[0], { ref: "F1", kind: "deep", what: "F1 · Notes is P0 and has no deep case" });
  assert.equal(manualOnlyDeep.by_feature[0].deep_cases, 0);
  const setupDeep = "\n### TC-00 · P1 · Setup\nFeature: F1 · Type: setup\nTier: deep\nRun mode: phone\n";
  const sd = withAdded(setupDeep);
  assert.equal(sd.by_feature[0].deep_cases, 1);
  assert.deepEqual(sd.by_feature[0].tiers, { smoke: 0, core: 2, deep: 1, edge: 1 }, "a setup case is in no tier count");
  const sd2 = withAdded(setupDeep, ["TESTCASES.md", "Tier: deep · Depth: kept", "Tier: core · Depth: kept"]);
  assert.equal(sd2.by_feature[0].deep_cases, 0, "a setup case is not a deep case");
  assert.equal(sd2.open[0].ref, "F1");
  // a9. Too shallow: a runnable case but none at the Proof depth. A depth Gap acknowledges it; a deeper case closes it.
  assert.deepEqual(q.open.filter((o) => o.kind === "shallow").map((o) => o.ref), ["R4"]);
  assert.equal(edited(["TESTCASES.md", "Covers: R4\nTier: edge · Depth: screen", "Covers: R4\nTier: edge · Depth: elsewhere"]).open.some((o) => o.kind === "shallow"), false);
  assert.equal(edited(["TESTCASES.md", "Covers: R4 (C2)\nTier: smoke · Depth: screen", "Covers: R4 (C2)\nTier: smoke · Depth: kept"]).open.some((o) => o.kind === "shallow"), false, "deeper than the Proof is enough");
  assert.match(qualityMd(q, model), /## Left open[\s\S]*R4 must be checked at elsewhere; the deepest case checks screen/);
  assert.equal(q.requirements.depth_acknowledged, 0);

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
  // A control passes only when a case on it passed and none failed. C2 by TC-3a pass + TC-3b fail (the fixture
  // as is): exercised, not passing. A case not run neither helps nor hurts: TC-3a pass + TC-3b not run is passing.
  assert.equal(q.capabilities.passing, 3);
  assert.equal(edited(["reports/2026-01-02/REPORT.md", "| TC-3b | fail |", "| TC-3b | not run |"]).capabilities.passing, 4);
  assert.equal(q.by_feature[1].capabilities.passing, 0, "the same rule per feature");
  assert.equal(q.by_cuj[2].capabilities.passing, 0, "the same rule per journey");
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

  // Requirements no journey proves: a retired CUJ proves nothing; without CUJs.md nothing is listed.
  const ncModel = readE2e(copy((d) => sub(d, "CUJs.md", "Proves: R4\n", "Proves: R4\nRetired: 2026-01-01 - merged\n")));
  const nc = quality(ncModel);
  assert.deepEqual(nc.requirements.no_cuj, ["R4"]);
  assert.equal(nc.ok, true, "not a problem");
  assert.ok(!nc.open.some((o) => o.kind === "cuj" || o.what.includes("journey")), "not part of open");
  assert.deepEqual(nc.open, q.open);
  const ncMd = qualityMd(nc, ncModel);
  assert.match(ncMd, /## Requirements no journey proves\n\n- R4 · Typing in search narrows the list to matching titles\.\n\n## Left open/);
  assert.doesNotMatch(qualityMd(q, model), /no journey proves/, "no section when every requirement has a journey");
  assert.deepEqual(quality(readE2e(copy((d) => { fs.rmSync(path.join(d, "CUJs.md")); fs.rmSync(path.join(d, "TESTCASES.md")); fs.rmSync(path.join(d, "reports"), { recursive: true }); }))).requirements.no_cuj, [], "CUJs.md not written yet");

  // Each report cell of QUALITY.md, on a folder where every one of them has its own value.
  // In scope C1-C9 (C10 set aside). F1/R1: C1-C4, F2: R2 C5+C6, R3 C7. C1 pass, C2 fail, C3 pass, C4 not run,
  // C5+C6 pass, C7 manual only. Not seen in scope: C7, C8, C9. Gaps: R1.f2, R1.f3, R3.
  const cells = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-quality-"));
  tmps.push(cells);
  const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(cells, f)), { recursive: true }); fs.writeFileSync(path.join(cells, f), t); };
  put("INVENTORY.md", `## S1 · MainActivity · "Main"\n| Id | Control | Does | Source | States | Seen |\n| --- | --- | --- | --- | --- | --- |\n${
    Array.from({ length: 10 }, (_, i) => `| C${i + 1} | text "c${i + 1}" | does | a.kt:1 | | ${[7, 8, 9, 10].includes(i + 1) ? "no: hidden" : "yes"} |`).join("\n")}\n`);
  put("PRD.md", "### F1 · A · P1\n- R1 · one\n  Caps: C1, C2, C3, C4\n  Proof: screen\n  Fails:\n  - R1.f1 · f1\n  - R1.f2 · f2\n  - R1.f3 · f3\n"
    + "### F2 · B · P1\n- R2 · two\n  Caps: C5, C6\n  Proof: screen\n  Fails:\n  - R2.f1 · f\n- R3 · three\n  Caps: C7\n  Proof: screen\n  Fails: none in source\n\n## Non-goals\n- Non-goal: C10 · later\n");
  put("CUJs.md", "## F1 · A\n### CUJ-1 · j · P1 · phone\nProves: R1\n## F2 · B\n### CUJ-2 · k · P1 · phone\nProves: R2, R3\n");
  const tcBlock = (id, f, covers, mode) => `### ${id} · P1 · t\nFeature: ${f} · Type: happy\nCovers: ${covers}\nTier: core · Depth: screen\nRun mode: ${mode}\n\n`;
  put("TESTCASES.md", tcBlock("TC-1a", "F1", "R1 (C1)", "phone") + tcBlock("TC-1b", "F1", "R1 (C2)", "phone") + tcBlock("TC-1c", "F1", "R1 (C3)", "task")
    + tcBlock("TC-1d", "F1", "R1.f1 (C4)", "task") + tcBlock("TC-2a", "F2", "R2", "phone") + tcBlock("TC-2b", "F2", "R3", "manual")
    + "## Gaps\n- Gap: R1.f2 · a\n- Gap: R1.f3 · b\n- Gap: R3 · c\n");
  put("reports/2026-01-02/REPORT.md", "| Case | Result |\n| --- | --- |\n| TC-1a | pass |\n| TC-1b | fail |\n| TC-1c | pass |\n| TC-1d | not run |\n| TC-2a | pass |\n| TC-2b | not run |\n");
  const cm = readE2e(cells);
  const cq = quality(cm);
  assert.equal(cq.ok, true, JSON.stringify(cq.problems));
  const cmd = qualityMd(cq, cm).split("\n");
  for (const row of [
    "| Capabilities exercised in the last report | 5 of 9 (55%) |",
    "| Capabilities passing in the last report | 4 of 9 (44%) |",
    "| Capabilities not seen on the phone | 3 of 9 |",
    "| Failures acknowledged as gaps | 2 of 4 |",
    "| Requirements acknowledged as gaps | 1 of 3 |",
    "| Cases | 6 (3 phone, 2 task, 1 manual) |",
  ]) assert.ok(cmd.includes(row), row);
  const col = (start, k) => cmd.find((l) => l.startsWith(start)).split("|").map((x) => x.trim())[k];
  assert.deepEqual([col("| F1 · A |", 4), col("| F1 · A |", 5), col("| F2 · B |", 4), col("| F2 · B |", 5)], ["75%", "50%", "66%", "66%"], "per feature: Exercised, Passing");
  assert.deepEqual([col("| CUJ-1 |", 6), col("| CUJ-1 |", 7), col("| CUJ-2 |", 7)], ["75%", "50%", "66%"], "per journey: Exercised, Passing");

  console.log("ok e2e-quality");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
