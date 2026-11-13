/**
 * The scorer, on a synthetic three-row key (no network, no third-party text).
 *
 * Run: node test/eval-score.test.mjs
 */
import assert from "node:assert/strict";
import { caseIds, parseJudge, score, spread, verdict } from "../eval/score.mjs";

const key = [1, 2, 3].map((n) => ({ id: `K-x-${n}`, file: "x.md", section: "s", title: `t${n}`, steps: "", expected: "" }));
const md = [
  "### TC-1a · P0 · First case",
  "### TC-2a · P1 · Second case · manual",
  "### TC-3a · P1 · Third case",
  "### TC-4a · P2 · Fourth case · task",
].join("\n");
const cases = caseIds(md);
assert.deepEqual([...cases], [["TC-1a", "phone"], ["TC-2a", "manual"], ["TC-3a", "phone"], ["TC-4a", "task"]]);

const j = (n, verdict, tc_ids, extra = {}) => ({ key_id: `K-x-${n}`, verdict, tc_ids, kind: "happy", off_phone: false, note: "", ...extra });
const good = [j(1, "covered", ["TC-1a"]), j(2, "covered", ["TC-2a"]), j(3, "missed", [], { off_phone: true, kind: "failure" })];

const s = score(key, good, cases);
assert.equal(s.total, 3);
assert.equal(s.covered_runnable, 1);
assert.equal(s.covered_manual_only, 1);
assert.equal(s.missed, 1);
assert.equal(s.on_phone.total, 2);
assert.equal(s.on_phone.covered_runnable, 1);
assert.deepEqual(s.unmatched_cases, ["TC-3a", "TC-4a"]);
assert.equal(s.by_file["x.md"].total, 3);
assert.equal(s.by_kind.failure.missed, 1);
assert.equal(s.by_kind.happy.total, 2);

// a task case counts as runnable; a manual+runnable pair is runnable
assert.equal(score(key, [j(1, "covered", ["TC-4a"]), j(2, "covered", ["TC-2a", "TC-1a"]), j(3, "partly", ["TC-3a"])], cases).covered_runnable, 2);
// partly rows cite cases too
assert.deepEqual(score(key, [j(1, "partly", ["TC-1a"]), j(2, "missed", []), j(3, "missed", [])], cases).unmatched_cases, ["TC-2a", "TC-3a", "TC-4a"]);

const throws = (judge, text) => assert.throws(() => score(key, judge, cases), (e) => e.message.includes(text), text);
throws(good.slice(0, 2), "K-x-3");
throws([...good, j(1, "missed", [])], "K-x-1");
throws([...good, j(9, "missed", [])], "K-x-9");
throws([j(1, "covered", ["TC-9z"]), good[1], good[2]], "TC-9z");
throws([j(1, "partly", ["TC-9z"]), good[1], good[2]], "TC-9z");
throws([j(1, "covered", []), good[1], good[2]], "K-x-1");
throws([j(1, "maybe", []), good[1], good[2]], "K-x-1");
throws([j(1, "missed", [], { kind: "odd" }), good[1], good[2]], "K-x-1");

// empty TESTCASES.md, all missed: score 0, and on_phone.total 0 scores 0 too
const none = score(key, key.map((_, i) => j(i + 1, "missed", [])), caseIds(""));
assert.equal(none.covered_runnable, 0);
assert.equal(none.score, 0);
assert.equal(score(key, key.map((_, i) => j(i + 1, "missed", [], { off_phone: true })), cases).score, 0);
assert.equal(s.score, 0.5);

// spread and verdict
assert.equal(spread(s, none), 0.5);
assert.equal(verdict(0.3, 0.04, 0.33), "no change");
assert.equal(verdict(0.3, 0.04, 0.4), "up");
assert.equal(verdict(0.3, 0.04, 0.2), "down");

// judge parsing names the line
assert.equal(parseJudge('{"key_id":"a"}\n\n{"key_id":"b"}\n').length, 2);
assert.throws(() => parseJudge('{"key_id":"a"}\nnot json'), (e) => e.message.includes("line 2"));

console.log("eval-score ok");
