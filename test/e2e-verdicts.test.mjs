/**
 * `codedroid-mcp e2e verdicts`: validates the verifier's JSON Lines and appends rows to VERIFY.md.
 *
 * Run: node test/e2e-verdicts.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { caseHash } from "../src/e2e-verify.js";
import { dueCases, recordVerdicts } from "../src/e2e-verdicts.js";

const fixture = new URL("./fixtures/e2e-sample", import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-verdicts-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-verdicts-home-"));
let n = 0;
const copy = (edit) => {
  const dir = path.join(root, `case${n++}`, "e2e");
  fs.mkdirSync(path.dirname(dir));
  fs.cpSync(fixture, dir, { recursive: true });
  edit?.(dir);
  return dir;
};
const NOW = new Date(2026, 10, 20, 12, 0, 0); // local 2026-11-20
const v = (id, verdict, reason = "R1: a reason", by = verdict === "reopen" ? "user" : "independent") => ({ id, verdict, by, reason });
// Each verdict object without a `text` gets the case's current code, as `e2e verdicts --due` hands it out.
const put = (dir, objs) => {
  const f = path.join(path.dirname(dir), `v${n++}.jsonl`);
  const m = readE2e(dir);
  const withText = (o) => ("text" in o || o.verdict === "reopen" ? o : { ...o, text: caseHash(m, o.id) ?? "0000000000000000" });
  fs.writeFileSync(f, objs.map((o) => (typeof o === "string" ? o : JSON.stringify(withText(o)))).join("\n") + "\n");
  return f;
};
const rec = (dir, objs) => recordVerdicts({ dir, file: put(dir, objs), now: NOW });
const verifyBytes = (dir) => fs.readFileSync(path.join(dir, "VERIFY.md"));
const status = (dir, id) => readE2e(dir).cases.find((c) => c.id === id).verify;
const e2eReport = (dir) => spawnSync(process.execPath, ["src/index.js", "e2e", "report", dir], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: home, USERPROFILE: home } });

try {
  // A valid file: rows appended, readE2e reads the statuses.
  let dir = copy();
  const before = verifyBytes(dir);
  let r = rec(dir, [v("TC-1c", "approved"), v("TC-3b", "repair"), "", v("TC-2a", "reopen")].filter((x, i) => i !== 3));
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.deepEqual(r.lines, ["TC-1c: approved (attempt 2 of 3)", "TC-3b: repair (attempt 1 of 3)", 'Run "e2e report" to update the pages.']);
  const after = verifyBytes(dir);
  assert.ok(after.subarray(0, before.length).equals(before), "existing rows untouched");
  const m = readE2e(dir);
  assert.deepEqual(m.problems, []);
  assert.equal(status(dir, "TC-1c").status, "approved");
  assert.equal(status(dir, "TC-3b").status, "repair");
  assert.equal(status(dir, "TC-3b").attempt, 1);
  const last = m.verify.rows.at(-1);
  assert.deepEqual([last.item, last.attempt, last.date, last.text], ["TC-3b", 1, "2026-11-20", caseHash(m, "TC-3b")]);
  assert.ok(after.toString().endsWith(" |\n"));

  // New file: header written; reopen of an unresolved case then approved is attempt 1 of a new cycle.
  dir = copy((d) => fs.rmSync(path.join(d, "VERIFY.md")));
  r = rec(dir, [v("TC-1a", "repair"), v("TC-1b", "question")]);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.ok(verifyBytes(dir).toString().startsWith("# Verifier verdicts\n\nWritten by `e2e verdicts`. Do not edit by hand.\n\n| Item | Attempt | Verdict | By | Text | Date | Reason |\n| --- | --- | --- | --- | --- | --- | --- |\n| TC-1a | 1 | repair |"));
  assert.equal(status(dir, "TC-1b").status, "question");

  // Three attempts, then a fourth is refused; reopen, then approved starts a new cycle.
  dir = copy();
  assert.equal(status(dir, "TC-3a").status, "unresolved");
  const snap = verifyBytes(dir);
  r = rec(dir, [v("TC-3a", "repair")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /v\d+\.jsonl:1: TC-3a has had three attempts: only "reopen", on the user's word, allows more$/);
  assert.ok(verifyBytes(dir).equals(snap));
  r = rec(dir, [v("TC-3a", "reopen", "the user allowed more")]);
  assert.deepEqual(r.lines, ["TC-3a: reopened", 'Run "e2e report" to update the pages.']);
  assert.ok(verifyBytes(dir).toString().includes("| TC-3a | 0 | reopen |"));
  r = rec(dir, [v("TC-3a", "approved")]);
  assert.equal(r.lines[0], "TC-3a: approved (attempt 1 of 3)");
  assert.equal(status(dir, "TC-3a").status, "approved");

  // Three attempts, then the text changes (stale): repair is still refused, reopen is allowed, approved starts a new cycle.
  dir = copy();
  fs.appendFileSync(path.join(dir, "TESTCASES.md"), "");
  { const p = path.join(dir, "TESTCASES.md"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("### TC-3a · P1 · Search narrows the list", "### TC-3a · P1 · Search narrows the list now")); }
  assert.equal(status(dir, "TC-3a").status, "stale");
  r = rec(dir, [v("TC-3a", "repair")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /TC-3a has had three attempts/);
  r = rec(dir, [v("TC-3a", "reopen", "the user allowed more")]);
  assert.equal(r.code, 0, r.lines.join("\n"));
  r = rec(dir, [v("TC-3a", "approved")]);
  assert.equal(r.lines[0], "TC-3a: approved (attempt 1 of 3)");
  assert.equal(status(dir, "TC-3a").status, "approved");
  assert.equal(readE2e(dir).verify.rows.at(-1).text, caseHash(readE2e(dir), "TC-3a"));
  // reopen on a case with two attempts is refused
  dir = copy();
  rec(dir, [v("TC-3b", "repair")]);
  rec(dir, [v("TC-3b", "repair")]);
  r = rec(dir, [v("TC-3b", "reopen")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /TC-3b is not unresolved: "reopen"/);

  // Refusals: each leaves VERIFY.md byte-identical and names the line.
  dir = copy();
  const bytes = verifyBytes(dir);
  const refuse = (objs, re, code = 2) => {
    const x = rec(dir, objs);
    assert.equal(x.code, code, x.lines.join("\n"));
    assert.match(x.lines.join("\n"), re);
    assert.ok(verifyBytes(dir).equals(bytes), "VERIFY.md unchanged");
    return x;
  };
  refuse(["{nope"], /:1: .*JSON/);
  refuse([{ id: "TC-1c", verdict: "repair", by: "same" }], /:1: .*missing.*reason/);
  refuse([{ ...v("TC-1c", "repair"), extra: 1 }], /:1: .*unexpected.*extra/);
  refuse([{ ...v("TC-1c", "repair"), reason: 5 }], /:1: .*reason.*string/);
  refuse(["[1]"], /:1: .*object/);
  refuse([v("TC-99", "repair")], /:1: TC-99 is not a current, judged case/);
  refuse([v("TC-1c", "maybe")], /:1: verdict must be approved, repair, question or reopen/);
  refuse([v("TC-1c", "repair", "r", "robot")], /:1: by must be independent or same/);
  refuse([v("TC-1c", "repair", "r", "user")], /:1: by "user" is only for "reopen"; a verdict's by is independent or same/);
  refuse([v("TC-3a", "reopen", "r", "independent")], /:1: "reopen" must have by "user": only the user allows more attempts/);
  refuse([v("TC-3a", "reopen", "r", "same")], /:1: "reopen" must have by "user"/);
  refuse([v("TC-1c", "repair", " \n ")], /:1: reason is empty/);
  refuse([v("TC-1c", "repair"), v("TC-1c", "approved")], /:2: TC-1c appears twice/);
  refuse([v("TC-1c", "reopen")], /:1: TC-1c is not unresolved: "reopen" is only for a case that used its three attempts/);
  const multi = refuse([v("TC-1c", "repair"), "{x", v("TC-99", "repair"), v("TC-3b", "repair")], /:2: .*\n.*:3: /);
  assert.equal(multi.lines.length, 2);
  assert.equal(recordVerdicts({ dir, file: path.join(root, "nope.jsonl"), now: NOW }).lines[0], `No such file: ${path.join(root, "nope.jsonl")}`);
  const empty = path.join(root, "empty.jsonl");
  fs.writeFileSync(empty, "\n\n");
  assert.deepEqual(recordVerdicts({ dir, file: empty, now: NOW }), { code: 2, lines: [`${empty} holds no verdicts`] });
  assert.equal(recordVerdicts({ dir: path.join(root, "nodir"), file: empty, now: NOW }).lines[0], `No such folder: ${path.join(root, "nodir")}`);

  // An approved case, then an unreadable row for it: invalid and a problem. A new verdict supersedes the row;
  // the approval never comes back.
  dir = copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-1a | x | approved | independent | 0123456789abcdef | 2026-11-14 | r |\n"));
  const badLine = verifyBytes(dir).toString().trimEnd().split("\n").length;
  let m2 = readE2e(dir);
  assert.equal(status(dir, "TC-1a").status, "invalid");
  assert.deepEqual(m2.problems.map((p) => [p.file, p.line]), [["VERIFY.md", badLine]]);
  assert.equal(e2eReport(dir).status, 1, "the unreadable row is a problem");
  r = rec(dir, [v("TC-1a", "repair")]);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.equal(r.lines[0], "TC-1a: repair (attempt 2 of 3)", "the approval closed the last cycle; the unreadable row took attempt 1 of the new one");
  m2 = readE2e(dir);
  assert.equal(status(dir, "TC-1a").status, "repair");
  assert.deepEqual(m2.problems, []);
  assert.deepEqual(m2.verify.superseded, [{ item: "TC-1a", line: badLine }]);
  assert.equal(e2eReport(dir).status, 0, "a superseded row is not a problem");
  // An unknown id's unreadable row is still a problem.
  dir = copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-0z | x | repair | independent | 0123456789abcdef | 2026-11-14 | r |\n"));
  assert.equal(readE2e(dir).problems.length, 1);
  assert.deepEqual(readE2e(dir).verify.superseded, []);
  // A case whose cycle holds three attempts stays capped while invalid: reopen is the way forward.
  dir = copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-3a | x | repair | independent | 0123456789abcdef | 2026-11-14 | r |\n"));
  assert.equal(status(dir, "TC-3a").status, "invalid");
  assert.match(rec(dir, [v("TC-3a", "repair")]).lines[0], /TC-3a has had three attempts/);
  assert.equal(rec(dir, [v("TC-3a", "reopen", "the user allowed more")]).code, 0);
  assert.equal(status(dir, "TC-3a").status, "invalid", "a reopen row supersedes nothing");
  assert.equal(rec(dir, [v("TC-3a", "approved")]).lines[0], "TC-3a: approved (attempt 1 of 3)");
  assert.equal(status(dir, "TC-3a").status, "approved");
  // Three repairs, the last row damaged: it still holds the third slot, so a fourth verdict is refused; reopen is the way.
  dir = copy((d) => { const p = path.join(d, "VERIFY.md"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("| TC-3a | 3 | repair | independent |", "| TC-3a | 3 | repair | robot |")); });
  assert.equal(status(dir, "TC-3a").status, "invalid");
  const capSnap = verifyBytes(dir);
  r = rec(dir, [v("TC-3a", "repair")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /TC-3a has had three attempts/);
  assert.ok(verifyBytes(dir).equals(capSnap));
  assert.equal(rec(dir, [v("TC-3a", "reopen", "the user allowed more")]).code, 0);
  assert.equal(rec(dir, [v("TC-3a", "repair")]).lines[0], "TC-3a: repair (attempt 1 of 3)");
  assert.equal(status(dir, "TC-3a").status, "repair");
  dir = copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-1c · P1 · duplicate\n"));
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.deepEqual(r, { code: 2, lines: ['the documents have problems: run "e2e report" and fix them first'] });
  dir = copy((d) => fs.writeFileSync(path.join(d, "VERIFY.md"), "just notes\n"));
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.deepEqual(r, { code: 2, lines: ["VERIFY.md has no verdict table: delete it or restore it"] });
  assert.equal(fs.readFileSync(path.join(dir, "VERIFY.md"), "utf8"), "just notes\n");

  // H1. A verdict is bound to the text it was judged on. The reviewer's repro: approve, weaken the case, record the
  // same file again: refused, and the case stays stale.
  dir = copy();
  const approveFile = put(dir, [v("TC-3b", "approved", "R4: an app that shows the full list is rejected.")]);
  assert.equal(recordVerdicts({ dir, file: approveFile, now: NOW }).code, 0);
  assert.equal(status(dir, "TC-3b").status, "approved");
  fs.appendFileSync(path.join(dir, "TESTCASES.md"), "Expected: anything at all.\n");
  assert.equal(status(dir, "TC-3b").status, "stale");
  let keep = verifyBytes(dir);
  r = recordVerdicts({ dir, file: approveFile, now: NOW });
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /:1: TC-3b changed since it was judged \(or the text code is wrong\): judge it again$/);
  assert.ok(verifyBytes(dir).equals(keep));
  assert.equal(status(dir, "TC-3b").status, "stale");
  // Judged on the current text: accepted, and the row carries that text.
  r = rec(dir, [v("TC-3b", "repair", "R4: Expected accepts any screen.")]);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.equal(readE2e(dir).verify.rows.at(-1).text, caseHash(readE2e(dir), "TC-3b"));
  // A wrong, malformed or missing text is refused.
  dir = copy();
  keep = verifyBytes(dir);
  for (const [text, re] of [["0123456789abcdef", /TC-1c changed since it was judged/], ["XYZ", /"text" must be 16 hex characters/], [undefined, /missing field "text"/], [5, /"text" must be a string/]]) {
    const o = { ...v("TC-1c", "repair"), text };
    if (text === undefined) delete o.text;
    r = recordVerdicts({ dir, file: put(dir, [JSON.stringify(o)]), now: NOW });
    assert.equal(r.code, 2, String(text));
    assert.match(r.lines.join("\n"), re);
    assert.ok(verifyBytes(dir).equals(keep));
  }
  // A reopen judges nothing: its text is not needed, and ignored when given.
  r = rec(dir, [{ ...v("TC-3a", "reopen", "the user allowed more"), text: "not a code" }]);
  assert.equal(r.code, 0, r.lines.join("\n"));
  // Recording the same file twice: the second time is refused, nothing appended.
  dir = copy();
  const twice = put(dir, [v("TC-1c", "repair", "R2: weak.\n"), v("TC-3b", "repair")]);
  assert.equal(recordVerdicts({ dir, file: twice, now: NOW }).code, 0);
  keep = verifyBytes(dir);
  r = recordVerdicts({ dir, file: twice, now: NOW });
  assert.deepEqual(r.lines, [`${twice}:1: TC-1c: this verdict is already recorded`, `${twice}:2: TC-3b: this verdict is already recorded`]);
  assert.ok(verifyBytes(dir).equals(keep));
  // ...but the same verdict with a new reason is a new attempt.
  assert.equal(rec(dir, [v("TC-1c", "repair", "R2: weaker.")]).code, 0);

  // --due: per feature, the cases a verifier judges next, each with its current code, in document order.
  const due = (d) => dueCases(readE2e(d));
  const at = (d, id) => `${id}@${caseHash(readE2e(d), id)}`;
  dir = copy();
  assert.deepEqual(due(dir), [`F1: ${at(dir, "TC-1c")}`, `F2: ${at(dir, "TC-3b")}`], "repair with attempts left and unverified; never approved, question or unresolved");
  fs.appendFileSync(path.join(dir, "TESTCASES.md"), "\n### TC-00 · P1 · Sign in\nFeature: all · Type: setup\nRun mode: phone\n\n### TC-9r · P1 · Gone\nRetired: removed\n");
  { const p = path.join(dir, "TESTCASES.md"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Tap \"New note\", type a title", "Tap \"New note\", type a short title")); }
  assert.deepEqual(due(dir), [`F1: ${at(dir, "TC-1a")} ${at(dir, "TC-1c")}`, `F2: ${at(dir, "TC-3b")}`], "an edited approved case is stale and due; setup and retired never");
  rec(dir, [v("TC-1a", "approved"), v("TC-3b", "approved")]);
  assert.deepEqual(due(dir), [`F1: ${at(dir, "TC-1c")}`], "approved: not due");
  rec(dir, [v("TC-1c", "repair", "R2: 2")]);
  assert.deepEqual(due(dir), [`F1: ${at(dir, "TC-1c")}`], "two attempts: still due");
  rec(dir, [v("TC-1c", "repair", "R2: 3")]);
  assert.deepEqual(due(dir), ["No case is due for judging."], "a third failed attempt waits for the user");
  rec(dir, [v("TC-3a", "reopen", "the user allowed more")]);
  assert.deepEqual(due(dir), [`F2: ${at(dir, "TC-3a")}`], "a reopened case is due");
  // A reopened case is due even when its status reads question (its third attempt was a question).
  dir = copy();
  rec(dir, [v("TC-1c", "repair", "R2: 2")]);
  rec(dir, [v("TC-1c", "question", "R2: which note opens?")]);
  assert.equal(status(dir, "TC-1c").status, "unresolved");
  assert.ok(!due(dir).join(" ").includes("TC-1c"));
  rec(dir, [v("TC-1c", "reopen", "the user answered")]);
  assert.equal(status(dir, "TC-1c").status, "question");
  assert.equal(due(dir)[0], `F1: ${at(dir, "TC-1c")}`);
  // A question as the third attempt: the user's answer goes into the PRD (stale, not due, capped); their reopen
  // lets it be judged again, and the next verdict is attempt 1 of a new cycle.
  dir = copy();
  rec(dir, [v("TC-1c", "repair", "R2: 2")]);
  assert.equal(rec(dir, [v("TC-1c", "question", "R2: should a deleted note open?")]).lines[0], "TC-1c: question (attempt 3 of 3)");
  { const p = path.join(dir, "PRD.md"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("- R2 · A tap on a note opens it with its text.", "- R2 · A tap on a note opens it with its text; a deleted note does not open.")); }
  assert.equal(status(dir, "TC-1c").status, "stale");
  assert.ok(!due(dir).join(" ").includes("TC-1c"));
  assert.match(rec(dir, [v("TC-1c", "repair", "R2: x")]).lines[0], /TC-1c has had three attempts/);
  assert.equal(rec(dir, [v("TC-1c", "reopen", "a deleted note does not open")]).code, 0);
  assert.equal(due(dir)[0], `F1: ${at(dir, "TC-1c")}`);
  assert.equal(rec(dir, [v("TC-1c", "approved", "R2: a deleted note that opens is rejected.")]).lines[0], "TC-1c: approved (attempt 1 of 3)");
  // A rejected reopen row (By independent) does not reset the cycle: it holds a slot like any rejected row.
  dir = copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), `| TC-3a | 0 | reopen | independent | ${"0".repeat(16)} | 2026-11-17 | not the user |\n`));
  assert.equal(status(dir, "TC-3a").status, "invalid");
  assert.ok(!due(dir).join(" ").includes("TC-3a"), "still capped: not due");
  keep = verifyBytes(dir);
  r = rec(dir, [v("TC-3a", "repair")]);
  assert.match(r.lines[0], /TC-3a has had three attempts/);
  assert.ok(verifyBytes(dir).equals(keep));
  // A stale case whose cycle used three attempts waits for the user too: the writer would refuse its verdict.
  dir = copy((d) => { const p = path.join(d, "TESTCASES.md"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Search narrows the list", "Search narrows the list fast")); });
  assert.equal(status(dir, "TC-3a").status, "stale");
  assert.ok(!due(dir).join(" ").includes("TC-3a"));
  // An invalid case with attempts left is due.
  dir = copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-1a | x | approved | independent | 0123456789abcdef | 2026-11-14 | r |\n"));
  assert.ok(due(dir)[0].startsWith(`F1: ${at(dir, "TC-1a")} `));

  // Exit 2 records nothing. A reason that is not well-formed Unicode is a fault.
  dir = copy();
  keep = verifyBytes(dir);
  r = rec(dir, [v("TC-3b", "repair", "R1 \ud800 x")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /:1: reason is not well-formed Unicode$/);
  assert.ok(verifyBytes(dir).equals(keep));
  // A VERIFY.md whose last line opens a code fence cannot take rows: refused before anything is appended.
  dir = copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "```\n"));
  keep = verifyBytes(dir);
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.deepEqual(r, { code: 2, lines: [`VERIFY.md line ${keep.toString().split("\n").length - 1} opens a code fence that is never closed: rows written after it could not be read`] });
  assert.ok(verifyBytes(dir).equals(keep));
  // The backstop: rows that do not read back (a date past 9999 is not YYYY-MM-DD) are taken out again.
  const far = new Date(10000, 0, 1, 12);
  dir = copy();
  keep = verifyBytes(dir);
  r = recordVerdicts({ dir, file: put(dir, [v("TC-3b", "repair"), v("TC-1c", "repair")]), now: far });
  assert.deepEqual(r, { code: 2, lines: ["TC-3b: VERIFY.md could not be read back after writing; nothing was recorded"] });
  assert.ok(verifyBytes(dir).equals(keep), "VERIFY.md is byte-identical");
  dir = copy((d) => { const p = path.join(d, "VERIFY.md"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").trimEnd()); });
  keep = verifyBytes(dir);
  assert.equal(recordVerdicts({ dir, file: put(dir, [v("TC-3b", "repair")]), now: far }).code, 2);
  assert.ok(verifyBytes(dir).equals(keep), "no final newline added either");
  dir = copy((d) => fs.rmSync(path.join(d, "VERIFY.md")));
  assert.equal(recordVerdicts({ dir, file: put(dir, [v("TC-3b", "repair")]), now: far }).code, 2);
  assert.ok(!fs.existsSync(path.join(dir, "VERIFY.md")), "a VERIFY.md this run created is removed");

  // A byte order mark at the start of the verdicts file is skipped.
  dir = copy();
  { const f = put(dir, [v("TC-3b", "repair")]); fs.writeFileSync(f, "\uFEFF" + fs.readFileSync(f, "utf8")); r = recordVerdicts({ dir, file: f, now: NOW }); }
  assert.equal(r.code, 0, r.lines.join("\n"));
  // An id with control characters is quoted in the fault line.
  r = rec(dir, [v("TC-\u001b[2Jx", "repair")]);
  assert.equal(r.code, 2);
  assert.ok(r.lines[0].endsWith(':1: "TC-\\u001b[2Jx" is not a current, judged case'), r.lines[0]);

  // A file without a final newline gets one first.
  dir = copy((d) => { const p = path.join(d, "VERIFY.md"); fs.writeFileSync(p, fs.readFileSync(p, "utf8").trimEnd()); });
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.equal(r.code, 0);
  assert.deepEqual(readE2e(dir).problems, []);

  // A reason with pipes, a line break and <script> round-trips.
  dir = copy();
  r = rec(dir, [v("TC-3b", "repair", "a | b\nc <script>alert(1)</script> \\| `x`")]);
  assert.equal(r.code, 0);
  assert.equal(status(dir, "TC-3b").reason, "a | b c <script>alert(1)</script> \\| `x`");

  // A symlinked VERIFY.md leading outside is refused and nothing is written through it.
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, "keep\n");
  dir = copy((d) => { fs.rmSync(path.join(d, "VERIFY.md")); fs.symlinkSync(outside, path.join(d, "VERIFY.md")); });
  r = rec(dir, [v("TC-3b", "repair")]);
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /^Refusing to write VERIFY\.md: it is a link or leads outside /);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");

  // The real binary: HOME stays empty; usage errors.
  dir = copy();
  const file = put(dir, [v("TC-3b", "repair")]);
  const run = (...args) => spawnSync(process.execPath, ["src/index.js", "e2e", ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: home, USERPROFILE: home } });
  let b = run("verdicts", file, dir);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, 'TC-3b: repair (attempt 1 of 3)\nRun "e2e report" to update the pages.\n');
  assert.deepEqual(fs.readdirSync(home), []);
  for (const args of [["verdicts"], ["verdicts", file, dir, "extra"], ["verdicts", "--due", dir, "extra"]]) {
    b = run(...args);
    assert.equal(b.status, 2);
    assert.equal(b.stderr, "Usage: codedroid-mcp e2e verdicts <file> [dir] | codedroid-mcp e2e verdicts --due [dir]\n");
  }
  // --due through the binary: writes nothing, exit 0; the documents' problems refuse it with exit 2.
  dir = copy();
  const dueBefore = fs.readdirSync(dir).sort();
  b = run("verdicts", "--due", dir);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, dueCases(readE2e(dir)).join("\n") + "\n");
  assert.match(b.stdout, /^F1: TC-1c@[0-9a-f]{16}\nF2: TC-3b@[0-9a-f]{16}\n$/);
  assert.deepEqual(fs.readdirSync(dir).sort(), dueBefore);
  b = spawnSync(process.execPath, [path.resolve("src/index.js"), "e2e", "verdicts", "--due"], { cwd: path.dirname(dir), encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(b.status, 0, "reads ./e2e");
  assert.match(b.stdout, /^F1: TC-1c@/);
  fs.appendFileSync(path.join(dir, "TESTCASES.md"), "\n### TC-1c · P1 · duplicate\n");
  b = run("verdicts", "--due", dir);
  assert.deepEqual([b.status, b.stdout], [2, 'the documents have problems: run "e2e report" and fix them first\n']);
  b = run("verdicts", "--due", path.join(root, "nodir"));
  assert.equal(b.status, 2);
  b = run("verdicts", path.join(root, "nope"), dir);
  assert.equal(b.status, 2);

  // Property: any reason survives the round trip as itself with line breaks folded to one space and the ends trimmed.
  const seed = Number(process.env.SEED ?? Date.now() % 1e9);
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const alphabet = ["|", "\\", "`", "<", ">", '"', "'", " ", "\t", "\n", "\r\n", "a", "Z", "7", "é", "ß", "日", "|", "\\"];
  try {
    for (let i = 0; i < 300; i++) {
      const input = Array.from({ length: 1 + Math.floor(rnd() * 24) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      const want = input.replace(/[\r\n]+/g, " ").trim();
      const d = copy((x) => fs.rmSync(path.join(x, "VERIFY.md")));
      const out = rec(d, [v("TC-3b", "repair", input)]);
      if (!want) { assert.equal(out.code, 2, JSON.stringify(input)); continue; }
      assert.equal(out.code, 0, `${JSON.stringify(input)}: ${out.lines}`);
      const mm = readE2e(d);
      assert.deepEqual(mm.problems, [], JSON.stringify(input));
      assert.equal(mm.cases.find((c) => c.id === "TC-3b").verify.reason, want, JSON.stringify(input));
    }
  } catch (e) {
    console.error(`property test failed with SEED=${seed}`);
    throw e;
  }
  console.log("e2e verdicts: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
