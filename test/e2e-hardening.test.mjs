/**
 * Final-review fixes for the e2e reader: heading levels, report choice, links that leave the folder,
 * paths in quality.json, malformed Fails items, retired items and the smaller format rules.
 *
 * Run: node test/e2e-hardening.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { quality, qualityJson, qualityMd } from "../src/e2e-quality.js";
import { renderPages, stalePages } from "../src/e2e-html.js";

const INV = `# Inv

## S1 · A · "Main"
| Id | Control | Does | Source | States | Seen |
| --- | --- | --- | --- | --- | --- |
| C1 | b1 | d | s | | yes |
| C2 | b2 | d | s | | yes |
| C10 | b10 | d | s | | yes |
`;
const PRD = `# P

### F1 · One · P0
- R1 · first
  Caps: C1
  Proof: screen
  Fails:
  - R1.f1 · f one
- R10 · tenth
  Caps: C10
  Proof: screen
  Fails: none in source
`;
const CUJ = `# C

## F1 · One
### CUJ-1 · j · P0 · phone
Proves: R1
`;
const TC = `# T

### TC-1a · P0 · a
Feature: F1 · Type: happy
Covers: R1
Tier: deep · Depth: screen
Run mode: phone
`;
const BASE = { "INVENTORY.md": INV, "PRD.md": PRD, "CUJs.md": CUJ, "TESTCASES.md": TC };
const REP = (rows) => `# R\n\n| Case | Result | Notes |\n| --- | --- | --- |\n${rows}\n`;

const tmps = [];
const mk = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hard-"));
  tmps.push(d);
  for (const [k, v] of Object.entries({ ...BASE, ...files })) {
    if (v === null) continue;
    fs.mkdirSync(path.dirname(path.join(d, k)), { recursive: true });
    fs.writeFileSync(path.join(d, k), v);
  }
  return d;
};
const probs = (d) => readE2e(d).problems.map((p) => `${p.file}:${p.line} ${p.message}`);
const model = (files) => readE2e(mk(files));
const all = (d) => {
  const m = readE2e(d);
  const q = quality(m);
  return { m, q, text: [qualityMd(q, m), qualityJson(q, m, new Date(0)), ...Object.values(renderPages(m, q))].join("\n") };
};
const CASE_FORM = 'case heading is not readable: use "### TC-<id> · <priority> · <title>"';
const nextCase = (h, id = "TC-1b") => `\n${h} ${id} · P0 · second\nFeature: F1 · Type: happy\nCovers: R10\nTier: core · Depth: screen\nRun mode: manual\n`;

try {
  // G1: a heading at any level ends the block; an item heading at the wrong level is a problem.
  for (const h of ["##", "####"]) {
    const m = model({ "TESTCASES.md": TC + nextCase(h) });
    assert.deepEqual(m.cases.map((c) => [c.id, c.covers.map((e) => e.ref), c.mode]), [["TC-1a", ["R1"], "phone"]], `${h} case`);
    assert.deepEqual(m.problems.map((p) => p.message), [CASE_FORM], `${h} case problem`);
  }
  let m = model({ "PRD.md": PRD + "\n#### F2 · Two · P1\n- R20 · twenty\n  Caps: C2\n  Proof: screen\n  Fails: none in source\n" });
  assert.deepEqual(m.features.map((f) => f.id), ["F1"]);
  assert.deepEqual(m.problems.map((p) => p.message), ['feature heading is not readable: use "### F<n> · <name> · <priority>"', "R20 is under no feature"]);
  assert.deepEqual(model({ "PRD.md": PRD + "\n#### F2\n" }).problems.map((p) => p.message), ['feature heading is not readable: use "### F<n> · <name> · <priority>"']);
  m = model({ "CUJs.md": CUJ + "\n#### CUJ-2 · two · P0 · phone\nProves: R10\n" });
  assert.deepEqual(m.cujs.map((j) => [j.id, j.proves]), [["CUJ-1", ["R1"]]]);
  assert.deepEqual(m.problems.map((p) => p.message), ['CUJ heading is not readable: use "### CUJ-<n> · <title> · <priority> · <run mode>"']);
  assert.deepEqual(model({ "INVENTORY.md": INV + '\n### S2 · B · "Other"\n' }).problems.map((p) => p.message), ['screen heading is not readable: use "## S<n> · <source> · "<title>""']);
  assert.deepEqual(probs(mk({ "CUJs.md": CUJ + "\n## F2 · Two\n" })), [], "a CUJ feature group at ## is fine");
  assert.deepEqual(probs(mk({ "TESTCASES.md": TC + "\n```\n#### TC-1b · P0 · in a fence\n```\n" })), [], "headings in a fence are ignored");

  // G5: every list item under Fails: is a failure line.
  const f5 = probs(mk({ "PRD.md": PRD.replace("  - R1.f1 · f one", "  - R1.f1 · f one\n  - R1.f2: colon\n  * R1.f3 · star\n  - text with no id") }));
  assert.deepEqual(f5.map((x) => x.replace(/^\S+ /, "")), Array(3).fill('failure line is not readable: use "- R<n>.f<m> · <text>"'));
  // G6: a failure id starts with its own requirement's id.
  m = model({ "PRD.md": PRD.replace("  - R1.f1 · f one", "  - R10.f1 · wrong parent"), "TESTCASES.md": TC.replace("Covers: R1", "Covers: R1, R10.f1") });
  assert.deepEqual(m.requirements[0].fails, []);
  assert.ok(m.problems.some((p) => p.message === "R10.f1 is under R1: a failure id starts with its requirement's id"), JSON.stringify(m.problems));
  assert.deepEqual(m.problems.filter((p) => /not defined/.test(p.message)).map((p) => p.message), ["R10.f1 is referenced but not defined"]);
  assert.ok(!quality(m).capabilities.with_case || quality(m).capabilities.with_case === 1, "R10.f1 reaches no capability of R10");
  // G7: Feature: is required, setup included.
  assert.deepEqual(probs(mk({ "TESTCASES.md": TC.replace("Feature: F1 · Type: happy\n", "") })), ["TESTCASES.md:3 TC-1a has no Feature: line"]);
  assert.deepEqual(probs(mk({ "TESTCASES.md": TC + "\n### TC-00 · P0 · setup\nFeature: all · Type: setup\nRun mode: phone\n" })), []);
  // G9: a byte-order mark does not hide the first line.
  m = model({ "INVENTORY.md": "﻿" + INV.replace("# Inv\n\n", ""), "PRD.md": "﻿" + PRD.replace("# P\n\n", ""), "TESTCASES.md": "﻿" + TC.replace("# T\n\n", "") });
  assert.deepEqual(m.problems, []);
  assert.deepEqual([m.screens.length, m.features.length, m.cases.length], [1, 1, 1]);
  // G11: Gap and Non-goal lines in the wrong place are problems; * is a bullet.
  const gap = (line) => probs(mk({ "TESTCASES.md": TC + line }));
  assert.deepEqual(gap("\n  - Gap: R10 · indented\n"), ["TESTCASES.md:9 Gap line must start at the beginning of the line"]);
  assert.deepEqual(gap("\n  * Gap: R10 · indented\n"), ["TESTCASES.md:9 Gap line must start at the beginning of the line"]);
  assert.deepEqual(gap("\n* Gap: R10 · star\n"), []);
  assert.deepEqual(gap("\n```\n  - Gap: R10 · fenced\n```\n"), []);
  assert.equal(model({ "TESTCASES.md": TC + "\n* Gap: R10 · star\n" }).gaps.length, 1);
  const ng = (prd) => probs(mk({ "PRD.md": prd }));
  assert.deepEqual(ng(PRD.replace("- R10 · tenth", "  - Non-goal: C2 · indented\n- R10 · tenth")), ["PRD.md:9 Non-goal line must start at the beginning of the line"]);
  assert.deepEqual(ng(PRD + "\n* Non-goal: C2 · star\n"), []);
  assert.equal(model({ "PRD.md": PRD + "\n* Non-goal: C2 · star\n" }).nonGoals.length, 1);
  assert.deepEqual(ng(PRD.replace("  - R1.f1 · f one", "  - R1.f1 · f one\n  - Non-goal: C2 · indented")).length, 1, "one problem, not also an unreadable failure");

  // G8: retired cases and journeys.
  const RET = "Retired: 2026-11-13 - feature removed\n";
  const retTc = `\n### TC-2a · P1 · gone\n${RET}Feature: F9\nCovers: R99 (C99)\nTier: wrong\nRun mode: phone\n`;
  const retCuj = `\n### CUJ-2 · gone · P1 · phone\n${RET}Proves: R99\n`;
  const rd = mk({ "TESTCASES.md": TC + retTc, "CUJs.md": CUJ + retCuj, "reports/2026-11-12/REPORT.md": REP("| TC-1a | pass | |\n| TC-2a | fail | gone |") });
  assert.deepEqual(probs(rd).filter((x) => !/Tier must be/.test(x)), []);
  m = readE2e(rd);
  assert.equal(m.cases.find((c) => c.id === "TC-2a").retired, "2026-11-13 - feature removed");
  assert.equal(m.cases.find((c) => c.id === "TC-1a").retired, null);
  const q = quality(m);
  assert.deepEqual([q.cases.total, q.cases.retired, q.cujs.total, q.cujs.retired], [1, 1, 1, 1]);
  assert.deepEqual(q.by_cuj.map((j) => j.id), ["CUJ-1"]);
  assert.deepEqual(m.results.byCase, { "TC-1a": "pass" }, "a report row for a retired case is ignored");
  assert.equal(q.cases.by_tier.core + q.cases.by_tier.deep + q.cases.by_tier.smoke + q.cases.by_tier.edge, 1);
  assert.ok(probs(mk({ "TESTCASES.md": TC + retTc.replace("Retired: 2026-11-13 - feature removed", "Retired:") })).includes("TESTCASES.md:10 TC-2a Retired: has no reason"));
  assert.ok(probs(mk({ "CUJs.md": CUJ + retCuj.replace("Retired: 2026-11-13 - feature removed", "Retired:") })).includes("CUJs.md:8 CUJ-2 Retired: has no reason"));
  assert.ok(probs(mk({ "TESTCASES.md": TC + retTc.replace("TC-2a", "TC-1a") })).some((x) => /TC-1a is defined twice/.test(x)), "a retired id stays taken");
  // A retired case covering a live requirement does not count; the requirement is open again.
  const cover = mk({ "TESTCASES.md": TC.replace("Run mode: phone", "Run mode: phone\n" + RET) });
  assert.deepEqual(quality(readE2e(cover)).capabilities.with_case, 0);
  assert.ok(quality(readE2e(cover)).open.some((o) => o.ref === "R1"));
  const retPage = renderPages(readE2e(rd), q);
  assert.ok(/Retired/.test(retPage["TESTCASES.html"]) && retPage["TESTCASES.html"].includes("feature removed"), "retired case on its page with the reason");
  assert.ok(/Retired/.test(retPage["CUJs.html"]) && retPage["CUJs.html"].includes("feature removed"));

  // G10: a case belongs to the journey with its number, with or without letters.
  const by = (id) => quality(model({ "TESTCASES.md": TC.replace("TC-1a", id) })).by_cuj.map((j) => j.cases);
  assert.deepEqual(by("TC-1"), [["TC-1"]]);
  assert.deepEqual(by("TC-01b"), [["TC-01b"]]);
  assert.deepEqual(by("TC-10"), [[]]);
  assert.deepEqual(quality(model({ "CUJs.md": CUJ + "\n### CUJ-10 · ten · P0 · phone\nProves: R10\n", "TESTCASES.md": TC.replace("TC-1a", "TC-10") })).by_cuj.map((j) => j.cases), [[], ["TC-10"]]);

  // G2: the report used is the newest folder named exactly YYYY-MM-DD.
  const folders = (names) => Object.fromEntries(names.map(([n, row]) => [`reports/${n}/REPORT.md`, REP(row)]));
  const pass = "| TC-1a | pass | |", fail = "| TC-1a | fail | |";
  m = model(folders([["2026-11-12", pass], ["2026-11-12-bug-TC-1a", fail], ["2026-11-13-smoke", fail], ["2026-11-12-maintain", fail]]));
  assert.equal(m.results.report, "reports/2026-11-12/REPORT.md");
  assert.deepEqual(m.results.byCase, { "TC-1a": "pass" });
  assert.deepEqual(m.problems, []);
  m = model(folders([["2026-11-9", fail], ["2026-11-12", pass]]));
  assert.equal(m.results.report, "reports/2026-11-12/REPORT.md");
  assert.deepEqual(m.problems.map((p) => p.message), ['report folder "2026-11-9" must be named YYYY-MM-DD']);
  m = model(folders([["2026-11-9", fail]]));
  assert.equal(m.results.report, null, "an unpadded date is not used");
  assert.equal(model(folders([["2026-11-9", fail], ["2026-11-9-smoke", fail]])).results.report, "reports/2026-11-9-smoke/REPORT.md", "no dated folder: the last by name");
  assert.equal(model(folders([["2026-11-12-smoke", fail], ["2026-11-13-bug-x", fail]])).results.report, "reports/2026-11-13-bug-x/REPORT.md");
  const used = all(mk(folders([["2026-11-12", pass], ["2026-11-12-smoke", fail]])));
  assert.equal(used.q.report, "reports/2026-11-12/REPORT.md");
  assert.ok(qualityMd(used.q, used.m).includes("Results come from reports/2026-11-12/REPORT.md."));
  assert.ok(renderPages(used.m, used.q)["QUALITY.html"].includes("Results come from reports/2026-11-12/REPORT.md."));
  assert.deepEqual(Object.keys(renderPages(used.m, used.q)).filter((k) => k.startsWith("reports/")), ["reports/2026-11-12/REPORT.html"]);
  assert.ok(qualityMd(all(mk({})).q, all(mk({})).m).includes("There is no report yet"));

  // G3: nothing is read through a link, and no outside content reaches a page, QUALITY.md or quality.json.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-out-"));
  tmps.push(outside);
  const MARK = "OUTSIDE_SECRET_MARKER";
  fs.writeFileSync(path.join(outside, "PRD.md"), PRD.replace("first", MARK));
  fs.writeFileSync(path.join(outside, "REPORT.md"), REP(`| TC-1a | pass | ${MARK} |`));
  fs.mkdirSync(path.join(outside, "2099-01-01"));
  fs.writeFileSync(path.join(outside, "2099-01-01", "REPORT.md"), REP(`| TC-1a | pass | ${MARK} |`));
  const linked = (rel, target, files = {}) => {
    const d = mk({ "reports/2026-11-12/REPORT.md": REP(fail), ...files });
    fs.rmSync(path.join(d, rel), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.symlinkSync(target, path.join(d, rel));
    return d;
  };
  const refuses = (d, rel, tail = rel) => {
    const { m: lm, text } = all(d);
    assert.ok(lm.problems.some((p) => p.message === `${tail} is a link or leads outside the folder: not read`), JSON.stringify(lm.problems));
    assert.ok(!text.includes(MARK), `${rel}: outside content leaked`);
    assert.ok(!Object.values(lm.files).some((f) => f.path.includes(path.basename(outside))));
    return lm;
  };
  m = refuses(linked("PRD.md", path.join(outside, "PRD.md")), "PRD.md");
  assert.equal(m.requirements.length, 0);
  refuses(linked("reports/2026-11-12/REPORT.md", path.join(outside, "REPORT.md")), "REPORT.md", "reports/2026-11-12/REPORT.md");
  m = refuses(linked("reports/2099-01-01", path.join(outside, "2099-01-01")), "report folder", "reports/2099-01-01/REPORT.md");
  assert.equal(m.results.report, "reports/2026-11-12/REPORT.md", "an unreadable newer folder is skipped");
  m = refuses(linked("reports", outside), "reports dir", "reports");
  assert.equal(m.results.report, null);
  refuses(linked("CUJs.md", path.join(outside, "PRD.md")), "CUJs.md");
  // A link to a file inside the folder is a link too; a folder that is itself a link to a real folder is fine.
  fs.writeFileSync(path.join(outside, "keep.md"), "x");
  const inner = mk({});
  fs.rmSync(path.join(inner, "TESTCASES.md"));
  fs.symlinkSync(path.join(inner, "CUJs.md"), path.join(inner, "TESTCASES.md"));
  assert.ok(probs(inner).includes("TESTCASES.md:0 TESTCASES.md is a link or leads outside the folder: not read"));
  const viaLink = path.join(outside, "dir-link");
  fs.symlinkSync(mk({}), viaLink);
  assert.deepEqual(probs(viaLink), []);

  // G4: no path in anything written; the same folder gives the same bytes by absolute and relative path.
  const here = mk({ "reports/2026-11-12/REPORT.md": REP(pass) });
  const at = new Date("2026-01-03T04:05:06.000Z");
  const out = (dir) => { const x = readE2e(dir); const y = quality(x); return JSON.stringify({ md: qualityMd(y, x), json: qualityJson(y, x, at), pages: renderPages(x, y) }); };
  const abs = out(here);
  const rel = out(path.relative(process.cwd(), here));
  assert.equal(abs, rel, "same bytes by absolute and relative path");
  for (const needle of [here, path.basename(here), os.tmpdir(), path.relative(process.cwd(), here)]) assert.ok(!abs.includes(needle), `leaks ${needle}`);
  assert.deepEqual(Object.keys(JSON.parse(JSON.parse(abs).json).sources).sort(), ["CUJs.md", "INVENTORY.md", "PRD.md", "TESTCASES.md", "reports/2026-11-12/REPORT.md"]);
  assert.ok(Object.values(JSON.parse(JSON.parse(abs).json).sources).every((h) => /^[0-9a-f]{64}$/.test(h)));

  // G12: a new, changed or removed screenshot makes the report page stale.
  const png = (n) => Buffer.from([137, 80, 78, 71, n]);
  const sd = mk({ "reports/2026-11-12/REPORT.md": REP(pass) });
  const build = () => { const x = readE2e(sd); for (const [rel, html] of Object.entries(renderPages(x, quality(x)))) { fs.mkdirSync(path.dirname(path.join(sd, rel)), { recursive: true }); fs.writeFileSync(path.join(sd, rel), html); } };
  build();
  assert.deepEqual(stalePages(sd), []);
  const shot = path.join(sd, "reports/2026-11-12/TC-1a.png");
  fs.writeFileSync(shot, png(1));
  assert.deepEqual(stalePages(sd), ["reports/2026-11-12/REPORT.html"], "added");
  build();
  assert.deepEqual(stalePages(sd), []);
  fs.writeFileSync(shot, png(2));
  assert.deepEqual(stalePages(sd), ["reports/2026-11-12/REPORT.html"], "changed");
  build();
  fs.rmSync(shot);
  assert.deepEqual(stalePages(sd), ["reports/2026-11-12/REPORT.html"], "removed");

  // Wording: the Left open subtitle is true for all four kinds.
  const open = all(mk({ "TESTCASES.md": TC.replace("Covers: R1", "Covers: R1.f1") }));
  assert.ok(open.q.open.length);
  const SUB = "Nothing below has a runnable case that settles it, or a Gap line. Write the case or the Gap line.";
  assert.ok(qualityMd(open.q, open.m).includes(SUB));
  assert.ok(renderPages(open.m, open.q)["QUALITY.html"].includes(SUB));
  assert.ok(!/No case and no Gap line/i.test(open.text));

  // A Covers: entry naming an undefined failure id reaches nothing.
  const undef = all(mk({ "TESTCASES.md": TC.replace("Covers: R1", "Covers: R1.f9") }));
  assert.ok(undef.m.problems.some((p) => p.message === "R1.f9 is referenced but not defined"));
  assert.equal(undef.q.capabilities.with_case, 0);
  assert.equal(undef.q.requirements.with_case, 0);
  assert.equal(quality(model({})).capabilities.with_case, 1, "R1 itself reaches C1");

  console.log("ok e2e-hardening");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
