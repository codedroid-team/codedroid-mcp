/**
 * VERIFY.md: the verifier's ledger read back. parseVerify (rows and problems), caseText/caseHash (what a verdict
 * was given on), statusOf (a case's status from its rows and current hash) and the model's per-case `verify`.
 *
 * Fixture hashes: if this test says the fixture is stale, regenerate them with
 *   node -e 'import("./src/e2e-model.js").then(async(m)=>{const v=await import("./src/e2e-verify.js");const x=m.readE2e("test/fixtures/e2e-sample");for(const c of x.cases)console.log(c.id,v.caseHash(x,c.id))})'
 * and write them into test/fixtures/e2e-sample/VERIFY.md.
 *
 * Run: node test/e2e-verify.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { caseHash, caseText, cycleOf, parseVerify, statusOf } from "../src/e2e-verify.js";

const fixture = new URL("./fixtures/e2e-sample", import.meta.url).pathname;
const tmps = [];
const copy = (edit) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-verify-"));
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
const HEAD = "| Item | Attempt | Verdict | By | Text | Date | Reason |\n| --- | --- | --- | --- | --- | --- | --- |\n";
const H = "0123456789abcdef";
const G = "fedcba9876543210";
const row = (item, attempt, verdict, text = H, reason = "r", by = verdict === "reopen" ? "user" : "independent") => `| ${item} | ${attempt} | ${verdict} | ${by} | ${text} | 2026-11-14 | ${reason} |`;

try {
  // The fixture: histories and the statuses they give.
  const m = readE2e(fixture);
  assert.deepEqual(m.problems, []);
  const st = Object.fromEntries(m.cases.map((c) => [c.id, c.verify.status]));
  assert.deepEqual(st, { "TC-1a": "approved", "TC-1b": "approved", "TC-1c": "repair", "TC-2a": "question", "TC-3a": "unresolved", "TC-3b": "unverified" });
  assert.deepEqual(m.cases.map((c) => c.verify.attempt), [1, 2, 1, 1, 3, 0]);
  assert.deepEqual(m.cases.map((c) => c.verify.history.length), [1, 2, 1, 1, 3, 0]);
  assert.equal(m.cases[1].verify.by, "same");
  assert.ok(m.cases.some((c) => c.verify.by === "independent"));
  assert.equal(m.cases[1].verify.hash, caseHash(m, "TC-1b"));
  assert.deepEqual(m.verify.orphans, 0);
  assert.equal(m.verify.rows.length, 8);
  assert.ok(m.files["VERIFY.md"].sha256);
  // Every fixture row is on the current text, so a later edit to the fixture cannot silently stale it.
  for (const r of m.verify.rows) {
    assert.equal(r.text, caseHash(m, r.item), `fixture ${r.item} row (line ${r.line}) is not on the current text: regenerate the hashes in test/fixtures/e2e-sample/VERIFY.md (see the command at the top of this test)`);
  }

  // What is judged: the case block, then each covered requirement in id order, a failure id naming its requirement.
  const t1b = caseText(m, "TC-1b");
  assert.ok(t1b.startsWith("### TC-1b · P1 · Saving with no connection keeps the text\nFeature: F1"));
  assert.ok(t1b.includes("\n--- R1\n- R1 · A saved note appears in the list with its title.\n  Caps: C4\n  Proof: kept\n  Fails:\n  - R1.f1"));
  assert.equal(t1b.split("--- R1").length, 2, "R1 once for R1.f1 and R1.f2");
  assert.ok(!t1b.includes("R2"));
  assert.ok(t1b.includes(`an empty title leaves "Save" disabled\n--- C4\n| C4 | text "Save" |`), "the requirement's last line, then the covered control's INVENTORY row");
  assert.ok(t1b.endsWith(`error "Couldn't save" | yes |`), "ends at the last covered control's row");
  // H6. Each covered control's INVENTORY row, in id order: the bracketed ones, or the requirement's Caps without brackets.
  const ctl = (id) => caseText(m, id).split("\n").filter((l) => l.startsWith("--- C")).join(" ");
  assert.equal(ctl("TC-1c"), "--- C1 --- C3");
  assert.equal(ctl("TC-3b"), "--- C2", "Covers: R4 with no brackets: R4's Caps");
  const swapped = readE2e(copy((d) => sub(d, "TESTCASES.md", "Covers: R2 (C1, C3)", "Covers: R2 (C3, C1)")));
  assert.equal(caseText(swapped, "TC-1c").split("--- C").length, 3);
  assert.ok(caseText(swapped, "TC-1c").indexOf("--- C1") < caseText(swapped, "TC-1c").indexOf("--- C3"), "ascending id order");
  const tenth = readE2e(copy((d) => {
    fs.appendFileSync(path.join(d, "INVENTORY.md"), "| C10 | text \"Undo\" | restores the note | app/src/main/java/notes/ListFragment.kt:90 | | yes |\n");
    sub(d, "PRD.md", "  Caps: C1, C3", "  Caps: C10, C1, C3");
    sub(d, "TESTCASES.md", "Covers: R2 (C1, C3)", "Covers: R2 (C10, C3)");
  }));
  assert.deepEqual(caseText(tenth, "TC-1c").split("\n").filter((l) => l.startsWith("--- C")), ["--- C3", "--- C10"], "numeric, not string, order");
  assert.ok(!caseText(m, "TC-1a").includes("C6"), "an uncovered control is not part of the text");

  assert.ok(!caseText(m, "TC-1a").includes("TC-1b"), "a case block ends at the next heading");
  assert.equal(caseHash(m, "TC-1a").length, 16);
  assert.match(caseHash(m, "TC-1a"), /^[0-9a-f]{16}$/);
  assert.equal(caseText(m, "TC-9z"), null);

  // Editing the judged text: the case, a covered requirement's Proof, a requirement it does not cover.
  const stale = (file, from, to) => readE2e(copy((d) => sub(d, file, from, to)));
  assert.equal(stale("TESTCASES.md", "Expected: the title is in the list.", "Expected: nothing.").cases[0].verify.status, "stale");
  assert.equal(stale("PRD.md", "  Proof: kept", "  Proof: screen").cases[0].verify.status, "stale");
  assert.equal(stale("PRD.md", "  Proof: screen\n  Fails:\n  - R2.f1", "  Proof: kept\n  Fails:\n  - R2.f1").cases[0].verify.status, "approved");
  assert.equal(stale("PRD.md", "Typing in search narrows", "Typing narrows").cases[0].verify.status, "approved");
  assert.equal(stale("PRD.md", "Typing in search narrows", "Typing narrows").cases[4].verify.status, "stale", "TC-3a covers R4: stale beats unresolved");
  // A covered control's row (label, source line, state) is judged text; an uncovered control's row is not.
  assert.equal(stale("INVENTORY.md", "| C4 | text \"Save\" |", "| C4 | text \"Save note\" |").cases[0].verify.status, "stale");
  assert.equal(stale("INVENTORY.md", "EditorFragment.kt:88", "EditorFragment.kt:91").cases[0].verify.status, "stale");
  assert.equal(stale("INVENTORY.md", "disabled while the title is empty", "disabled while empty").cases[1].verify.status, "stale", "TC-1b covers C4 through R1.f1 (C4)");
  assert.deepEqual(stale("INVENTORY.md", "hands the note text to the share sheet", "shares it").cases.map((c) => c.verify.status), m.cases.map((c) => c.verify.status), "C6 is covered by no case");
  assert.equal(stale("INVENTORY.md", "filters the list by title", "filters by title").cases[0].verify.status, "approved", "C2 is not TC-1a's");
  // CRLF and trailing spaces do not change the hash.
  const crlf = readE2e(copy((d) => {
    for (const f of ["TESTCASES.md", "PRD.md", "INVENTORY.md"]) {
      const p = path.join(d, f);
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/\n/g, "  \r\n"));
    }
  }));
  assert.deepEqual(crlf.cases.map((c) => c.verify.hash), m.cases.map((c) => c.verify.hash));
  assert.equal(crlf.cases[0].verify.status, "approved");

  // A requirement is its own line and the indented lines below it: the next non-blank line at the margin ends it.
  const codes = (x) => x.cases.map((c) => c.verify.hash);
  const statuses = (x) => x.cases.map((c) => c.verify.status);
  const tail = (words) => readE2e(copy((d) => sub(d, "PRD.md", "  Fails: none in source\n\n### F2", `  Fails: none in source\n${words}\n\n### F2`)));
  for (const x of [tail("Tail note: first wording."), tail("Tail note: second wording.")]) {
    assert.deepEqual(x.problems, []);
    assert.deepEqual(codes(x), codes(m), "a margin line after F1's last requirement is not part of R3");
    assert.deepEqual(statuses(x), statuses(m));
  }
  const nonGoal = (why) => readE2e(copy((d) => sub(d, "PRD.md", '"Save" disabled\n- R2', `"Save" disabled\n- Non-goal: C6 · ${why}\n- R2`)));
  for (const x of [nonGoal("first reason"), nonGoal("second reason")]) {
    assert.deepEqual(x.problems, []);
    assert.deepEqual(codes(x), codes(m), "a Non-goal line right after R1 is not part of R1");
  }
  const indented = (words) => readE2e(copy((d) => sub(d, "PRD.md", "its text.\n  Caps: C1, C3", `its text.\n  ${words}\n  Caps: C1, C3`)));
  const [ia, ib] = [indented("Note: first wording."), indented("Note: second wording.")];
  assert.deepEqual(ib.problems, []);
  assert.deepEqual(ia.cases.map((c, i) => c.verify.hash !== ib.cases[i].verify.hash), [false, false, true, false, false, false], "an indented line belongs to R2: only TC-1c covers it");
  assert.equal(ib.cases[2].verify.status, "stale");
  const unreadable = readE2e(copy((d) => sub(d, "PRD.md", "- R2 · A tap", "- **R2** · A tap")));
  const r1 = unreadable.requirements.find((r) => r.id === "R1");
  assert.equal(unreadable.files["PRD.md"].text.split("\n")[r1.lines[1]], "- **R2** · A tap on a note opens it with its text.", "R1 ends right before an unreadable requirement line");
  assert.ok(!caseText(unreadable, "TC-1a").includes("R2"));
  // The parser ends a requirement at the same line: fields below a margin line are not the requirement's.
  const cut = readE2e(copy((d) => sub(d, "PRD.md", "removes it from the list.\n  Caps: C5", "removes it from the list.\nA margin line.\n  Caps: C5")));
  assert.ok(cut.problems.some((p) => p.message === "R3 has no Caps: line"));
  assert.deepEqual(cut.requirements.find((r) => r.id === "R3").lines, [20, 20]);

  // Setup and retired cases are never judged.
  const odd = readE2e(copy((d) => {
    fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-9s · P1 · Sign in\nFeature: all · Type: setup\nRun mode: phone\n\n### TC-9r · P1 · Gone\nRetired: removed in 2.0\n");
    fs.appendFileSync(path.join(d, "VERIFY.md"), row("TC-9s", 1, "approved") + "\n" + row("TC-9r", 1, "approved") + "\n" + row("TC-0z", 1, "approved") + "\n");
  }));
  assert.deepEqual(odd.problems, []);
  assert.deepEqual(odd.cases.slice(-2).map((c) => c.verify), [null, null]);
  assert.equal(odd.verify.orphans, 3, "rows for setup, retired and unknown ids are orphans");

  // No VERIFY.md: not a problem, not pending, everything unverified.
  const none = readE2e(copy((d) => fs.rmSync(path.join(d, "VERIFY.md"))));
  assert.deepEqual(none.problems, []);
  assert.deepEqual(none.pending, []);
  assert.ok(none.cases.every((c) => c.verify.status === "unverified" && c.verify.attempt === 0));
  assert.deepEqual(none.verify, { rows: [], orphans: 0, superseded: [] });
  assert.ok(!("VERIFY.md" in none.files));

  // A linked VERIFY.md is a problem and is not read.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-verify-out-"));
  tmps.push(outside);
  fs.writeFileSync(path.join(outside, "V.md"), HEAD + row("TC-1a", 1, "approved") + "\n");
  const linked = readE2e(copy((d) => { fs.rmSync(path.join(d, "VERIFY.md")); fs.symlinkSync(path.join(outside, "V.md"), path.join(d, "VERIFY.md")); }));
  assert.deepEqual(linked.problems.map((p) => p.file), ["VERIFY.md"]);
  assert.ok(!("VERIFY.md" in linked.files));
  assert.equal(linked.cases[0].verify.status, "unverified");

  // parseVerify: rows, and one problem per kind with its line.
  const pv = (body) => parseVerify(HEAD + body);
  const ok = pv(row("TC-1a", 1, "repair", H, "a \\| b `unbalanced") + "\n" + row("TC-1a", 2, "approved") + "\n");
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.rows[0], { item: "TC-1a", attempt: 1, verdict: "repair", by: "independent", text: H, date: "2026-11-14", reason: "a | b `unbalanced", line: 3 });
  const bad = (line, message) => assert.deepEqual(pv(line + "\n").problems, [{ line: 3, message }], message);
  bad(row("TC-1a", 1, "repair").slice(1), "row must start with |");
  bad("| TC-1a | 1 | repair | independent | " + H + " | 2026-11-14 |", "row has 6 cells, expected 7");
  bad(row("TC-1a", 1, "maybe"), "verdict must be approved, repair, question or reopen");
  bad(row("TC-1a", 1, "repair").replace("independent", "robot"), "By must be independent, same or user");
  // `user` is the reopen row's By, and only its.
  bad(row("TC-1a", 0, "reopen", H, "r", "independent"), "a reopen row must have By user");
  bad(row("TC-1a", 0, "reopen", H, "r", "same"), "a reopen row must have By user");
  bad(row("TC-1a", 1, "repair", H, "r", "user"), "By user is only for a reopen row");
  assert.equal(pv(row("TC-1a", 0, "reopen") + "\n").rows[0].by, "user");
  bad(row("TC-1a", 1, "repair", "3f9a"), "Text must be 16 hex characters");
  bad(row("TC-1a", 1, "repair", H, ""), "reason is empty");
  bad(row("TC-1a", 1, "repair").replace("2026-11-14", "14/11/2026"), "Date must be YYYY-MM-DD");
  bad(row("TC-1a", 2, "repair"), "TC-1a attempt 2 does not follow attempt 0");
  bad(row("TC-1a", "x", "repair"), "Attempt must be a number");
  const order = pv(row("TC-1a", 1, "repair") + "\n" + row("TC-1a", 3, "repair") + "\n");
  assert.deepEqual(order.problems, [{ line: 4, message: "TC-1a attempt 3 does not follow attempt 1" }]);
  // Attempts restart after approved and reopen; a reopen row carries attempt 0 (or -).
  const cyc = pv([row("TC-1a", 1, "repair"), row("TC-1a", 2, "approved"), row("TC-1a", 1, "repair"), row("TC-1a", 0, "reopen"), row("TC-1a", 1, "repair"), row("TC-1a", "-", "reopen")].join("\n") + "\n");
  assert.deepEqual(cyc.problems, []);
  assert.equal(cyc.rows[5].attempt, 0);
  assert.deepEqual(pv(row("TC-1a", 1, "reopen")).problems.map((p) => p.message), ["reopen must have attempt 0 or -"]);
  // Items are independent of each other.
  assert.deepEqual(pv(row("TC-1a", 1, "repair") + "\n" + row("TC-1b", 1, "repair") + "\n").problems, []);
  // Rows in a bad file reach the model's problems as VERIFY.md with the line.
  const withBad = readE2e(copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), row("TC-1a", 1, "approved", "zz") + "\n")));
  assert.deepEqual(withBad.problems.map((p) => [p.file, p.message]), [["VERIFY.md", "Text must be 16 hex characters"]]);
  assert.equal(withBad.problems[0].line, fs.readFileSync(path.join(fixture, "VERIFY.md"), "utf8").trimEnd().split("\n").length + 1);

  // A row that cannot be read marks its case invalid (checked before every other status); numbering skips it.
  const badRow = (item, rest = "| 1 | repair | independent | " + H + " | 2026-11-14") => `| ${item} ${rest} |`; // six cells
  const six = pv(row("TC-1a", 1, "approved") + "\n" + badRow("TC-1a") + "\n" + row("TC-1a", 2, "repair") + "\n");
  assert.deepEqual(six.problems, [{ line: 4, message: "row has 6 cells, expected 7" }], "one problem, none on the following valid row");
  assert.deepEqual(six.rejected, [{ item: "TC-1a", line: 4, message: "row has 6 cells, expected 7" }]);
  assert.equal(six.rows.length, 2);
  const inv = (body, extra) => readE2e(copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), body)));
  const sixM = inv(badRow("TC-1a") + "\n");
  const missingPipe = inv(row("TC-1a", 1, "repair", caseHash(m, "TC-1a")).slice(1) + "\n");
  assert.equal(missingPipe.cases[0].verify.status, "invalid", "a missing delimiter must not restore the old approval");
  assert.equal(missingPipe.cases[0].verify.rejected.length, 1);
  assert.equal(cycleOf(missingPipe.cases[0].verify.history, missingPipe.cases[0].verify.rejected).length, 1);
  assert.deepEqual(missingPipe.problems.map((p) => p.message), ["row must start with |"]);
  assert.equal(sixM.cases[0].verify.status, "invalid");
  assert.match(sixM.cases[0].verify.reason, /^VERIFY\.md line \d+ cannot be read$/);
  assert.equal(sixM.problems.length, 1);
  assert.equal(inv(row("TC-1a", 1, "repair").replace("2026-11-14", "14/11/2026") + "\n").cases[0].verify.status, "invalid");
  const unk = inv(badRow("TC-0z") + "\n");
  assert.equal(unk.problems.length, 1);
  assert.deepEqual(unk.cases.map((c) => c.verify.status), m.cases.map((c) => c.verify.status), "an unknown id changes no case");
  assert.deepEqual(sixM.verify.superseded, []);
  assert.deepEqual(unk.verify.superseded, [], "an unknown id is never superseded");
  // An unreadable row, then a readable verdict for the case: superseded, no problem, the case takes its status.
  const firstBad = readE2e(copy((d) => fs.writeFileSync(path.join(d, "VERIFY.md"), HEAD + badRow("TC-1a") + "\n" + row("TC-1a", 2, "approved", caseHash(m, "TC-1a")) + "\n")));
  assert.equal(firstBad.cases[0].verify.status, "approved");
  assert.deepEqual(firstBad.problems, []);
  assert.deepEqual(firstBad.verify.superseded, [{ item: "TC-1a", line: 3 }]);
  assert.equal(firstBad.cases[0].verify.history.length, 1);
  // Only the latest unreadable row counts: one after the latest readable verdict makes the case invalid again.
  const again = readE2e(copy((d) => fs.writeFileSync(path.join(d, "VERIFY.md"), HEAD + badRow("TC-1a") + "\n" + row("TC-1a", 2, "repair", caseHash(m, "TC-1a")) + "\n" + badRow("TC-1a") + "\n")));
  assert.equal(again.cases[0].verify.status, "invalid");
  assert.match(again.cases[0].verify.reason, /^VERIFY\.md line 5 cannot be read$/);
  assert.deepEqual(again.problems.map((p) => p.line), [5]);
  assert.deepEqual(again.verify.superseded, [{ item: "TC-1a", line: 3 }]);
  // A reopen row is not a verdict: it supersedes nothing.
  const reo = readE2e(copy((d) => fs.writeFileSync(path.join(d, "VERIFY.md"), HEAD + badRow("TC-1a") + "\n" + row("TC-1a", 0, "reopen", caseHash(m, "TC-1a")) + "\n")));
  assert.equal(reo.cases[0].verify.status, "invalid");


  // H5. A row whose attempt does not follow its cycle, or whose date is not a calendar date, is rejected: not used.
  const ooo = readE2e(copy((d) => fs.writeFileSync(path.join(d, "VERIFY.md"), HEAD + row("TC-1a", 1, "repair", caseHash(m, "TC-1a")) + "\n" + row("TC-1a", 10, "approved", caseHash(m, "TC-1a")) + "\n")));
  assert.equal(ooo.cases[0].verify.status, "invalid", "repair 1 then approved attempt 10 does not read approved");
  assert.deepEqual(ooo.cases[0].verify.history.map((h) => h.verdict), ["repair"]);
  assert.deepEqual(ooo.problems.map((p) => [p.line, p.message]), [[4, "TC-1a attempt 10 does not follow attempt 1"]]);
  bad(row("TC-1a", 1, "repair").replace("2026-11-14", "2026-13-45"), "Date 2026-13-45 is not a calendar date");
  bad(row("TC-1a", 1, "repair").replace("2026-11-14", "2026-02-30"), "Date 2026-02-30 is not a calendar date");
  assert.deepEqual(pv(row("TC-1a", 1, "repair").replace("2026-11-14", "2024-02-29") + "\n").problems, [], "a leap day is a date");
  assert.equal(inv(row("TC-1a", 1, "approved", caseHash(m, "TC-1a")).replace("2026-11-14", "2026-13-45") + "\n").cases[0].verify.status, "invalid");
  // A rejected row naming a case occupies a slot in its cycle: the next readable row is numbered after it.
  const slot = pv(row("TC-1a", 1, "repair") + "\n" + badRow("TC-1a") + "\n" + row("TC-1a", 3, "repair") + "\n");
  assert.deepEqual(slot.problems.map((p) => p.line), [4]);
  assert.deepEqual(slot.rows.map((x) => x.attempt), [1, 3]);
  assert.equal(cycleOf(slot.rows, slot.rejected).length, 3);
  assert.equal(cycleOf(slot.rows).length, 2);
  // Three slots used, the last one damaged: unresolved once a later readable row exists... the cycle counts it.
  const capped = statusOf(slot.rows.slice(0, 1).concat([{ ...slot.rows[1], attempt: 3 }]), H, slot.rejected);
  assert.equal(capped.status, "unresolved", "a rejected row is one of the three attempts");
  // Superseded rows are kept on the case for its history.
  assert.deepEqual(firstBad.cases[0].verify.rejected, [{ line: 3, superseded: true }]);
  assert.deepEqual(again.cases[0].verify.rejected, [{ line: 3, superseded: true }, { line: 5, superseded: false }]);

  // H4. A case id defined twice: every case with that id is invalid; each case's text is its own block.
  const dup = readE2e(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-1a · P2 · Another case with the same id\nFeature: F1 · Type: happy\nCovers: R1 (C4)\nTier: core · Depth: screen\nRun mode: phone\n")));
  const both = dup.cases.filter((c) => c.id === "TC-1a");
  assert.equal(both.length, 2);
  for (const c of both) assert.deepEqual([c.verify.status, c.verify.reason], ["invalid", "TC-1a is defined twice"]);
  assert.ok(caseText(dup, both[1]).startsWith("### TC-1a · P2 · Another case with the same id"));
  assert.ok(caseText(dup, both[0]).startsWith("### TC-1a · P0 · A saved note"));
  assert.notEqual(both[0].verify.hash, both[1].verify.hash);

  // A table row inside a fenced block is not a ledger row.
  const fenced = pv("```\n" + row("TC-1a", 1, "repair") + "\n" + badRow("TC-1b") + "\n```\n");
  assert.deepEqual([fenced.rows, fenced.problems, fenced.rejected], [[], [], []]);

  // statusOf.
  const r = (attempt, verdict, text = H) => ({ item: "x", attempt, verdict, by: "same", text, date: "d", reason: `why${attempt}`, line: 1 });
  const s = (rows, hash = H) => statusOf(rows, hash);
  assert.deepEqual(s([]), { status: "unverified", attempt: 0, by: null, reason: null, history: [] });
  assert.equal(s([r(1, "repair")]).status, "repair");
  assert.equal(s([r(1, "repair")], G).status, "stale");
  assert.equal(s([r(1, "approved")], G).status, "stale");
  assert.equal(s([r(1, "question")]).status, "question");
  assert.deepEqual([s([r(1, "repair"), r(2, "repair")]).status, s([r(1, "repair"), r(2, "repair")]).attempt], ["repair", 2]);
  assert.equal(s([r(1, "repair"), r(2, "repair"), r(3, "repair")]).status, "unresolved");
  assert.equal(s([r(1, "repair"), r(2, "repair"), r(3, "question")]).status, "unresolved", "three attempts beat question");
  assert.equal(s([r(1, "repair"), r(2, "repair"), r(3, "repair")], G).status, "stale", "stale beats unresolved");
  assert.equal(s([r(1, "repair"), r(2, "approved")]).status, "approved");
  assert.deepEqual([s([r(1, "repair"), r(2, "approved")]).attempt, s([r(1, "repair"), r(2, "approved")]).reason], [2, "why2"]);
  // After an approval the next cycle starts at 1: two repairs after it are not three attempts.
  const later = [r(1, "approved"), r(1, "repair"), r(2, "repair")];
  assert.deepEqual([s(later).status, s(later).attempt], ["repair", 2]);
  assert.equal(s([r(1, "repair"), r(2, "repair"), r(3, "repair"), r(0, "reopen")]).status, "repair", "reopen: counter reset, three old attempts do not count");
  assert.equal(s([r(1, "repair"), r(2, "repair"), r(3, "repair"), r(0, "reopen")]).attempt, 0);
  assert.equal(s([r(1, "repair"), r(2, "repair"), r(3, "repair"), r(0, "reopen"), r(1, "repair"), r(2, "repair")]).status, "repair");
  assert.equal(s([r(1, "repair"), r(2, "repair"), r(3, "repair"), r(0, "reopen"), r(1, "repair"), r(2, "repair"), r(3, "repair")]).status, "unresolved");
  assert.equal(s([r(1, "approved"), r(0, "reopen")]).status, "approved", "only reopen after an approval: the approval's text decides");
  assert.equal(s([r(1, "approved"), r(0, "reopen")], G).status, "stale");
  assert.equal(s([r(0, "reopen")]).status, "unverified", "a reopen with no earlier verdict");
  assert.deepEqual(s([r(1, "repair"), r(2, "repair"), r(3, "repair")]).history.map((x) => x.attempt), [1, 2, 3]);

  console.log("e2e-verify: ok");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
