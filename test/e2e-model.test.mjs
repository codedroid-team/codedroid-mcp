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
    covers: [{ ref: "R1.f1", caps: ["C4"] }, { ref: "R1.f2", caps: [] }], tier: "core", depth: "screen", mode: "phone", line: 14,
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
  for (const msg of ["R4 has no Caps: line", "TC-1c has no Tier: line", "TC-1c has no Depth: line", "R8 is referenced but not defined",
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

  assert.throws(() => readE2e(path.join(fixture, "nope")));
  console.log("ok e2e-model");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
