/**
 * readE2e: the e2e/ folder (INVENTORY, PRD, CUJs, TESTCASES, newest report) read into one model, with
 * every broken reference or missing line listed as a problem instead of thrown.
 *
 * Run: node test/e2e-model.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e, splitCells } from "../src/e2e-model.js";

const fixture = new URL("./fixtures/e2e-sample", import.meta.url).pathname;
const tmps = [];
const copy = (edit) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-model-"));
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
  const m = readE2e(fixture);
  assert.equal(m.dir, fixture);
  assert.deepEqual(m.problems, []);
  assert.equal(m.screens.length, 2);
  assert.deepEqual(m.screens[1], { id: "S2", source: "NoteEditorFragment", title: "Edit note", line: 10 });
  assert.equal(m.capabilities.length, 6);
  assert.deepEqual(m.capabilities[3], {
    id: "C4", screen: "S2", control: 'text "Save"', does: "saves the note and returns to the list",
    source: "app/src/main/java/notes/EditorFragment.kt:88",
    states: `disabled while the title is empty; error "Couldn't save"`, seen: "yes", line: 13,
  });
  assert.equal(m.features.length, 2);
  assert.deepEqual(m.features[0], { id: "F1", name: "Notes", priority: "P0", line: 8 });
  assert.equal(m.requirements.length, 4);
  assert.deepEqual(m.requirements[0].fails.map((f) => f.id), ["R1.f1", "R1.f2"]);
  assert.deepEqual(m.requirements[0], {
    id: "R1", feature: "F1", text: "A saved note appears in the list with its title.", caps: ["C4"], proof: "kept",
    fails: [
      { id: "R1.f1", text: `saving with no connection shows "Couldn't save" and keeps the text` },
      { id: "R1.f2", text: `an empty title leaves "Save" disabled` },
    ], line: 9, lines: [9, 14],
  });
  assert.deepEqual(m.requirements[1].caps, ["C1", "C3"]);
  assert.deepEqual(m.requirements[2].fails, []);
  assert.equal(m.requirements[3].feature, "F2");
  assert.equal(m.requirements.flatMap((r) => r.fails).length, 3);
  assert.deepEqual(m.cujs.map((c) => [c.id, c.feature, c.mode, c.proves]), [
    ["CUJ-1", "F1", "phone", ["R1", "R2"]], ["CUJ-2", "F1", "manual", ["R3"]], ["CUJ-3", "F2", "phone", ["R4"]],
  ]);
  assert.equal(m.cujs[0].title, "Write a note and find it again");
  assert.equal(m.cujs[0].priority, "P0");
  assert.equal(m.cases.length, 6);
  assert.deepEqual(m.cases.map((c) => c.mode), ["phone", "phone", "task", "manual", "phone", "phone"]);
  const { verify: v1b, ...tc1b } = m.cases[1]; // the verifier's status is tested in e2e-verify.test.mjs
  assert.equal(v1b.status, "approved");
  assert.deepEqual(tc1b, {
    id: "TC-1b", priority: "P1", title: "Saving with no connection keeps the text", feature: "F1", type: "negative",
    covers: [{ ref: "R1.f1", caps: ["C4"] }, { ref: "R1.f2", caps: [] }], tier: "core", depth: "screen", mode: "phone", needs: [], retired: null, line: 14, lines: [14, 20],
  });
  assert.equal(m.results.report, "reports/2026-01-02/REPORT.md");
  const r = Object.values(m.results.byCase);
  assert.equal(r.filter((x) => x === "pass").length, 4);
  assert.equal(r.filter((x) => x === "fail").length, 1);
  assert.equal(r.filter((x) => x === "not run").length, 1);
  assert.equal(m.results.byCase["TC-3b"], "fail");
  assert.deepEqual(Object.keys(m.files).sort(), ["CUJs.md", "INVENTORY.md", "PRD.md", "TESTCASES.md", "VERIFY.md", "reports/2026-01-02/REPORT.md"]);
  const f = m.files["PRD.md"];
  assert.equal(f.path, path.join(fixture, "PRD.md"));
  assert.equal(f.sha256, crypto.createHash("sha256").update(fs.readFileSync(f.path)).digest("hex"));

  assert.deepEqual(splitCells("| a | `b | c` | d |"), ["a", "`b | c`", "d"]);

  // A case covering an undefined requirement.
  let p = readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R9 (C2)"))).problems;
  assert.deepEqual(p, [{ file: "TESTCASES.md", line: 38, message: "R9 is referenced but not defined" }]);

  // A duplicate capability id.
  p = readE2e(copy((d) => sub(d, "INVENTORY.md", "| C6 |", "| C4 |"))).problems;
  assert.ok(p.some((x) => x.file === "INVENTORY.md" && x.line === 15 && x.message === "C4 is defined twice"), JSON.stringify(p));

  // A value outside the allowed words.
  p = readE2e(copy((d) => sub(d, "PRD.md", "Proof: kept", "Proof: deep"))).problems;
  assert.deepEqual(p, [{ file: "PRD.md", line: 11, message: "Proof must be screen, elsewhere or kept" }]);
  p = readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: smoke · Depth: screen", "Tier: smoke · Depth: deep"))).problems;
  assert.deepEqual(p.map((x) => x.message), ["Depth must be screen, elsewhere or kept"]);

  // A requirement and a case missing their lines; an unknown capability, feature and result row.
  p = readE2e(copy((d) => {
    sub(d, "PRD.md", "  Caps: C2\n", "");
    sub(d, "TESTCASES.md", "Tier: core · Depth: screen\nRun mode: task\n", "Run mode: task\n");
    sub(d, "CUJs.md", "Proves: R4", "Proves: R8");
    sub(d, "TESTCASES.md", "Feature: F2 · Type: happy", "Feature: F7 · Type: happy");
    sub(d, "reports/2026-01-02/REPORT.md", "| TC-3b |", "| TC-9z |");
  })).problems.map((x) => x.message);
  for (const msg of ["R4 has no Caps: line", "TC-1c has no Tier: line (smoke, core, deep or edge)", "TC-1c has no Depth: line (screen, elsewhere or kept)", "R8 is referenced but not defined",
    "F7 is referenced but not defined", "TC-9z is referenced but not defined"]) assert.ok(p.includes(msg), `${msg} in ${p}`);

  // A screen with no capability.
  p = readE2e(copy((d) => fs.appendFileSync(path.join(d, "INVENTORY.md"), "\n## S3 · EmptyFragment · \"Empty\"\n"))).problems;
  assert.deepEqual(p.map((x) => x.message), ["S3 has no capability"]);

  // No reports folder, and a report without the case table.
  const noReport = readE2e(copy((d) => fs.rmSync(path.join(d, "reports"), { recursive: true })));
  assert.equal(noReport.results.report, null);
  assert.deepEqual(noReport.results.byCase, {});
  p = readE2e(copy((d) => fs.writeFileSync(path.join(d, "reports/2026-01-02/REPORT.md"), "| Build | Date |\n| --- | --- |\n| 1 | x |\n"))).problems;
  assert.deepEqual(p.map((x) => x.message), ['REPORT.md has no Case/Result table: its results table must start with the columns "Case" and "Result"']);

  // An old-style folder: PRD.md and TESTCASES.md only, no new lines.
  const old = readE2e(copy((d) => {
    for (const n of ["INVENTORY.md", "CUJs.md", "reports", "VERIFY.md"]) fs.rmSync(path.join(d, n), { recursive: true });
    fs.writeFileSync(path.join(d, "PRD.md"), "### F1 · Notes · P0\n- R1 · A saved note appears.\n");
    fs.writeFileSync(path.join(d, "TESTCASES.md"), "### TC-1a · P0 · Save\nFeature: F1 · Type: happy\n\n### TC-1b · P1 · Open\nFeature: F1 · Type: happy\n");
  }));
  const om = old.problems.map((x) => x.message);
  for (const msg of ["INVENTORY.md is missing", "CUJs.md is missing", "TC-1a has no Covers: line", "TC-1b has no Covers: line", "R1 has no Caps: line"]) assert.ok(om.includes(msg), `${msg} in ${om}`);
  assert.deepEqual(Object.keys(old.files).sort(), ["PRD.md", "TESTCASES.md"]);

  // Result cells are read leniently; anything else is a problem and is not stored.
  const rep = "reports/2026-01-02/REPORT.md";
  const withRows = (rows) => readE2e(copy((d) => {
    const f = path.join(d, rep);
    fs.appendFileSync(f, rows);
  }));
  let lenient = readE2e(copy((d) => {
    sub(d, rep, "| TC-1a | pass |", "| TC-1a | pass after 2 tries |");
    sub(d, rep, "| TC-1b | pass |", "| TC-1b | **fail** |");
    sub(d, rep, "| TC-1c | pass |", "| TC-1c | Not run |");
    sub(d, rep, "| TC-3a | pass |", "| TC-3a | passed |");
  }));
  assert.deepEqual(lenient.problems, []);
  assert.deepEqual([lenient.results.byCase["TC-1a"], lenient.results.byCase["TC-1b"], lenient.results.byCase["TC-1c"], lenient.results.byCase["TC-3a"]], ["pass", "fail", "not run", "pass"]);
  lenient = readE2e(copy((d) => {
    sub(d, rep, "| TC-1a | pass |", "| TC-1a | maybe |");
    sub(d, rep, "| TC-1b | pass |", "| TC-1b |  |");
  }));
  assert.deepEqual(lenient.problems.map((x) => x.message), ["TC-1a Result must be pass, fail or not run", "TC-1b Result must be pass, fail or not run"]);
  assert.ok(!("TC-1a" in lenient.results.byCase) && !("TC-1b" in lenient.results.byCase));

  // A duplicate report row keeps the first value; an unknown case is reported and not stored.
  const dup = withRows("| TC-1a | fail | P0 | again | |\n| TC-9z | pass | P0 | nope | |\n");
  assert.equal(dup.results.byCase["TC-1a"], "pass");
  assert.ok(!("TC-9z" in dup.results.byCase));
  assert.deepEqual(dup.problems.map((x) => x.message), ["TC-1a is defined twice", "TC-9z is referenced but not defined"]);

  // An unclosed code fence is a problem and does not hide what follows.
  const fence = readE2e(copy((d) => sub(d, "TESTCASES.md", "### TC-1c", "```\n### TC-1c")));
  assert.deepEqual(fence.problems, [{ file: "TESTCASES.md", line: 21, message: "code fence opened here is never closed" }]);
  assert.equal(fence.cases.length, 6);

  // A Covers bracket naming a capability that is not in that requirement's Caps is a problem, on the Covers line
  // (TC-3a's is line 34; TC-1b's R1.f1 entry checks R1's Caps, line 16). An undefined cap is only "not defined".
  let notIn = readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R4 (C6)")));
  assert.deepEqual(notIn.problems, [{ file: "TESTCASES.md", line: 38, message: "C6 is not in R4's Caps" }]);
  notIn = readE2e(copy((d) => sub(d, "TESTCASES.md", "R1.f1 (C4)", "R1.f1 (C1)")));
  assert.deepEqual(notIn.problems, [{ file: "TESTCASES.md", line: 16, message: "C1 is not in R1's Caps" }]);

  // A report folder with an unsafe name is never chosen and is reported.
  const odd = '2027"><s>';
  const unsafe = readE2e(copy((d) => {
    fs.mkdirSync(path.join(d, "reports", odd));
    fs.copyFileSync(path.join(d, "reports/2026-01-02/REPORT.md"), path.join(d, "reports", odd, "REPORT.md"));
  }));
  assert.equal(unsafe.results.report, "reports/2026-01-02/REPORT.md");
  assert.deepEqual(unsafe.problems, [{ file: "reports", line: 0, message: `report folder "${odd}" is skipped: use only letters, digits, dot, dash and underscore` }]);

  // Documents are written in stages: a missing source is pending, not a problem, until a later one exists.
  const SRC = ["INVENTORY.md", "PRD.md", "CUJs.md", "TESTCASES.md"];
  const stage = (keep) => readE2e(copy((d) => {
    for (const n of [...SRC, "reports"]) if (!keep.includes(n)) fs.rmSync(path.join(d, n), { recursive: true });
  }));
  for (const k of [0, 1, 2, 3, 4]) {
    const st = stage(SRC.slice(0, k));
    assert.deepEqual(st.problems, [], `stage ${k}`);
    assert.deepEqual(st.pending, SRC.slice(k), `stage ${k}`);
  }
  assert.deepEqual(m.pending, []);
  const gap = stage(["INVENTORY.md", "PRD.md", "TESTCASES.md"]);
  assert.deepEqual(gap.problems, [{ file: "CUJs.md", line: 0, message: "CUJs.md is missing" }]);
  assert.deepEqual(gap.pending, []);

  // A Covers, Proves or Caps line that names nothing is a problem.
  p = readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers:"))).problems;
  assert.deepEqual(p, [{ file: "TESTCASES.md", line: 38, message: "TC-3a Covers: names nothing" }]);
  p = readE2e(copy((d) => sub(d, "CUJs.md", "Proves: R4", "Proves: "))).problems.map((x) => x.message);
  assert.deepEqual(p, ["CUJ-3 Proves: names nothing"]);
  p = readE2e(copy((d) => sub(d, "PRD.md", "  Caps: C2\n", "  Caps:\n"))).problems.map((x) => x.message);
  assert.deepEqual(p, ["R4 Caps: names nothing", "C2 is not in R4's Caps"]);

  // Needs: names cases, each of which must exist.
  const needs = readE2e(copy((d) => sub(d, "TESTCASES.md", "Run mode: phone\nStart:", "Run mode: phone\nNeeds: TC-1b (makes e2e-x), TC-9z\nStart:")));
  assert.deepEqual(needs.cases[0].needs, ["TC-1b", "TC-9z"]);
  assert.deepEqual(needs.problems, [{ file: "TESTCASES.md", line: 8, message: "TC-9z is referenced but not defined" }]);

  // Any letters or digits after TC- make a case id (a bug case TC-B1 too); its report row is stored.
  const bug = readE2e(copy((d) => {
    fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-B1 · P1 · Saving twice keeps one note\nFeature: F1 · Type: negative\nCovers: R1 (C4)\nTier: edge · Depth: kept\nRun mode: phone\nExpected: one note in the list.\n");
    fs.appendFileSync(path.join(d, "reports/2026-01-02/REPORT.md"), "| TC-B1 | fail | P1 | Saving twice keeps one note | |\n");
  }));
  assert.deepEqual(bug.problems, []);
  const b1 = bug.cases.find((c) => c.id === "TC-B1");
  assert.deepEqual([b1?.covers, b1?.tier, b1?.depth, b1?.mode], [[{ ref: "R1", caps: ["C4"] }], "edge", "kept", "phone"]);
  assert.equal(bug.results.byCase["TC-B1"], "fail");

  // A line that looks like a heading or requirement but cannot be read is a problem, never skipped;
  // inside a fence, or a prose "- R10 and ..." outside any feature, it is ignored.
  const unreadable = readE2e(copy((d) => {
    fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-12a P0 title\n\n```\n### TC-13 nope\n```\n");
    fs.appendFileSync(path.join(d, "CUJs.md"), "\n### CUJ-4 Export notes\n");
    sub(d, "PRD.md", "### F1 · Notes · P0", "### F1 · Notes · P0\n- R5 has no separator");
    sub(d, "PRD.md", "### F2 · Search · P1", "### F2 Search");
    sub(d, "PRD.md", "## Non-goals\n", "## Non-goals\n- R10 and R13 tap Cancel, never Confirm.\n");
    fs.appendFileSync(path.join(d, "INVENTORY.md"), '\n## S3 SettingsFragment "Settings"\n');
  })).problems;
  assert.deepEqual(unreadable.map((x) => `${x.file}: ${x.message}`), [
    'INVENTORY.md: screen heading is not readable: use "## S<n> · <source> · "<title>""',
    'PRD.md: requirement is not readable: use "- R<n> · <text>"',
    'PRD.md: feature heading is not readable: use "### F<n> · <name> · <priority>"',
    "PRD.md: R4 is under no feature", // the unreadable heading closes F1
    'CUJs.md: CUJ heading is not readable: use "### CUJ-<n> · <title> · <priority> · <run mode>"',
    'TESTCASES.md: case heading is not readable: use "### TC-<id> · <priority> · <title>"',
    "TESTCASES.md: F2 is referenced but not defined", // the unreadable F2 heading defines nothing
    "TESTCASES.md: F2 is referenced but not defined",
  ]);
  assert.ok(unreadable.every((x) => x.line > 0), "each on its line");

  // A heading that is not a feature closes the feature: a requirement under it belongs to none (a
  // problem, still counted), and a prose bullet under it is ignored.
  const loose = readE2e(copy((d) => fs.writeFileSync(path.join(d, "PRD.md"), [
    "### F1 · Notes · P0", "- R1 · A saved note appears.", "  Caps: C4", "  Proof: kept", "  Fails: none in source",
    "", "### Unassigned", "- R2 · Search narrows the list.", "  Caps: C2", "  Proof: screen", "  Fails: none in source",
    "", "### Notes", "- R10 and R13 tap Cancel, never Confirm.", "",
  ].join("\n"))));
  assert.deepEqual(loose.requirements.map((r) => [r.id, r.feature]), [["R1", "F1"], ["R2", null]]);
  assert.deepEqual(loose.problems.filter((x) => x.file === "PRD.md"), [{ file: "PRD.md", line: 8, message: "R2 is under no feature" }]);

  // Tier and Depth on one line or two; a missing line says which words it takes.
  const twoLines = readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Tier: deep\nDepth: kept")));
  assert.deepEqual(twoLines.problems, []);
  assert.deepEqual([twoLines.cases[0].tier, twoLines.cases[0].depth], ["deep", "kept"]);
  p = readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Depth: sideways"))).problems.map((x) => x.message);
  assert.deepEqual(p, ["Depth must be screen, elsewhere or kept", "TC-1a has no Tier: line (smoke, core, deep or edge)"]);
  p = readE2e(copy((d) => {
    sub(d, "TESTCASES.md", "Tier: deep · Depth: kept\nRun mode: phone\n", "");
    sub(d, "PRD.md", "  Proof: kept\n", "");
  })).problems.map((x) => x.message);
  assert.deepEqual(p, ["R1 has no Proof: line (screen, elsewhere or kept)", "TC-1a has no Tier: line (smoke, core, deep or edge)",
    "TC-1a has no Depth: line (screen, elsewhere or kept)", "TC-1a has no Run mode: line (phone, task or manual)"]);

  // A setup case needs only its Run mode: line; Covers, Tier and Depth are optional and ignored if present.
  const setup = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-00 · P1 · Remove leftovers\nFeature: all · Type: setup\nRun mode: phone\n")));
  assert.deepEqual(setup.problems, []);
  assert.deepEqual([setup.cases.at(-1).type, setup.cases.at(-1).mode, setup.cases.at(-1).tier], ["setup", "phone", null]);
  p = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-00 · P1 · Remove leftovers\nFeature: all · Type: setup\n"))).problems.map((x) => x.message);
  assert.deepEqual(p, ["TC-00 has no Run mode: line (phone, task or manual)"]);
  p = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-00 · P1 · Remove leftovers\nFeature: all · Type: setup\nCovers: R1\nTier: core · Depth: kept\nRun mode: phone\n"))).problems;
  assert.deepEqual(p, []);
  // A case that is not setup still needs all four.
  p = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-1d · P1 · Plain\nFeature: F1 · Type: happy\nRun mode: phone\nExpected: the list.\n"))).problems.map((x) => x.message);
  assert.deepEqual(p, ["TC-1d has no Covers: line", "TC-1d has no Tier: line (smoke, core, deep or edge)", "TC-1d has no Depth: line (screen, elsewhere or kept)"]);

  // Non-goal lines: capabilities the PRD sets aside, with a reason. Prose bullets under Non-goals are ignored.
  const ng = (line) => readE2e(copy((d) => fs.appendFileSync(path.join(d, "PRD.md"), `${line}\n`)));
  const prdLines = fs.readFileSync(path.join(fixture, "PRD.md"), "utf8").split("\n").length - 1;
  let n = ng("- Non-goal: C6, C2x · sharing needs a second phone".replace("C2x", "C99"));
  assert.deepEqual(n.nonGoals, [{ caps: ["C6", "C99"], reason: "sharing needs a second phone", line: prdLines + 1 }]);
  assert.deepEqual(n.problems, [{ file: "PRD.md", line: prdLines + 1, message: "C99 is referenced but not defined" }]);
  assert.deepEqual(readE2e(fixture).nonGoals, []);
  n = ng("- Non-goal: C6 · sharing needs a second phone");
  assert.deepEqual(n.problems, []);
  p = ng("- Non-goal: C5 · never tested").problems;
  assert.deepEqual(p, [{ file: "PRD.md", line: prdLines + 1, message: "C5 is in a Non-goal line and in R3's Caps" }]);
  for (const bad of ["- Non-goal: C6", "- Non-goal: C6 · ", "- Non-goal: C6 ·   "]) {
    assert.deepEqual(ng(bad).problems.map((x) => x.message), ["Non-goal C6 has no reason"], bad);
  }
  assert.deepEqual(ng("- Non-goal: · why").problems.map((x) => x.message), ["Non-goal line names no capability"]);

  // Gap lines: a reason for a requirement, a failure line or a feature's missing deep case that has no case.
  const tcLines = fs.readFileSync(path.join(fixture, "TESTCASES.md"), "utf8").split("\n").length - 1;
  const gp = (...lines) => readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), `\n## Gaps\n${lines.join("\n")}\n`)));
  const first = tcLines + 3; // the blank line, the heading, then the first Gap line
  let g = gp("- Gap: R2.f1 · the note cannot be deleted elsewhere", "- Gap: R3 · needs a wipe", "- Gap: F2 deep · search has one screen");
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.gaps, [
    { ref: "R2.f1", kind: "failure", reason: "the note cannot be deleted elsewhere", line: first },
    { ref: "R3", kind: "requirement", reason: "needs a wipe", line: first + 1 },
    { ref: "F2", kind: "deep", reason: "search has one screen", line: first + 2 },
  ]);
  assert.equal(g.cases.length, 6, "the Gaps heading ends the last case");
  assert.deepEqual(readE2e(fixture).gaps, []);
  const msgs = (...lines) => gp(...lines).problems.map((x) => x.message);
  assert.deepEqual(msgs("- Gap: R9 · x", "- Gap: R1.f9 · x", "- Gap: F9 deep · x"), ["R9 is referenced but not defined", "R1.f9 is referenced but not defined", "F9 is referenced but not defined"]);
  assert.deepEqual(msgs("- Gap: R3", "- Gap: R2.f1 ·  "), ["Gap R3 has no reason", "Gap R2.f1 has no reason"]);
  assert.deepEqual(msgs("- Gap: banana · x", "- Gap: F2 · x"), ['Gap "banana" is not R<n>, R<n> depth, R<n>.f<m> or F<n> deep', 'Gap "F2" is not R<n>, R<n> depth, R<n>.f<m> or F<n> deep']);
  // A gap for something a runnable case covers is a problem; a manual case does not cover (R3), a deep case ends F1's gap.
  assert.deepEqual(msgs("- Gap: R1.f2 · x", "- Gap: R4 · x"), ["R1.f2 has a Gap line and a case", "R4 has a Gap line and a case"]);
  assert.deepEqual(msgs("- Gap: F1 deep · x"), ["F1 has a Gap line and a deep case"]);
  assert.deepEqual(gp("- Gap: R1.f2 · x").problems[0], { file: "TESTCASES.md", line: first, message: "R1.f2 has a Gap line and a case" });
  // A setup case's Covers never counts as a case.
  g = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-00 · P1 · Setup\nFeature: all · Type: setup\nCovers: R2.f1\nRun mode: phone\n\n## Gaps\n- Gap: R2.f1 · x\n")));
  assert.deepEqual(g.problems, []);

  // Caps: none is a requirement with no control; an empty Caps: and Covers: none / Proves: none stay problems.
  const cn = readE2e(copy((d) => { sub(d, "PRD.md", "  Caps: C2\n", "  Caps: none\n"); sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R4"); }));
  assert.deepEqual(cn.problems, []);
  assert.deepEqual(cn.requirements[3].caps, []);
  assert.deepEqual(readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R4 (C2)"))).problems, []);
  assert.deepEqual(readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: none"))).problems.map((x) => x.message), ['Covers entry "none" is not a requirement id']);
  assert.deepEqual(readE2e(copy((d) => sub(d, "CUJs.md", "Proves: R4", "Proves: none"))).problems.map((x) => x.message), ["none is referenced but not defined"]);

  // Round 2. A manual deep case is not a deep case: it neither closes F2 nor blocks `Gap: F2 deep`.
  const manualDeep = "\n### TC-3m · P2 · Manual deep\nFeature: F2 · Type: happy\nCovers: R4 (C2)\nTier: deep · Depth: screen\nRun mode: manual\nWhy manual: x\nExpected: x\n";
  g = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), `${manualDeep}\n## Gaps\n- Gap: F2 deep · only a wipe goes deeper\n`)));
  assert.deepEqual(g.problems, []);
  g = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), `${manualDeep.replace("manual", "phone")}\n## Gaps\n- Gap: F2 deep · x\n`)));
  assert.deepEqual(g.problems.map((x) => x.message), ["F2 has a Gap line and a deep case"]);
  // A setup case is not a deep case either.
  g = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-00 · P1 · Setup\nFeature: F2 · Type: setup\nTier: deep\nRun mode: phone\n\n## Gaps\n- Gap: F2 deep · x\n")));
  assert.deepEqual(g.problems, []);
  // Depth gaps: R4 (elsewhere) has only screen cases, so it is too shallow and may be acknowledged.
  g = gp("- Gap: R4 depth · no second screen to check");
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.gaps, [{ ref: "R4", kind: "depth", reason: "no second screen to check", line: first }]);
  assert.deepEqual(msgs("- Gap: R1 depth · x"), ["R1 has a depth Gap line but already has a case deep enough"]);
  assert.deepEqual(msgs("- Gap: R3 depth · x"), ["R3 has a depth Gap line but no runnable case"]);
  assert.deepEqual(msgs("- Gap: R9 depth · x"), ["R9 is referenced but not defined"]);
  assert.deepEqual(msgs("- Gap: R4 depth"), ["Gap R4 depth has no reason"]);
  // Two Gap lines for one ref and kind: a problem on the second. R4 and R4 depth are different gaps.
  assert.deepEqual(gp("- Gap: R2.f1 · a", "- Gap: R2.f1 · b").problems, [{ file: "TESTCASES.md", line: first + 1, message: "R2.f1 has two Gap lines" }]);
  assert.deepEqual(msgs("- Gap: R3 · a", "- Gap: R3 depth · b").filter((x) => x.includes("two")), []);
  // Fails: either items below or exactly "none in source" (any case, any spacing).
  const fails = (text) => readE2e(copy((d) => sub(d, "PRD.md", "  Caps: C5\n  Proof: elsewhere\n  Fails: none in source", `  Caps: C5\n  Proof: elsewhere\n  Fails:${text}`))).problems;
  const bad = [{ file: "PRD.md", line: 23, message: 'R3 Fails: must list failures or say "none in source"' }];
  assert.deepEqual(fails("  None In Source  "), []);
  assert.deepEqual(fails(" not traced yet"), bad);
  assert.deepEqual(fails(""), bad);
  assert.deepEqual(fails("\n  - R3.f1 · it fails"), []);
  // Caps: none in any case.
  for (const word of ["None", "NONE"]) assert.deepEqual(readE2e(copy((d) => { sub(d, "PRD.md", "  Caps: C2\n", `  Caps: ${word}\n`); sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R4"); })).problems, [], word);

  // A requirement line in another list form is reported, and the lines under it belong to no requirement.
  const REQ_FORM = 'requirement is not readable: use "- R<n> · <text>"';
  for (const form of ["* R2 ·", "+ R2 ·", "1. R2 ·", "- **R2** ·", "-\u00a0R2 ·"]) {
    const bad = readE2e(copy((d) => sub(d, "PRD.md", "- R2 ·", form)));
    assert.deepEqual(bad.problems.filter((x) => x.file === "PRD.md"), [{ file: "PRD.md", line: 15, message: REQ_FORM }], form);
    assert.deepEqual(bad.requirements.map((r) => [r.id, r.caps, r.proof]), [["R1", ["C4"], "kept"], ["R3", ["C5"], "elsewhere"], ["R4", ["C2"], "elsewhere"]], form);
  }
  // A second Caps, Proof, Fails, Proves, Feature, Covers, Tier, Depth or Run mode line is a problem; the first counts.
  const twice = readE2e(copy((d) => {
    sub(d, "PRD.md", "  Caps: C4\n  Proof: kept\n", "  Caps: C4\n  Caps: C1\n  Proof: kept\n  Proof: screen\n  Fails: none in source\n");
    sub(d, "CUJs.md", "Proves: R4", "Proves: R4\nProves: R3");
    fs.appendFileSync(path.join(d, "TESTCASES.md"), "Feature: F1 · Type: happy\nCovers: R3\nTier: core\nDepth: kept\nRun mode: task\n");
  }));
  assert.deepEqual(twice.problems.map((x) => `${x.file}:${x.line}: ${x.message}`), [
    "PRD.md:11: R1 has two Caps: lines", "PRD.md:13: R1 has two Proof: lines", "PRD.md:15: R1 has two Fails: lines",
    "CUJs.md:19: CUJ-3 has two Proves: lines",
    "TESTCASES.md:49: TC-3b has two Feature: lines", "TESTCASES.md:50: TC-3b has two Covers: lines", "TESTCASES.md:51: TC-3b has two Tier: lines",
    "TESTCASES.md:52: TC-3b gives Depth twice: on its Tier: line and on a Depth: line", "TESTCASES.md:53: TC-3b has two Run mode: lines",
  ]);
  assert.deepEqual([twice.requirements[0].caps, twice.requirements[0].proof, twice.requirements[0].fails.length], [["C4"], "kept", 2]);
  assert.deepEqual(twice.cujs[2].proves, ["R4"]);
  assert.deepEqual([twice.cases[5].feature, twice.cases[5].tier, twice.cases[5].depth, twice.cases[5].mode], ["F2", "edge", "screen", "phone"]);
  assert.deepEqual(twice.cases[5].covers, [{ ref: "R4", caps: [] }], "a second Covers: line adds nothing");
  const DEPTH_TWICE = "TC-1a gives Depth twice: on its Tier: line and on a Depth: line";
  const depthFirst = readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Depth: kept\nTier: deep · Depth: screen")));
  assert.deepEqual([depthFirst.problems, depthFirst.cases[0].depth], [[{ file: "TESTCASES.md", line: 7, message: DEPTH_TWICE }], "kept"]);
  const tierFirst = readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Tier: deep · Depth: kept\nDepth: screen")));
  assert.deepEqual([tierFirst.problems, tierFirst.cases[0].depth], [[{ file: "TESTCASES.md", line: 7, message: DEPTH_TWICE }], "kept"]);
  const twoDepth = readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: deep · Depth: kept", "Tier: deep\nDepth: kept\nDepth: screen")));
  assert.deepEqual([twoDepth.problems, twoDepth.cases[0].depth], [[{ file: "TESTCASES.md", line: 8, message: "TC-1a has two Depth: lines" }], "kept"]);
  // A second Fails: line does not replace the first list; items under it still belong to the requirement.
  const fails2 = readE2e(copy((d) => sub(d, "PRD.md", "  - R2.f1 · a note deleted elsewhere shows \"Note not found\"\n", "  - R2.f1 · a note deleted elsewhere shows \"Note not found\"\n  Fails:\n  - R2.f2 · other\n")));
  assert.deepEqual(fails2.problems.map((x) => `${x.line}: ${x.message}`), ["20: R2 has two Fails: lines"]);
  assert.deepEqual(fails2.requirements[1].fails.map((f) => f.id), ["R2.f1", "R2.f2"]);

  // A requirement line with a • or – bullet, or a lower-case or full-width R is reported, as the last requirement
  // of a feature or the first line under it; indented by one to three spaces, only where no requirement is open.
  // The lines below belong to none.
  for (const form of [" - R5 ·", "  - R5 ·", "   - R5 ·", "• R5 ·", "– R5 ·", "- r5 ·", "- Ｒ5 ·", "- R５ ·"]) {
    const block = `${form} Undo restores a deleted note.\n  Caps: C6\n  Proof: kept\n  Fails: none in source\n`;
    const places = [["last", "\n### F2 · Search · P1\n", `\n${block}\n### F2 · Search · P1\n`], ["first", "### F2 · Search · P1\n", `### F2 · Search · P1\n${block}`]];
    for (const [where, from, to] of form.startsWith(" ") ? places.slice(1) : places) {
      let line;
      const slip = readE2e(copy((d) => { sub(d, "PRD.md", from, to); line = fs.readFileSync(path.join(d, "PRD.md"), "utf8").split("\n").indexOf(block.split("\n")[0]) + 1; }));
      assert.deepEqual(slip.problems, [{ file: "PRD.md", line, message: REQ_FORM }], `${form} ${where}`);
      assert.deepEqual(slip.requirements.map((r) => [r.id, r.caps]), [["R1", ["C4"]], ["R2", ["C1", "C3"]], ["R3", ["C5"]], ["R4", ["C2"]]], `${form} ${where}`);
    }
  }
  // Prose under a feature stays as it was: "- R2-D2 ..." is reported, these are not, and failure items stay failure items.
  const prose = (t) => readE2e(copy((d) => sub(d, "PRD.md", "### F2 · Search · P1\n", `### F2 · Search · P1\n${t}\n`))).problems.map((x) => x.message);
  assert.deepEqual(prose("- R2-D2 unit"), [REQ_FORM]);
  for (const t of ["- RTL layout", "1. Restart the app", "- Results are kept", "  - Run it twice", "• Results are kept", " - rtl too"]) assert.deepEqual(prose(t), [], t);
  assert.deepEqual(readE2e(copy((d) => sub(d, "PRD.md", "  - R2.f1 ·", "   - R2.f1 ·"))).problems, [], "a failure item indented by three");
  assert.deepEqual(readE2e(copy((d) => sub(d, "PRD.md", "- R2 ·", "- R1.f3 · a long title is cut\n- R2 ·"))).problems, [{ file: "PRD.md", line: 15, message: REQ_FORM }], "a failure item at the margin");
  // An indented sub-bullet naming a requirement is prose: under a feature's What, Gates, Harm or Screens line, or
  // inside a requirement, where it keeps that requirement's Caps, Proof and Fails.
  for (const t of ["What: notes.\n  - R1 above is the main one.", "Gates: sign-in.\n  - R1 needs an account.", "Harm: delete.\n   - R3 deletes for good.", "Screens: list, editor.\n  - r2d2 is the robot."]) {
    assert.deepEqual(readE2e(copy((d) => sub(d, "PRD.md", "### F1 · Notes · P0\n", `### F1 · Notes · P0\n${t}\n`))).problems, [], t);
  }
  for (const t of ["  - R1 must have saved the note first.", "  - R1 · must have saved the note first."]) {
    const depends = readE2e(copy((d) => sub(d, "PRD.md", "with its text.\n", `with its text.\n  Depends on:\n${t}\n`)));
    assert.deepEqual([depends.problems, depends.requirements[1].caps, depends.requirements[1].proof, depends.requirements[1].fails.map((f) => f.id)], [[], ["C1", "C3"], "screen", ["R2.f1"]], t);
  }

  // The results table's separator row is read as the pages read a table rule: outer pipes are optional.
  for (const sep of ["--- | --- | --- | --- | ---", "|---|:-:|---|---|---", " | --- | --- | --- | --- | --- | "]) {
    const t = readE2e(copy((d) => sub(d, "reports/2026-01-02/REPORT.md", "| --- | --- | --- | --- | --- |\n| TC-1a", `${sep}\n| TC-1a`)));
    assert.deepEqual([t.problems, t.results.byCase["TC-3b"]], [[], "fail"], sep);
  }
  assert.deepEqual(readE2e(copy((d) => sub(d, "reports/2026-01-02/REPORT.md", "| --- | --- | --- | --- | --- |\n| TC-1a", "| -- x | --- |\n| TC-1a"))).problems.map((x) => x.message), ["Case/Result table has no separator row"]);

  // INVENTORY: no control row is dropped silently.
  const invProblems = (edit) => readE2e(copy(edit)).problems.filter((x) => x.file === "INVENTORY.md").map((x) => `${x.line}: ${x.message}`);
  for (const id of ["**C5**", "c5", "`C5`"]) assert.deepEqual(invProblems((d) => sub(d, "INVENTORY.md", "| C5 |", `| ${id} |`)), ["14: capability id must be written C<n>"], id);
  const NO_SCREEN = (id) => `${id} is under no screen: put the row under its "## S<n> · ..." heading`;
  assert.deepEqual(invProblems((d) => sub(d, "INVENTORY.md", "| C5 |", "### Delete dialog\n| Id | Control | Does | Source | States | Seen |\n| --- | --- | --- | --- | --- | --- |\n| C5 |")),
    [`17: ${NO_SCREEN("C5")}`, `18: ${NO_SCREEN("C6")}`]);
  assert.deepEqual(invProblems((d) => sub(d, "INVENTORY.md", "# Notes app inventory\n", "| Id | Control | Does | Source | States | Seen |\n| --- | --- | --- | --- | --- | --- |\n| C9 | x | y | z | | yes |\n")),
    [`3: ${NO_SCREEN("C9")}`]);
  assert.deepEqual(invProblems((d) => sub(d, "INVENTORY.md", "| C5 |", "C5 |")), ["14: table row must start with |"]);
  assert.deepEqual(invProblems((d) => { sub(d, "INVENTORY.md", "| C5 |", "C5 |"); sub(d, "INVENTORY.md", "needs an existing note |", "needs an existing note"); }), ["14: table row must start with |"], "five pipes, no outer ones");
  assert.deepEqual(invProblems((d) => sub(d, "INVENTORY.md", "| no: needs an existing note |", "| maybe |")), ["14: C5 Seen must start with yes, no or ?"]);

  // CUJs.md: a feature group heading at another level than 2 is a problem.
  for (const h of ["### F2 · Search", "# F2 · Search"]) {
    p = readE2e(copy((d) => sub(d, "CUJs.md", "## F2 · Search", h))).problems;
    assert.deepEqual(p, [{ file: "CUJs.md", line: 15, message: 'feature heading is not readable: use "## F<n> · <name>"' }], h);
  }
  // Values and lines each check reads: feature priority, CUJ run mode, a missing Proves:, a case's Tier.
  assert.deepEqual(readE2e(copy((d) => sub(d, "PRD.md", "### F2 · Search · P1", "### F2 · Search · P7"))).problems, [{ file: "PRD.md", line: 25, message: "F2 priority must be P0, P1 or P2" }]);
  assert.deepEqual(readE2e(copy((d) => sub(d, "CUJs.md", "· P1 · phone", "· P1 · robot"))).problems, [{ file: "CUJs.md", line: 17, message: "CUJ-3 mode must be phone, task or manual" }]);
  assert.deepEqual(readE2e(copy((d) => sub(d, "CUJs.md", "Proves: R4\n", ""))).problems, [{ file: "CUJs.md", line: 17, message: "CUJ-3 has no Proves: line" }]);
  assert.deepEqual(readE2e(copy((d) => sub(d, "TESTCASES.md", "Tier: smoke · Depth: screen", "Tier: sideways · Depth: screen"))).problems, [{ file: "TESTCASES.md", line: 39, message: "Tier must be smoke, core, deep or edge" }]);
  // A level-2 heading that is not a feature ends the feature group: the journey under it has none.
  const ungrouped = readE2e(copy((d) => fs.appendFileSync(path.join(d, "CUJs.md"), "\n## Extras\n\n### CUJ-4 · Export · P2 · phone\nProves: R4\n")));
  assert.deepEqual([ungrouped.problems, ungrouped.cujs[3].feature], [[], null]);

  // A case checks something: every case but a setup case has an Expected: line.
  const said = (file, from, to) => readE2e(copy((d) => sub(d, file, from, to))).problems.map((x) => x.message);
  assert.deepEqual(said("TESTCASES.md", 'Expected: "No notes match".\n', ""), ["TC-3b has no Expected: line"]);
  // A manual case or CUJ says why on a Why manual: line with a reason; a retired one need not.
  assert.deepEqual(said("TESTCASES.md", "Why manual: needs a note deleted from a second phone.\n", ""), ["TC-2a is manual and has no Why manual: line"]);
  assert.deepEqual(said("TESTCASES.md", "Why manual: needs a note deleted from a second phone.\n", "Why manual:\n"), ["TC-2a is manual and has no Why manual: line"]);
  assert.deepEqual(said("CUJs.md", "Why manual: needs a second phone to delete the note elsewhere.\n", ""), ["CUJ-2 is manual and has no Why manual: line"]);
  assert.deepEqual(said("CUJs.md", "Why manual: needs a second phone to delete the note elsewhere.\n", "Retired: 2026-01-01 - gone\n"), []);
  assert.deepEqual(said("CUJs.md", "Why manual: needs a second phone to delete the note elsewhere.\n", "Why manual:\n"), ["CUJ-2 is manual and has no Why manual: line"]);
  // A numbered case is for the CUJ of its number and has that CUJ's feature; zero-padding is fine.
  assert.deepEqual(said("CUJs.md", "### CUJ-3 ·", "### CUJ-7 ·"), ["TC-3a is numbered for CUJ-3, which is not in CUJs.md", "TC-3b is numbered for CUJ-3, which is not in CUJs.md"]);
  const padded = readE2e(copy((d) => { sub(d, "TESTCASES.md", "### TC-3b ·", "### TC-03b ·"); sub(d, "reports/2026-01-02/REPORT.md", "| TC-3b |", "| TC-03b |"); }));
  assert.deepEqual(padded.problems, []);
  assert.deepEqual(said("TESTCASES.md", "Feature: F2 · Type: negative", "Feature: F1 · Type: negative"), ["TC-3b has Feature: F1, but CUJ-3 is under F2"]);
  // Covers: is one line: a wrapped rest is reported, not silently dropped.
  for (const rest of ["  R1.f2", "R1.f2"]) {
    const w = readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R1.f1 (C4), R1.f2\n", `Covers: R1.f1 (C4),\n${rest}\n`))).problems;
    assert.deepEqual(w, [{ file: "TESTCASES.md", line: 17, message: "TC-1b Covers: goes on to this line: keep it on one line" }], rest);
  }

  assert.deepEqual(said("TESTCASES.md", "1. Tap \"New note\", type a title, tap \"Save\".\n", "1. Tap \"New note\", type a title, tap \"Save\".\n   then wait.\n"), [], "an indented line elsewhere in a case");

  // A Source path:line is checked in the repo holding the e2e folder, once the path's first folder is there.
  const inRepo = (files) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-repo-"));
    tmps.push(repo);
    fs.cpSync(fixture, path.join(repo, "e2e"), { recursive: true });
    for (const [f, n] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      if (n === "dir") fs.mkdirSync(path.join(repo, f));
      else fs.writeFileSync(path.join(repo, f), "x\n".repeat(n));
    }
    return readE2e(path.join(repo, "e2e")).problems.map((x) => `${x.line}: ${x.message}`);
  };
  const L = "app/src/main/java/notes/ListFragment.kt", E = "app/src/main/java/notes/EditorFragment.kt";
  assert.deepEqual(inRepo({ [L]: 80, [E]: 141 }), []);
  assert.deepEqual(inRepo({ [L]: 74, [E]: 140 }), [`8: C3 Source line 75 is past the end of ${L} (74 lines)`, `15: C6 Source line 141 is past the end of ${E} (140 lines)`]);
  assert.deepEqual(inRepo({ [L]: 80 }), [`13: C4 Source ${E} is not in the repo`, `14: C5 Source ${E} is not in the repo`, `15: C6 Source ${E} is not in the repo`]);
  assert.deepEqual(inRepo({ [L]: 80, [E]: "dir" }), [], "a folder where the file should be is not read");
  assert.deepEqual(inRepo({ "lib/x.kt": 1 }), [], "the paths' first folder app/ is not in the repo: nothing checked");
  const ranged = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-repo-"));
  tmps.push(ranged);
  fs.cpSync(fixture, path.join(ranged, "e2e"), { recursive: true });
  for (const [f, n] of [[L, 80], [E, 141]]) { fs.mkdirSync(path.dirname(path.join(ranged, f)), { recursive: true }); fs.writeFileSync(path.join(ranged, f), "x\n".repeat(n)); }
  sub(path.join(ranged, "e2e"), "INVENTORY.md", `${L}:75`, `${L}:75-81`);
  sub(path.join(ranged, "e2e"), "INVENTORY.md", `${L}:62`, `../outside.kt:9`);
  assert.deepEqual(readE2e(path.join(ranged, "e2e")).problems.map((x) => x.message), [`C3 Source line 81 is past the end of ${L} (80 lines)`]);

  assert.throws(() => readE2e(path.join(fixture, "nope")));
  console.log("ok e2e-model");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
