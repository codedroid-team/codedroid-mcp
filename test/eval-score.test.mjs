/**
 * The scorer, on a synthetic three-row key (no network, no third-party text).
 *
 * Run: node test/eval-score.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as scorer from "../eval/score.mjs";

const { LIMITS, caseIds, compare, main, parseJudge, score, spread, verdict } = scorer;

const SCORE = fileURLToPath(new URL("../eval/score.mjs", import.meta.url));
const EVAL = path.dirname(SCORE);
const temps = [];
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
};
const failed = [];
const test = (name, fn) => {
  try {
    fn();
  } catch (e) {
    failed.push(name);
    console.error(`FAIL ${name}: ${String(e.message).split("\n")[0]}`);
  }
};
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: "utf8", ...opts });
const noStack = (r) => assert.ok(!/\n\s+at /.test(r.stderr), `stack trace in stderr: ${r.stderr}`);
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const key = [1, 2, 3].map((n) => ({ id: `K-x-${n}`, file: "x.md", section: "s", title: `t${n}`, steps: "", expected: "" }));
const md = [
  "### TC-1a · P0 · First case",
  "### TC-2a · P1 · Second case · manual",
  "### TC-3a · P1 · Third case",
  "### TC-4a · P2 · Fourth case · task",
].join("\n");
const cases = caseIds(md);
const j = (n, verdict, tc_ids, extra = {}) => ({ key_id: `K-x-${n}`, verdict, tc_ids, kind: "happy", off_phone: false, note: "", ...extra });
const good = [j(1, "covered", ["TC-1a"]), j(2, "covered", ["TC-2a"]), j(3, "missed", [], { off_phone: true, kind: "failure" })];
const modesOf = (text) => [...caseIds(text)];
const throws = (judge, text, theCases = cases) =>
  assert.throws(
    () => score(key, judge, theCases),
    (e) => !(e instanceof TypeError) && e.message.includes(text),
    text,
  );

/** A run folder holding TESTCASES.md and judge.jsonl. */
function runDir(testcases, judgeRows) {
  const dir = tmpDir("eval-score-");
  fs.mkdirSync(path.join(dir, "e2e"));
  fs.writeFileSync(path.join(dir, "e2e", "TESTCASES.md"), testcases);
  fs.writeFileSync(path.join(dir, "judge.jsonl"), judgeRows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return dir;
}

try {
  test("counts each verdict into all rows, on-phone rows, files and kinds", () => {
    assert.deepEqual([...cases], [["TC-1a", "phone"], ["TC-2a", "manual"], ["TC-3a", "phone"], ["TC-4a", "task"]]);
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
    assert.equal(s.score, 0.5);
  });

  test("a task case is runnable, a manual and runnable pair is runnable, partly rows cite cases", () => {
    assert.equal(score(key, [j(1, "covered", ["TC-4a"]), j(2, "covered", ["TC-2a", "TC-1a"]), j(3, "partly", ["TC-3a"])], cases).covered_runnable, 2);
    assert.deepEqual(score(key, [j(1, "partly", ["TC-1a"]), j(2, "missed", []), j(3, "missed", [])], cases).unmatched_cases, ["TC-2a", "TC-3a", "TC-4a"]);
  });

  test("empty TESTCASES.md and no on-phone rows both score 0", () => {
    const none = score(key, key.map((_, i) => j(i + 1, "missed", [])), caseIds(""));
    assert.equal(none.covered_runnable, 0);
    assert.equal(none.score, 0);
    assert.equal(score(key, key.map((_, i) => j(i + 1, "missed", [], { off_phone: true })), cases).score, 0);
  });

  test("refuses a missing, repeated or unknown row, an unknown case and bad field values", () => {
    throws(good.slice(0, 2), "K-x-3");
    throws([...good, j(1, "missed", [])], "K-x-1");
    throws([...good, j(9, "missed", [])], "K-x-9");
    throws([j(1, "covered", ["TC-9z"]), good[1], good[2]], "TC-9z");
    throws([j(1, "partly", ["TC-9z"]), good[1], good[2]], "TC-9z");
    throws([j(1, "covered", []), good[1], good[2]], "K-x-1 is covered but cites no case");
    throws([j(1, "maybe", []), good[1], good[2]], "K-x-1");
    throws([j(1, "missed", [], { kind: "odd" }), good[1], good[2]], "K-x-1");
    throws([j(1, "missed", [], { off_phone: "false" }), good[1], good[2]], "K-x-1: off_phone must be true or false");
    throws([{ key_id: "K-x-1", verdict: "missed", tc_ids: [], kind: "happy" }, good[1], good[2]], "K-x-1: off_phone must be true or false");
  });

  test("tc_ids is an array of strings on every row, empty when missed, non-empty when covered or partly", () => {
    const bad = "K-x-1: tc_ids must be an array of strings";
    const { tc_ids, ...noIds } = j(1, "missed", []);
    throws([noIds, good[1], good[2]], bad);
    throws([{ ...noIds, verdict: "covered" }, good[1], good[2]], bad);
    throws([{ ...noIds, verdict: "partly" }, good[1], good[2]], bad);
    throws([j(1, "partly", null), good[1], good[2]], bad);
    throws([j(1, "covered", "TC-1a"), good[1], good[2]], bad);
    throws([j(1, "partly", ""), good[1], good[2]], bad);
    throws([j(1, "covered", {}), good[1], good[2]], bad);
    throws([j(1, "covered", [1]), good[1], good[2]], bad);
    throws([j(1, "missed", ["TC-1a"]), good[1], good[2]], "K-x-1 is missed but cites TC-1a");
    throws([j(1, "partly", []), good[1], good[2]], "K-x-1 is partly but cites no case");
  });

  test("note is a string on every row", () => {
    const { note, ...noNote } = j(1, "missed", []);
    throws([noNote, good[1], good[2]], "K-x-1: note must be a string");
    throws([j(1, "missed", [], { note: 5 }), good[1], good[2]], "K-x-1: note must be a string");
  });

  test("judge lines: blank lines skipped, bad JSON and non-objects named by line, BOM and CRLF read", () => {
    assert.equal(parseJudge('{"key_id":"a"}\n\n{"key_id":"b"}\n').length, 2);
    assert.throws(() => parseJudge('{"key_id":"a"}\nnot json'), (e) => e.message === "judge.jsonl line 2 is not valid JSON");
    for (const line of ["null", "[1]", '"x"', "5", "true"]) {
      assert.throws(() => parseJudge(`{"key_id":"a"}\n${line}\n`), (e) => e.message === "judge.jsonl line 2 must be an object", line);
    }
    assert.deepEqual(parseJudge('\uFEFF{"key_id":"a"}\r\n{"key_id":"b"}\r\n'), [{ key_id: "a" }, { key_id: "b" }]);
  });

  test("run mode from the heading: manual or task after the title, with or without a reason", () => {
    const heading = (tail) => modesOf(`### TC-1 · P1 · Share${tail}`)[0][1];
    for (const [tail, mode] of [
      [" · manual", "manual"],
      [" · Manual", "manual"],
      [" · manual (needs a second account)", "manual"],
      [" · manual: needs a second account", "manual"],
      [" · manual - needs a second account", "manual"],
      [" · manual — needs a second account", "manual"],
      [" · manual – needs a second account", "manual"],
      [" · manual(needs a wipe)", "manual"],
      [" · task", "task"],
      [" · TASK: runs the agent", "task"],
      [" · manual · slow", "phone"],
      [" (manual)", "phone"],
      [" · manually checked", "phone"],
      [" · tasks list", "phone"],
    ]) {
      assert.equal(heading(tail), mode, tail);
    }
    // the title is the segment after the priority: a title word never sets the mode
    assert.deepEqual(modesOf("### TC-6a · P1 · Manual upload of a file"), [["TC-6a", "phone"]]);
    assert.deepEqual(modesOf("### TC-6b · P1 · Task list sorting · task"), [["TC-6b", "task"]]);
    assert.deepEqual(modesOf("### TC-6c · Manual upload of a file"), [["TC-6c", "phone"]]);
  });

  test("run mode from the heading: only the last segment, and never the title", () => {
    for (const [heading, mode] of [
      ["### TC-1 · P0 · Upload · manual sync is off", "phone"],
      ["### TC-1 · P0 (smoke) · Manual upload of a photo", "phone"],
      ["### TC-1 · P0 (smoke) · Manual", "phone"],
      ["### TC-1 · p0 · Manual", "phone"],
      ["### TC-1 · Priority P0 · Task list opens", "phone"],
      ["### TC-1 · P0 · Manual upload", "phone"],
      ["### TC-1 · P0 · Task", "phone"],
      ["### TC-1 · P0 · t · manual", "manual"],
      ["### TC-1 · P0 · t · manual (needs a second account)", "manual"],
      ["### TC-1 · P0 · t · manual: why", "manual"],
      ["### TC-1 · P0 · t · manual - why", "manual"],
      ["### TC-1 · P0 · t · manual — why", "manual"],
      ["### TC-1 · P0 · t · task", "task"],
      ["### TC-1 · P0 (smoke) · t · task", "task"],
      ["### TC-1 · t · manual", "manual"],
      ["### TC-1 · t · task (runs the agent)", "task"],
      ["### TC-1 · Upload in P2 mode · manual", "manual"],
      ["### TC-1 · manual", "phone"],
      ["### TC-1 · P0 · t · manual · extra words", "phone"],
      ["### TC-1 · P0 · t · manual.", "phone"],
      ["### TC-12a · P0 · title", "phone"],
    ]) {
      assert.equal(modesOf(heading)[0][1], mode, heading);
    }
  });

  test("run mode from a body line: Run mode with bullets, bold, backticks or on a Feature line", () => {
    const body = (line) => modesOf(`### TC-1 · P1 · Share\n${line}\n`)[0][1];
    for (const [line, mode] of [
      ["Run mode: manual", "manual"],
      ["run mode: Task", "task"],
      ["- Run mode: manual", "manual"],
      ["* Run mode: manual", "manual"],
      ["**Run mode:** manual", "manual"],
      ["**Run mode**: manual", "manual"],
      ["Run mode: **manual**", "manual"],
      ["Run mode: `task`", "task"],
      ["- **Run mode:** `manual`", "manual"],
      ["Run mode: manual (needs a wipe)", "manual"],
      ["Feature: F3 · Type: happy · Run mode: manual", "manual"],
      ["Feature: F3 · Run mode: task", "task"],
      ["Run mode: phone", "phone"],
      ["Run mode: manually checked", "phone"],
    ]) {
      assert.equal(body(line), mode, line);
    }
  });

  test("run mode precedence: manual over task over phone, wherever written", () => {
    assert.deepEqual(
      modesOf(
        [
          "### TC-1 · P1 · A · manual (needs a second account)",
          "### TC-2 · P1 · B · Manual",
          "### TC-3 · P1 · C",
          "Run mode: manual",
          "### TC-4 · P1 · D",
          "run mode: Task",
          "### TC-5 · P1 · E · task",
          "Run mode: manual",
          "### TC-6 · P1 · F · manual",
          "Run mode: task",
          "### TC-7 · P1 · G",
          "Run mode: task",
          "Run mode: phone",
          "### TC-8 · P1 · H",
          "Run mode: manual",
          "Run mode: task",
        ].join("\n"),
      ),
      [["TC-1", "manual"], ["TC-2", "manual"], ["TC-3", "manual"], ["TC-4", "task"], ["TC-5", "manual"], ["TC-6", "manual"], ["TC-7", "task"], ["TC-8", "manual"]],
    );
  });

  test("a body line after a ### heading that is not a case belongs to no case", () => {
    assert.deepEqual(modesOf("### TC-1 · P0 · a\n### Notes\nRun mode: manual\nRetired: gone\n"), [["TC-1", "phone"]]);
  });

  test("any heading that is not a case heading ends the case", () => {
    for (const heading of ["# Test cases", "## Gaps", "## Retired cases", "#### Notes", "##### More", "###### Last", "## TC-9 · P0 · not a case"]) {
      const text = `### TC-1 · P0 · Upload a photo\nSteps:\n1. Tap Upload\n\n${heading}\n- Run mode: manual for sharing\nRetired: TC-3, removed\n`;
      assert.deepEqual(modesOf(text), [["TC-1", "phone"]], heading);
    }
    // a line starting with # but no space is not a heading
    assert.deepEqual(modesOf("### TC-1 · P0 · a\n#tag\nRun mode: manual\n"), [["TC-1", "manual"]]);
    // the next case after a section heading is still read
    assert.deepEqual(modesOf("### TC-1 · P0 · a\n## Area two\nRun mode: manual\n### TC-2 · P0 · b\nRun mode: task\n"), [["TC-1", "phone"], ["TC-2", "task"]]);
  });

  test("Run mode and Retired are read only at the start of a line", () => {
    assert.deepEqual(modesOf("### TC-1 · P0 · a\n1. Check that Run mode: manual is shown\nExpected: shows Retired: yes\n"), [["TC-1", "phone"]]);
  });

  test("TESTCASES.md with a BOM and CRLF line ends", () => {
    assert.deepEqual(modesOf("\uFEFF### TC-1 · P0 · a · manual\r\n### TC-2 · P0 · b\r\nRun mode: task\r\n"), [["TC-1", "manual"], ["TC-2", "task"]]);
  });

  test("a repeated case id is refused", () => {
    assert.throws(() => caseIds("### TC-1 · P0 · a\n### TC-1 · P0 · b"), (e) => e.message === "TESTCASES.md repeats TC-1");
    assert.throws(() => caseIds("### TC-1 · P0 · a\nRetired: 2026-01-01\n### TC-1 · P0 · b"), (e) => e.message === "TESTCASES.md repeats TC-1");
  });

  test("a retired case stays known but a verdict citing it is refused", () => {
    const retired = caseIds("### TC-1a · P0 · a\n### TC-2a · P0 · b\nRetired: 2026-01-01, feature removed\n### TC-3a · P0 · c · manual\n- **Retired:** replaced by TC-1a\n");
    assert.deepEqual([...retired], [["TC-1a", "phone"], ["TC-2a", "retired"], ["TC-3a", "retired"]]);
    throws([j(1, "covered", ["TC-2a"]), j(2, "missed", []), j(3, "missed", [])], "K-x-1 cites TC-2a, which is retired", retired);
    throws([j(1, "partly", ["TC-1a", "TC-3a"]), j(2, "missed", []), j(3, "missed", [])], "K-x-1 cites TC-3a, which is retired", retired);
    assert.deepEqual(score(key, [j(1, "covered", ["TC-1a"]), j(2, "missed", []), j(3, "missed", [])], retired).cases, { phone: 1, task: 0, manual: 0, retired: 2 });
  });

  test("retired cases are not listed as cases no key row cites", () => {
    const retired = caseIds("### TC-1a · P0 · a\n### TC-2a · P0 · b\nRetired: 2026-01-01\n### TC-3a · P0 · c\n");
    assert.deepEqual(score(key, [j(1, "covered", ["TC-1a"]), j(2, "missed", []), j(3, "missed", [])], retired).unmatched_cases, ["TC-3a"]);
  });

  test("Cases read counts phone, task, manual and retired each in its place", () => {
    const text = "### TC-1 · P0 · a\n### TC-2 · P0 · b · task\n### TC-3 · P0 · c · manual\n### TC-4 · P0 · d · manual\n### TC-5 · P0 · e · manual\n### TC-6 · P0 · f\nRetired: x\n### TC-7 · P0 · g\nRetired: y\n### TC-8 · P0 · h\nRetired: z\n### TC-9 · P0 · i\nRetired: w\n";
    const dir = runDir(text, [j(1, "covered", ["TC-1"]), j(2, "missed", []), j(3, "missed", [])]);
    main(dir, { qaSha: "a".repeat(40), rows: key });
    assert.ok(fs.readFileSync(path.join(dir, "SCORE.md"), "utf8").includes("Cases read: 1 phone, 1 task, 3 manual, 4 retired"));
  });

  test("main writes summary.json and SCORE.md with case counts, inputs and every table", () => {
    const dir = runDir(md, good);
    main(dir, { qaSha: "a".repeat(40), rows: key });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["SCORE.md", "e2e", "judge.jsonl", "summary.json"]);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
    assert.equal(summary.total, 3);
    assert.equal(summary.covered_runnable, 1);
    assert.equal(summary.on_phone.total, 2);
    assert.deepEqual(summary.unmatched_cases, ["TC-3a", "TC-4a"]);
    assert.deepEqual(summary.cases, { phone: 2, task: 1, manual: 1, retired: 0 });
    assert.deepEqual(summary.inputs, {
      qaSha: "a".repeat(40),
      judge_sha256: sha256(path.join(dir, "judge.jsonl")),
      testcases_sha256: sha256(path.join(dir, "e2e", "TESTCASES.md")),
    });
    const text = fs.readFileSync(path.join(dir, "SCORE.md"), "utf8");
    assert.ok(text.includes("On-phone score: 50.0% (1 of 2"));
    assert.ok(text.includes("Cases read: 2 phone, 1 task, 1 manual, 0 retired"));
    assert.ok(text.includes(LIMITS));
    assert.ok(text.includes("Limits: the judge is a model, so its verdicts are checked by hand on a sample; the authoring model may have seen this app's public test plans in training; one app is one data point."));
    assert.ok(text.includes("| all | 1 | 1 | 0 | 1 | 3 |"));
    assert.ok(text.includes("| on phone | 1 | 1 | 0 | 0 | 2 |"));
    assert.ok(text.includes("| x.md | 1 | 1 | 0 | 1 | 3 |"));
    const byKind = text.slice(text.indexOf("## By kind"), text.indexOf("## Cases no key row cites"));
    assert.ok(byKind.includes("| happy | 1 | 1 | 0 | 0 | 2 |"), byKind);
    assert.ok(byKind.includes("| failure | 0 | 0 | 0 | 1 | 1 |"), byKind);
    assert.ok(!byKind.includes("x.md"), byKind);
  });

  test("a refused rescore leaves no summary.json or SCORE.md behind", () => {
    const dir = runDir(md, good);
    const scored = () => ["summary.json", "SCORE.md"].filter((f) => fs.existsSync(path.join(dir, f)));
    main(dir, { qaSha: "a".repeat(40), rows: key });
    assert.deepEqual(scored(), ["summary.json", "SCORE.md"]);
    fs.writeFileSync(path.join(dir, "judge.jsonl"), JSON.stringify(j(1, "bogus", [])) + "\n");
    assert.throws(() => main(dir, { qaSha: "a".repeat(40), rows: key }), /bad verdict/);
    assert.deepEqual(scored(), []);
    fs.writeFileSync(path.join(dir, "judge.jsonl"), good.map((r) => JSON.stringify(r)).join("\n"));
    main(dir, { qaSha: "a".repeat(40), rows: key });
    fs.writeFileSync(path.join(dir, "e2e", "TESTCASES.md"), md + "\n### TC-1a · P0 · again\n");
    assert.throws(() => main(dir, { qaSha: "a".repeat(40), rows: key }), /repeats TC-1a/);
    assert.deepEqual(scored(), []);
    fs.writeFileSync(path.join(dir, "e2e", "TESTCASES.md"), md);
    main(dir, { qaSha: "a".repeat(40), rows: key });
    fs.rmSync(path.join(dir, "judge.jsonl"));
    assert.throws(() => main(dir, { qaSha: "a".repeat(40), rows: key }), /judge\.jsonl/);
    assert.deepEqual(scored(), []);
  });

  test("spread is the absolute difference; verdict: a change no larger than the spread is no change", () => {
    const s = score(key, good, cases);
    const none = score(key, key.map((_, i) => j(i + 1, "missed", [])), caseIds(""));
    assert.equal(spread(s, none), 0.5);
    assert.equal(spread(none, s), 0.5);
    assert.equal(verdict(0.3, 0.04, 0.33), "no change");
    assert.equal(verdict(0.3, 0.04, 0.4), "up");
    assert.equal(verdict(0.3, 0.04, 0.2), "down");
    assert.equal(verdict(0.5, 0.25, 0.75), "no change");
    assert.equal(verdict(0.5, 0.25, 0.25), "no change");
    // equal counts, unequal floats: 7/50 - 1/50 is 0.12000000000000001, 6/50 is 0.12
    assert.equal(verdict(1 / 50, 6 / 50, 7 / 50), "no change");
    // the float tolerance is part of "no larger than": a change of exactly 1e-9 over a zero spread is no change
    assert.equal(verdict(0, 0, 1e-9), "no change");
    assert.equal(verdict(0, 0, 2e-9), "up");
    assert.equal(verdict(50 / 300, 5 / 300, 55 / 300), "no change");
    assert.equal(verdict(50 / 300, 5 / 300, 56 / 300), "up");
    assert.equal(verdict(55 / 300, 5 / 300, 50 / 300), "no change");
    assert.equal(verdict(56 / 300, 5 / 300, 50 / 300), "down");
  });

  /** A run folder holding only a summary.json with these on-phone counts. */
  const summaryDir = (covered, total) => {
    const dir = tmpDir("eval-cmp-");
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ score: covered / total, on_phone: { covered_runnable: covered, total } }));
    return dir;
  };

  test("compare reads three summaries: baselines, spread, mean, next and the verdict", () => {
    const a = summaryDir(30, 100);
    const b = summaryDir(32, 100);
    const r = compare(a, b, summaryDir(34, 100));
    assert.equal(r.a, 0.3);
    assert.equal(r.b, 0.32);
    assert.ok(Math.abs(r.spread - 0.02) < 1e-12);
    assert.ok(Math.abs(r.base - 0.31) < 1e-12);
    assert.equal(r.next, 0.34);
    assert.equal(r.verdict, "up");
    assert.equal(compare(a, b, summaryDir(33, 100)).verdict, "no change");
    assert.equal(compare(b, a, summaryDir(29, 100)).verdict, "no change");
    assert.equal(compare(a, b, summaryDir(28, 100)).verdict, "down");
  });

  test("compare CLI prints each number and the verdict; usage exits 2, a missing or unreadable summary exits 1", () => {
    const a = summaryDir(30, 100);
    const b = summaryDir(32, 100);
    const ok = node([SCORE, "compare", a, b, summaryDir(40, 100)]);
    assert.equal(ok.status, 0, ok.stderr);
    for (const s of ["30.0%", "32.0%", "2.0 points", "31.0%", "40.0%", "up"]) assert.ok(ok.stdout.includes(s), `${s} in ${ok.stdout}`);
    assert.ok(node([SCORE, "compare", a, b, summaryDir(32, 100)]).stdout.includes("no change"));
    assert.ok(node([SCORE, "compare", a, b, summaryDir(20, 100)]).stdout.includes("down"));

    for (const args of [[a, b], [a, b, summaryDir(40, 100), summaryDir(40, 100)], []]) {
      const usage = node([SCORE, "compare", ...args]);
      assert.equal(usage.status, 2, `${args.length} folders`);
      assert.ok(usage.stderr.includes("usage"), usage.stderr);
    }
    const missing = node([SCORE, "compare", a, b, tmpDir("eval-cmp-")]);
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.startsWith("score.mjs: ") && missing.stderr.includes("summary.json"), missing.stderr);
    noStack(missing);
    const garbled = tmpDir("eval-cmp-");
    fs.writeFileSync(path.join(garbled, "summary.json"), "{not json");
    const unreadable = node([SCORE, "compare", a, b, garbled]);
    assert.equal(unreadable.status, 1);
    assert.ok(unreadable.stderr.startsWith("score.mjs: "), unreadable.stderr);
    noStack(unreadable);
    fs.writeFileSync(path.join(garbled, "summary.json"), "{}");
    const empty = node([SCORE, "compare", a, b, garbled]);
    assert.equal(empty.status, 1);
    noStack(empty);
    for (const on_phone of [{ covered_runnable: 3 }, { covered_runnable: 3, total: "10" }, { total: 10 }, { covered_runnable: null, total: 10 }]) {
      fs.writeFileSync(path.join(garbled, "summary.json"), JSON.stringify({ on_phone }));
      const r = node([SCORE, "compare", a, b, garbled]);
      assert.equal(r.status, 1, JSON.stringify(on_phone));
      assert.ok(r.stderr.includes("has no on-phone counts"), r.stderr);
    }
  });

  test("CLI: usage exits 2, a refusal exits 1 with one line and no stack trace", () => {
    for (const args of [[], ["one", "two"]]) {
      const r = node([SCORE, ...args]);
      assert.equal(r.status, 2, args.join(" "));
      assert.ok(r.stderr.includes("usage"), r.stderr);
    }
    const dir = runDir(md, [j(1, "bogus", [])]);
    const r = node([SCORE, dir]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.startsWith("score.mjs: "), r.stderr);
    noStack(r);
  });

  test("CLI: a missing key.json says to fetch it", () => {
    const copy = tmpDir("eval-nokey-");
    for (const f of ["score.mjs", "key.mjs", "config.json"]) fs.copyFileSync(path.join(EVAL, f), path.join(copy, f));
    const r = node([path.join(copy, "score.mjs"), runDir(md, good)]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("run: node eval/key.mjs fetch"), r.stderr);
    noStack(r);
  });

  test("CLI: a symlinked score.mjs still runs", () => {
    const t = tmpDir("eval-link-");
    const link = path.join(t, "score-link.mjs");
    fs.symlinkSync(SCORE, link);
    fs.mkdirSync(path.join(t, "run"));
    const r = node([link, path.join(t, "run")]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("TESTCASES.md"), r.stderr);
  });

  test("importing score.mjs when argv[1] is not a file does not throw", () => {
    const r = node(["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../eval/score.mjs", import.meta.url).href)})`, "not-a-file"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });
} finally {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
}

if (failed.length) {
  console.error(`eval-score: ${failed.length} failed`);
  process.exit(1);
}
console.log("eval-score ok");
