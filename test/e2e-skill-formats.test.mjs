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
import { quality } from "../src/e2e-quality.js";
import { dueCases, recordVerdicts } from "../src/e2e-verdicts.js";
import { caseHash } from "../src/e2e-verify.js";
import { runE2eReport } from "../src/e2e-report.js";
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
assert.match(verify, /e2e verdicts --due "<dir>"/, "the loop uses the selected document folder");
assert.match(verify, /VERIFY\.md/, "verify names VERIFY.md");
const brief = verify.match(/^=== VERIFIER BRIEF ===\r?\n([\s\S]*?)^=== END OF VERIFIER BRIEF ===/m);
assert.ok(brief, "verify holds the brief between === VERIFIER BRIEF === and === END OF VERIFIER BRIEF ===");
for (const selected of ["e2e", "qa/acceptance cases"]) {
  const dispatched = brief[1].replaceAll("<dir>", selected);
  assert.ok(dispatched.includes(`the documents are in its \`${selected}\` folder`), "the verifier receives the selected document folder");
  assert.ok(dispatched.includes(`Do not edit any file under \`${selected}\``), "the no-edit boundary follows the selected folder");
}
for (const word of ["approved", "repair", "question", "id", "verdict", "by", "reason", "text"]) {
  assert.match(brief[1], new RegExp(`\`${word}\``), `the brief names \`${word}\``);
}
for (const name of ["app-e2e", "app-e2e-testcases", "app-e2e-maintain", "app-e2e-bug"]) {
  assert.match(fs.readFileSync(skillSource(name), "utf8"), /app-e2e-verify/, `${name} sends cases through app-e2e-verify`);
}
// The brief's example output lines: an approval and a repair, each one JSON object with exactly the five string
// fields, `text` a 16-hex code.
const example = brief[1].split("\n").filter((l) => l.startsWith("{"));
const examples = example.map((l) => JSON.parse(l));
assert.equal(examples.length, 2);
for (const o of examples) {
  assert.deepEqual(Object.keys(o).sort(), ["by", "id", "reason", "text", "verdict"]);
  for (const v of Object.values(o)) assert.equal(typeof v, "string");
  assert.match(o.text, /^[0-9a-f]{16}$/);
}
assert.match(brief[1], /`TC-1a@<code>`|TC-\w+@/, "the brief shows how a case comes with its code");
assert.ok(examples.some((o) => o.verdict === "approved"), "the brief shows an approved line");
const verdict = examples.find((o) => o.verdict === "repair");
assert.ok(verdict, "the brief shows a repair line");

for (const [kind, blocks] of Object.entries(stitched)) assert.ok(blocks.length, `no skill has a ${FILES[kind]} example`);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-skill-formats-"));
const dir = path.join(workspace, "qa", "acceptance cases");
try {
  for (const [kind, file] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), stitched[kind].join("\n"));
  }
  const m = readE2e(dir);
  // The examples parse without a problem: TC-12a's `Needs: TC-12` names a case in the same example.
  assert.deepEqual(m.problems.map((p) => `${p.file}:${p.line}: ${p.message}`), []);
  // They show a Non-goal line, a setup case and the Gap lines (failure, deep, depth).
  assert.deepEqual(m.nonGoals.map((g) => g.caps), [["C19"]]);
  assert.deepEqual(m.gaps.map((g) => [g.ref, g.kind]), [["R7.f2", "failure"], ["F3", "deep"], ["R7", "depth"]]);
  assert.deepEqual(m.cases.filter((c) => c.type === "setup").map((c) => c.id), ["TC-00"]);
  // The examples join: the case in the report is the testcases example's, and it covers the PRD's requirement.
  assert.ok(m.cases.length && m.cases.every((c) => c.id in m.results.byCase), "the report example names the case example");
  assert.ok(m.cujs.every((j) => j.proves.length) && m.cases.filter((c) => c.type !== "setup").every((c) => c.covers.length), "Proves and Covers name something");
  // The verify skill's example line is a verdict `e2e verdicts` records for a case in the examples, once its text
  // is the stitched case's real code (as `--due` would hand it out).
  const jsonl = path.join(path.dirname(dir), "verdicts.jsonl");
  fs.writeFileSync(jsonl, JSON.stringify({ ...verdict, text: caseHash(m, verdict.id) }) + "\n");
  const recorded = recordVerdicts({ dir, file: jsonl });
  assert.equal(recorded.code, 0, recorded.lines.join("\n"));
  assert.equal(readE2e(dir).cases.find((c) => c.id === verdict.id)?.verify?.status, "repair");

  // Follow the loop through its final repair, when the attempt cap stops further judging.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = readE2e(dir);
    if (attempt > 1) {
      fs.writeFileSync(jsonl, JSON.stringify({ ...verdict, reason: `Fixture repair ${attempt}`, text: caseHash(current, verdict.id) }) + "\n");
      assert.equal(recordVerdicts({ dir, file: jsonl }).code, 0);
    }
    assert.equal(runE2eReport({ dir }).code, 0);
    const file = path.join(dir, "TESTCASES.md");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.splice(current.cases.find((c) => c.id === verdict.id).line, 0, `Expected: repair ${attempt} is observable.`);
    fs.writeFileSync(file, lines.join("\n"));
  }
  assert.ok(!dueCases(readE2e(dir)).join(" ").includes(`${verdict.id}@`), "three repairs exhaust the case's attempts");
  assert.equal(runE2eReport({ dir, check: true }).code, 1, "the last edit needs a refresh");
  const gate = verify.split("## Gate 2\n")[1].split("Give the user")[0];
  if (gate.includes('`npx -y @codedroid/mcp e2e report "<dir>"`')) assert.equal(runE2eReport({ dir }).code, 0);
  assert.equal(runE2eReport({ dir, check: true }).code, 0, "Gate 2 must refresh after the final repair");
  assert.match(fs.readFileSync(path.join(dir, "TESTCASES.html"), "utf8"), /repair 3 is observable/);
  const reasonSource = verify.split("## Gate 2\n")[1].match(/last reason from the case's verifier history in\s+`<dir>\/([^`]+)`/)?.[1] ?? "QUALITY.md";
  const lastReason = readE2e(dir).cases.find((c) => c.id === verdict.id).verify.reason;
  assert.ok(fs.readFileSync(path.join(dir, reasonSource), "utf8").includes(lastReason), "Gate 2's prescribed source must contain the last reason, not just a stale label");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

// The formats the skills teach inline, in their prose: each is in its skill word for word (line breaks
// count as spaces), and a folder built from them parses without a problem. [skill, the text in it, the
// line or lines it gives in the folder] A text that is one backticked format also matches its line; a
// rule sentence is checked word for word, and the folder follows it.
const INLINE = [
  ["app-e2e-prd", "`Fails: none in source`", "  Fails: none in source"],
  ["app-e2e-prd", "`Caps: none`", "  Caps: none"],
  ["app-e2e-prd", "`- Non-goal: C40, C41 · why`", "- Non-goal: C40, C41 · why"],
  ["app-e2e-prd", "`- R9 · The list keeps its order after a restart?`", "- R9 · The list keeps its order after a restart?"],
  ["app-e2e-maintain", "`- Non-goal: C<n> · reason`", "- Non-goal: C42 · reason"],
  ["app-e2e-maintain", "`- Gap: <ref> · reason`", "- Gap: R9 · reason"],
  ["app-e2e-maintain", "`Retired: <date> - <why>`", "Retired: 2026-01-01 - the screen was removed"],
  ["app-e2e-maintain", "`R3 depth`", "- Gap: R3 depth · why"],
  ["app-e2e-testcases", "`F1 deep`", "- Gap: F1 deep · why"],
  ["app-e2e-testcases", "`Why manual: <reason>`", "Why manual: needs the previous release"],
  ["app-e2e-cujs", "`Why manual: <reason>`", "Why manual: needs the previous release"],
  ["app-e2e-explore", "then its title on screen in double quotes, and nothing after the closing quote", '## S1 · NotesActivity · "Notes"'],
  ["app-e2e-explore", "Rows sit directly under their screen's heading, with no sub-heading inside a screen: a menu's or a dialog's controls are rows of the screen that opens it.", '## S1 · NotesActivity · "Notes"\n| Id | Control | Does | Source | States | Seen |'],
  ["app-e2e-run", "zero-padded date alone", "reports/2026-01-01"],
  ["app-e2e-run", "it must be the report's only table that starts with Case and Result", "| Case | Result |"],
  ["app-e2e-prd", "A requirement line starts exactly `- R<n> · ` (a hyphen, no bold, no number).", "- R3 · A saved note is listed."],
  ["app-e2e-prd", "`- R<n> · `", "- R3 · A saved note is listed."],
  ["app-e2e-prd", "marked for the first run to confirm by a `?` at the end of its text, never in its id:", "- R9 · The list keeps its order after a restart?"],
  ["app-e2e-cujs", "under a level-2 heading per feature (`## F3 · Skills`)", "## F1 · Notes"],
  ["app-e2e-cujs", "Manual CUJs stay in, marked `manual` in the heading, with the reason on a line under it, never in the heading: `Why manual: <reason>`", "### CUJ-2 · An upgrade keeps the order · P1 · manual\nWhy manual: needs the previous release"],
  ["app-e2e-testcases", "A gap is a line `- Gap: <ref> · <reason>` under a `## Gaps` heading", "## Gaps\n- Gap: F1 deep · why"],
  ["app-e2e-testcases", "`- Gap: <ref> · <reason>`", "- Gap: R9 · reason"],
  ["app-e2e-testcases", "a requirement id and the word depth (`R7 depth`", "- Gap: R3 depth · why"],
  ["app-e2e-testcases", "`Run mode:` is `phone`, `task` when the case makes CodeDroid's own agent run something, or `manual` (the PRD's scale), and nothing else: a manual case's reason goes on its own line, `Why manual: <reason>`.", "Run mode: manual\nWhy manual: needs the previous release"],
  ["app-e2e-testcases", "A setup case proves nothing: it needs only its `Run mode:` line, and `Covers:`, `Tier:` and `Depth:` are left out.", "Feature: all · Type: setup\nRun mode: phone\n"],
  ["app-e2e-testcases", "Keep `Covers:` on one line: a wrapped line is not read.", "Covers: R3 (C1)\n"],
  ["app-e2e-bug", "Its `REPORT.md` has the results table as app-e2e-run writes it, with one row for this case (both runs in its Notes).", "| TC-1a | fail | failed both runs |\n"],
  ["app-e2e-run", "A `manual` case is never run: give it a `not run` row with its `Why manual:` reason, and never follow its steps.", "| TC-2a | not run | needs the previous release |"],
  ["app-e2e-maintain", "Then delete the feature's heading and requirements from `PRD.md`, its control rows and any screen left with no row from `INVENTORY.md`, its controls from any `- Non-goal:` line (a line left with none goes), its `- Gap:` lines, and its requirement ids from any other journey's `Proves:`; retired cases and journeys may still name them.", "Retired: 2026-01-01 - the screen was removed\nFeature: F2 · Type: happy\nCovers: R7 (C9)"],
  ["app-e2e", "at gate 2 the page to look at is its \"Left open\" list: requirements with no runnable case, requirements whose deepest case is shallower than their Proof, failure lines of P0 and P1 features with no runnable case, and P0 features with no deep case, each until a case or a `Gap:` line settles it.", "- Gap: R3.f2 · the phone must be offline"],
  ["app-e2e-testcases", "\"Left open\" lists requirements with no runnable case, requirements whose deepest case is shallower than their Proof, failure lines of P0 and P1 features with no runnable case, and P0 features with no deep case, each with no Gap line", "- Gap: R3.f2 · the phone must be offline"],
  ["app-e2e-maintain", "its \"Left open\" list (requirements with no runnable case, requirements whose deepest case is shallower than their Proof, failure lines of P0 and P1 features with no runnable case, P0 features with no deep case; none with a Gap line)", "- Gap: R3.f2 · the phone must be offline"],
  ["app-e2e-testcases", "Write it as a `manual` case with `Why manual: the phone must be offline`, and give the failure a `- Gap:` line too, since a manual case settles nothing", "Covers: R3.f2 (C1)\nTier: edge · Depth: screen\nRun mode: manual\nWhy manual: the phone must be offline"],
  ["app-e2e-testcases", "the blocked or confirmed behavior is a failure of that requirement, so add a failure line `R<n>.f<m>` for it in `PRD.md`, with its exact words, then give that failure a case or a `- Gap:` line.", "  - R3.f1 · \"Save\" stays disabled while the title is empty"],
];
const flat = (s) => s.replace(/\s+/g, " ");
const pattern = (taught) => new RegExp(taught.replace(/`/g, "").split(/<[^>]+>/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+"));
const ROW = "| --- | --- | --- | --- | --- | --- |";
const INLINE_FILES = {
  "INVENTORY.md": `## S1 · NotesActivity · "Notes"\n| Id | Control | Does | Source | States | Seen |\n${ROW}
| C1 | text "Save" | stores the note | Notes.kt:1 | | yes |
| C40 | text "Share" | sends the note | Notes.kt:2 | | no: needs a second account |
| C41 | text "Sync" | syncs | Notes.kt:3 | | no: needs a second phone |
| C42 | text "Print" | prints | Notes.kt:4 | | no: no printer |
`,
  "PRD.md": `### F1 · Notes · P0
Gates: "Save" disabled while the title is empty.
- R3 · A saved note is listed.
  Caps: C1
  Proof: kept
  Fails:
  - R3.f1 · "Save" stays disabled while the title is empty
  - R3.f2 · with no connection, "Couldn't save" shows
- R9 · The list keeps its order after a restart?
  Caps: none
  Proof: screen
  Fails: none in source

## Non-goals
- Non-goal: C40, C41 · why
- Non-goal: C42 · reason
`,
  "CUJs.md": `## F1 · Notes

### CUJ-1 · Keep a note · P0 · phone
Proves: R3
- "e2e-a" is listed.

### CUJ-2 · An upgrade keeps the order · P1 · manual
Why manual: needs the previous release
Proves: R9
- The notes keep their order.

### CUJ-3 · An old journey · P2 · phone
Retired: 2026-01-01 - the screen was removed
`,
  "TESTCASES.md": `### TC-1a · P0 · Save a note
Feature: F1 · Type: happy
Covers: R3 (C1)
Tier: core · Depth: screen
Run mode: phone
Expected: the note is in the list.

### TC-1b · P0 · An empty title cannot be saved
Feature: F1 · Type: negative
Covers: R3.f1 (C1)
Tier: edge · Depth: screen
Run mode: phone
Expected: "Save" stays disabled.

### TC-1c · P0 · Saving with no connection
Feature: F1 · Type: negative
Covers: R3.f2 (C1)
Tier: edge · Depth: screen
Run mode: manual
Why manual: the phone must be offline
Expected: "Couldn't save".

### TC-2a · P1 · An upgrade keeps the order
Feature: F1 · Type: happy
Covers: R9
Tier: core · Depth: screen
Run mode: manual
Why manual: needs the previous release
Expected: the order is kept.

### TC-00 · P1 · Remove leftovers
Feature: all · Type: setup
Run mode: phone

### TC-3a · P2 · An old case
Retired: 2026-01-01 - the screen was removed
Feature: F2 · Type: happy
Covers: R7 (C9)

## Gaps
- Gap: F1 deep · why
- Gap: R3 depth · why
- Gap: R9 · reason
- Gap: R3.f2 · the phone must be offline
`,
  "reports/2026-01-01/REPORT.md": "| Case | Result | Notes |\n| --- | --- | --- |\n| TC-1a | pass | |\n| TC-2a | not run | needs the previous release |\n",
  "reports/2026-01-01-bug-TC-1a/REPORT.md": "| Case | Result | Notes |\n| --- | --- | --- |\n| TC-1a | fail | failed both runs |\n",
};
const inlineDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-skill-inline-")), "e2e");
try {
  for (const [file, text] of Object.entries(INLINE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(inlineDir, file)), { recursive: true });
    fs.writeFileSync(path.join(inlineDir, file), text);
  }
  const all = Object.entries(INLINE_FILES).map(([f, t]) => `${f}\n${t}`).join("\n");
  for (const [name, taught, line] of INLINE) {
    assert.ok(flat(fs.readFileSync(skillSource(name), "utf8")).includes(taught), `${name} teaches ${taught} word for word`);
    if (/^`[^`]+`$/.test(taught)) assert.match(line, pattern(taught), `the folder's line follows ${taught}`);
    assert.ok(all.includes(line), `the folder uses ${line}`);
  }
  const m = readE2e(inlineDir);
  assert.deepEqual(m.problems.map((p) => `${p.file}:${p.line}: ${p.message}`), []);
  assert.deepEqual(m.gaps.map((g) => [g.ref, g.kind]), [["F1", "deep"], ["R3", "depth"], ["R9", "requirement"], ["R3.f2", "failure"]]);
  assert.deepEqual(quality(m).open, [], "nothing is left open");
  assert.deepEqual(m.cases.filter((c) => c.retired).map((c) => c.id), ["TC-3a"]);
  assert.deepEqual(m.cases.filter((c) => c.type === "setup").map((c) => [c.id, c.mode]), [["TC-00", "phone"]]);
  assert.deepEqual([m.results.report, m.cases.find((c) => c.id === "TC-2a").mode], ["reports/2026-01-01/REPORT.md", "manual"]);
  assert.deepEqual(m.cujs.filter((c) => c.retired).map((c) => c.id), ["CUJ-3"]);
  assert.deepEqual(m.requirements.map((r) => [r.id, r.caps]), [["R3", ["C1"]], ["R9", []]]);
} finally {
  fs.rmSync(path.dirname(inlineDir), { recursive: true, force: true });
}

console.log("e2e-skill-formats.test.mjs: ALL PASS");
