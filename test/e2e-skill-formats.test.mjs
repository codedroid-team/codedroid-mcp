/**
 * The app-e2e skills teach the formats `e2e report` reads: their fenced `markdown` examples, stitched
 * into one e2e/ folder, must parse without a single problem, and every skill names the command.
 *
 * Run: node test/e2e-skill-formats.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { skillSource } from "../src/skill.js";

const NAMES = ["app-e2e", "app-e2e-explore", "app-e2e-prd", "app-e2e-cujs", "app-e2e-testcases", "app-e2e-run", "app-e2e-maintain", "app-e2e-bug"];
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
for (const [kind, blocks] of Object.entries(stitched)) assert.ok(blocks.length, `no skill has a ${FILES[kind]} example`);

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-skill-formats-")), "e2e");
try {
  for (const [kind, file] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), stitched[kind].join("\n"));
  }
  const m = readE2e(dir);
  assert.deepEqual(m.problems.map((p) => `${p.file}:${p.line}: ${p.message}`), []);
  // The examples join: the case in the report is the testcases example's, and it covers the PRD's requirement.
  assert.ok(m.cases.length && m.cases.every((c) => c.id in m.results.byCase), "the report example names the case example");
  assert.ok(m.cujs.every((j) => j.proves.length) && m.cases.every((c) => c.covers.length), "Proves and Covers name something");
} finally {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

console.log("e2e-skill-formats.test.mjs: ALL PASS");
