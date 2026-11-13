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
    ], line: 9,
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
  assert.deepEqual(m.cases[1], {
    id: "TC-1b", priority: "P1", title: "Saving with no connection keeps the text", feature: "F1", type: "negative",
    covers: [{ ref: "R1.f1", caps: ["C4"] }, { ref: "R1.f2", caps: [] }], tier: "core", depth: "screen", mode: "phone", needs: [], line: 14,
  });
  assert.equal(m.results.report, "reports/2026-01-02/REPORT.md");
  const r = Object.values(m.results.byCase);
  assert.equal(r.filter((x) => x === "pass").length, 4);
  assert.equal(r.filter((x) => x === "fail").length, 1);
  assert.equal(r.filter((x) => x === "not run").length, 1);
  assert.equal(m.results.byCase["TC-3b"], "fail");
  assert.deepEqual(Object.keys(m.files).sort(), ["CUJs.md", "INVENTORY.md", "PRD.md", "TESTCASES.md", "reports/2026-01-02/REPORT.md"]);
  const f = m.files["PRD.md"];
  assert.equal(f.path, path.join(fixture, "PRD.md"));
  assert.equal(f.sha256, crypto.createHash("sha256").update(fs.readFileSync(f.path)).digest("hex"));

  assert.deepEqual(splitCells("| a | `b | c` | d |"), ["a", "`b | c`", "d"]);

  // A case covering an undefined requirement.
  let p = readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R9 (C2)"))).problems;
  assert.deepEqual(p, [{ file: "TESTCASES.md", line: 34, message: "R9 is referenced but not defined" }]);

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
  assert.deepEqual(p.map((x) => x.message), ["REPORT.md has no Case/Result table"]);

  // An old-style folder: PRD.md and TESTCASES.md only, no new lines.
  const old = readE2e(copy((d) => {
    for (const n of ["INVENTORY.md", "CUJs.md", "reports"]) fs.rmSync(path.join(d, n), { recursive: true });
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
  assert.deepEqual(fence.problems, [{ file: "TESTCASES.md", line: 20, message: "code fence opened here is never closed" }]);
  assert.equal(fence.cases.length, 6);

  // A Covers bracket naming a capability that is not in that requirement's Caps is a problem, on the Covers line
  // (TC-3a's is line 34; TC-1b's R1.f1 entry checks R1's Caps, line 16). An undefined cap is only "not defined".
  let notIn = readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R4 (C6)")));
  assert.deepEqual(notIn.problems, [{ file: "TESTCASES.md", line: 34, message: "C6 is not in R4's Caps" }]);
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
  assert.deepEqual(p, [{ file: "TESTCASES.md", line: 34, message: "TC-3a Covers: names nothing" }]);
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
    fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-B1 · P1 · Saving twice keeps one note\nFeature: F1 · Type: negative\nCovers: R1 (C4)\nTier: edge · Depth: kept\nRun mode: phone\n");
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
  p = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-4a · P1 · Plain\nFeature: F1 · Type: happy\nRun mode: phone\n"))).problems.map((x) => x.message);
  assert.deepEqual(p, ["TC-4a has no Covers: line", "TC-4a has no Tier: line (smoke, core, deep or edge)", "TC-4a has no Depth: line (screen, elsewhere or kept)"]);

  assert.throws(() => readE2e(path.join(fixture, "nope")));
  console.log("ok e2e-model");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
