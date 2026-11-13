/**
 * The app-e2e skills teach the formats `e2e report` reads: their fenced `markdown` examples, stitched
 * into one e2e/ folder, must parse without a single problem, and every skill names the command. The verify
 * skill's example verdict line is accepted by `e2e verdicts` against those examples.
 *
 * Run: node test/e2e-skill-formats.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { recordVerdicts } from "../src/e2e-verdicts.js";
import { skillSource } from "../src/skill.js";

const NAMES = ["app-e2e", "app-e2e-explore", "app-e2e-prd", "app-e2e-cujs", "app-e2e-testcases", "app-e2e-run", "app-e2e-maintain", "app-e2e-bug", "app-e2e-verify"];
const FILES = { inventory: "INVENTORY.md", prd: "PRD.md", cujs: "CUJs.md", cases: "TESTCASES.md", report: "reports/2026-01-01/REPORT.md" };

const kindOf = (block) => {
  if (/^### CUJ-/m.test(block)) return "cujs";
  if (/^### TC-/m.test(block)) return "cases";
  if (/^### F\d/m.test(block)) return "prd";
  if (/^## S\d/m.test(block)) return "inventory";
  if (/^\| Case \| Result \|/m.test(block)) return "report";
  return null;
};

const stitched = Object.fromEntries(Object.keys(FILES).map((k) => [k, []]));
for (const name of NAMES) {
  const source = fs.readFileSync(skillSource(name), "utf8");
  assert.match(source, /e2e report/, `${name}: names the e2e report command`);
  for (const [, block] of source.matchAll(/^```markdown\r?\n([\s\S]*?)^```/gm)) {
    const kind = kindOf(block);
    assert.ok(kind, `${name}: a markdown example that is none of the five e2e formats:\n${block}`);
    stitched[kind].push(block);
  }
}
assert.match(fs.readFileSync(skillSource("app-e2e-explore"), "utf8"), /INVENTORY\.md/, "explore names INVENTORY.md");

// The verify skill: the command, the ledger, and the brief handed to the verifier, with its words and fields.
const verify = fs.readFileSync(skillSource("app-e2e-verify"), "utf8");
assert.match(verify, /e2e verdicts/, "verify names the e2e verdicts command");
assert.match(verify, /VERIFY\.md/, "verify names VERIFY.md");
const brief = verify.match(/^=== VERIFIER BRIEF ===\r?\n([\s\S]*?)^=== END OF VERIFIER BRIEF ===/m);
assert.ok(brief, "verify holds the brief between === VERIFIER BRIEF === and === END OF VERIFIER BRIEF ===");
for (const word of ["approved", "repair", "question", "id", "verdict", "by", "reason"]) {
  assert.match(brief[1], new RegExp(`\`${word}\``), `the brief names \`${word}\``);
}
for (const name of ["app-e2e", "app-e2e-testcases", "app-e2e-maintain", "app-e2e-bug"]) {
  assert.match(fs.readFileSync(skillSource(name), "utf8"), /app-e2e-verify/, `${name} sends cases through app-e2e-verify`);
}
const example = [...verify.matchAll(/^```json\r?\n([\s\S]*?)^```/gm)].map(([, b]) => b.trim());
assert.equal(example.length, 1, "verify has one json example");
assert.equal(example[0].split("\n").length, 1, "the json example is one line");
const verdict = JSON.parse(example[0]);
assert.equal(verdict.verdict, "repair");

for (const [kind, blocks] of Object.entries(stitched)) assert.ok(blocks.length, `no skill has a ${FILES[kind]} example`);

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-skill-formats-")), "e2e");
try {
  for (const [kind, file] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), stitched[kind].join("\n"));
  }
  const m = readE2e(dir);
  // The examples parse without a problem: TC-12a's `Needs: TC-10` names a case in the same example.
  assert.deepEqual(m.problems.map((p) => `${p.file}:${p.line}: ${p.message}`), []);
  // They show a Non-goal line, a setup case and the Gap lines (failure, deep, depth).
  assert.deepEqual(m.nonGoals.map((g) => g.caps), [["C19"]]);
  assert.deepEqual(m.gaps.map((g) => [g.ref, g.kind]), [["R7.f2", "failure"], ["F3", "deep"], ["R7", "depth"]]);
  assert.deepEqual(m.cases.filter((c) => c.type === "setup").map((c) => c.id), ["TC-00"]);
  // The examples join: the case in the report is the testcases example's, and it covers the PRD's requirement.
  assert.ok(m.cases.length && m.cases.every((c) => c.id in m.results.byCase), "the report example names the case example");
  assert.ok(m.cujs.every((j) => j.proves.length) && m.cases.filter((c) => c.type !== "setup").every((c) => c.covers.length), "Proves and Covers name something");
  // The verify skill's example line is a verdict `e2e verdicts` records for a case in the examples.
  const jsonl = path.join(path.dirname(dir), "verdicts.jsonl");
  fs.writeFileSync(jsonl, example[0] + "\n");
  const recorded = recordVerdicts({ dir, file: jsonl });
  assert.equal(recorded.code, 0, recorded.lines.join("\n"));
  assert.equal(readE2e(dir).cases.find((c) => c.id === verdict.id)?.verify?.status, "repair");
} finally {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

console.log("e2e-skill-formats.test.mjs: ALL PASS");
