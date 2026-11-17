/**
 * renderPages / stalePages: the HTML pages built from the e2e model of test/fixtures/e2e-sample.
 *
 * Run: node test/e2e-html.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readE2e } from "../src/e2e-model.js";
import { quality } from "../src/e2e-quality.js";
import { renderPages, stalePages } from "../src/e2e-html.js";
import { md } from "../src/e2e-markdown.js";
import { recordVerdicts } from "../src/e2e-verdicts.js";

const fixture = new URL("./fixtures/e2e-sample", import.meta.url).pathname;
const tmps = [];
const copy = (edit) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-html-"));
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
const render = (dir) => {
  const model = readE2e(dir);
  return renderPages(model, quality(model));
};
const write = (dir, pages) => {
  for (const [rel, html] of Object.entries(pages)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), html);
  }
};

try {
  const pages = render(fixture);
  assert.deepEqual(Object.keys(pages).sort(), ["CUJs.html", "PRD.html", "QUALITY.html", "TESTCASES.html", "reports/2026-01-02/REPORT.html"]);
  const { "PRD.html": prd, "CUJs.html": cujs, "TESTCASES.html": tcs, "QUALITY.html": qual, "reports/2026-01-02/REPORT.html": rep } = pages;

  // PRD: feature name, requirement anchors, links to cases, prose, capabilities with real screen names.
  assert.ok(prd.includes("Notes") && prd.includes("Search"));
  for (const id of ["R1", "R2", "R3", "R4", "R1.f1", "F1", "F2", "C4"]) assert.ok(prd.includes(`id="${id}"`), `PRD anchor ${id}`);
  assert.ok(prd.includes('href="TESTCASES.html#TC-1a"'));
  assert.ok(prd.includes("Keep short notes on the phone."), "PRD prose");
  assert.ok(prd.includes("Sync between phones."), "PRD non-goals");
  assert.ok(prd.includes("Edit note"), "capability shows its screen's title");
  assert.ok(!prd.includes("not verified"), "no fixed not-verified chip: items the verifier does not judge show none");
  assert.ok(prd.indexOf("Keep short notes") < prd.indexOf('id="F1"'), "prose above the features");
  assert.ok(prd.includes('<meta name="e2e-sources"'));

  // Back links and cross links.
  assert.ok(tcs.includes('href="PRD.html#R1"'));
  assert.ok(tcs.includes('id="TC-1a"') && tcs.includes('href="PRD.html#R1.f1"'));
  assert.ok(tcs.includes("fresh install"), "case Start text");
  assert.ok(tcs.includes("<ol>") && tcs.includes("Cleanup"), "case Steps list and Cleanup");
  assert.ok(cujs.includes('id="CUJ-1"') && cujs.includes('href="PRD.html#R1"') && cujs.includes('href="TESTCASES.html#TC-1a"'));
  assert.ok(cujs.includes("The note shows in the list."), "CUJ outcome bullets");
  assert.ok(qual.includes("4 of 6") && qual.includes("Share"), "capability total and an untested control");
  assert.ok(qual.includes('id="C6"'), "a capability in no feature is anchored on QUALITY.html");
  assert.ok(qual.includes('href="PRD.html#C4"'));
  for (const p of Object.values(pages)) {
    assert.ok(p.includes('href="QUALITY.html') || p.includes('href="../../QUALITY.html'), "nav");
    assert.ok(p.includes("prefers-color-scheme: dark"));
    assert.ok(!p.includes("<script") && !/https?:\/\//.test(p), "no script, no remote url");
    assert.ok(!p.includes("document has problems"), "no banner when ok");
  }
  assert.ok(rep.includes("data:image/png;base64,"));
  assert.ok(rep.includes("pass") && rep.includes("fail"));
  assert.ok(rep.includes('href="../../TESTCASES.html#TC-1a"'));
  assert.ok(rep.includes("<code>a | b</code>"), "report table cell keeps its backticked pipe");

  // Hostile text: escaped everywhere, pipe in code stays in its cell, agent links are plain text.
  const evil = copy((d) => {
    sub(d, "PRD.md", "A saved note appears in the list with its title.", '<script>alert(1)</script> & "x" [click](https://evil.example/x) [js](javascript:alert(1))');
    sub(d, "INVENTORY.md", 'text "Save"', "`a | b`");
    sub(d, "CUJs.md", "- The note shows in the list.", "- <img src=x onerror=alert(1)>");
  });
  const bad = render(evil);
  assert.ok(bad["PRD.html"].includes("&lt;script&gt;"));
  assert.ok(bad["PRD.html"].includes("click (https://evil.example/x)"), "link shown as text");
  for (const html of Object.values(bad)) {
    assert.ok(!html.includes("<script") && !html.includes("<img src=x"));
    for (const [, h] of html.matchAll(/href="([^"]*)"/g)) assert.match(h, /^(#|((\.\.\/)*|reports\/[\w.-]+\/)[A-Za-z]+\.html#?)[\w.\-]*$/, h);
  }
  const row = bad["QUALITY.html"].split("<tr").find((r) => r.includes("a | b"));
  assert.ok(row, "capability row exists");
  assert.equal((row.match(/<t[dh][ >]/g) ?? []).length, 6);

  // A hostile report path built by hand (bypassing the model's folder filter) never reaches an attribute raw.
  const hm = readE2e(fixture);
  const hostile = 'reports/x" onmouseover="alert(1)" a="/REPORT.md';
  hm.files[hostile] = hm.files["reports/2026-01-02/REPORT.md"];
  hm.results.report = hostile;
  for (const [key, html] of Object.entries(renderPages(hm, quality(hm)))) {
    assert.ok(!/["<]/.test(key), `key ${key}`);
    assert.ok(!html.includes('" onmouseover='), "raw attribute injection");
    for (const [, h] of html.matchAll(/href="([^"]*)"/g)) assert.ok(!/[<]/.test(h), h);
  }

  // Banner when the documents have problems.
  const broken = render(copy((d) => sub(d, "TESTCASES.md", "Covers: R4 (C2)", "Covers: R99")));
  for (const html of Object.values(broken)) assert.ok(html.includes("have problems") && html.includes("QUALITY.html"), "banner");
  assert.ok(broken["QUALITY.html"].includes("R99 is referenced but not defined"));

  // Screenshots: only png/jpg/jpeg beside REPORT.md whose name starts with a known case id.
  const shots = copy((d) => {
    const r = path.join(d, "reports/2026-01-02");
    fs.copyFileSync(path.join(r, "TC-1a.png"), path.join(r, "TC-1a-saved.png"));
    fs.copyFileSync(path.join(r, "TC-1a.png"), path.join(r, "TC-3b.jpg"));
    fs.copyFileSync(path.join(r, "TC-1a.png"), path.join(r, "random.png"));
    fs.copyFileSync(path.join(r, "TC-1a.png"), path.join(r, "TC-9z.png"));
  });
  const sp = render(shots)["reports/2026-01-02/REPORT.html"];
  assert.equal((sp.match(/data:image\/png;base64,/g) ?? []).length, 2);
  assert.equal((sp.match(/data:image\/jpeg;base64,/g) ?? []).length, 1);
  assert.ok(!sp.includes("random.png") && !sp.includes("TC-9z"));

  // No report: four pages.
  const none = render(copy((d) => fs.rmSync(path.join(d, "reports"), { recursive: true })));
  assert.deepEqual(Object.keys(none).sort(), ["CUJs.html", "PRD.html", "QUALITY.html", "TESTCASES.html"]);

  // stalePages: nothing stale after writing, PRD.md change marks pages stale, a missing page is named.
  const out = copy();
  write(out, render(out));
  assert.deepEqual(stalePages(out), []);
  fs.unlinkSync(path.join(out, "CUJs.html"));
  assert.deepEqual(stalePages(out), ["CUJs.html"]);
  write(out, { "CUJs.html": render(out)["CUJs.html"] });
  sub(out, "PRD.md", "Keep short notes", "Keep tiny notes");
  assert.ok(stalePages(out).includes("PRD.html"));
  assert.ok(stalePages(out).includes("reports/2026-01-02/REPORT.html"), "any source change marks every page stale");

  // The block formatter.
  const h = md("# T\n\npara **b** `c<d>` x\n\n- a\n  - a1\n- b\n\n1. one\n2. two\n\n| H | I |\n| - | - |\n| `x | y` | z |\n\n```\n<b>raw</b>\n```\n> quote <i>\n", { base: 1 });
  assert.ok(h.includes("<h2>T</h2>") && h.includes("<strong>b</strong>") && h.includes("<code>c&lt;d&gt;</code>"));
  assert.ok(h.includes("<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>"), h);
  assert.ok(h.includes("<ol><li>one</li><li>two</li></ol>"));
  assert.ok(h.includes("<td><code>x | y</code></td><td>z</td>"));
  assert.ok(h.includes("&lt;b&gt;raw&lt;/b&gt;") && h.includes("&gt; quote &lt;i&gt;"));
  assert.ok(md("```\nopen").includes("<pre>"), "unclosed fence still renders");
  // An escaped pipe stays in its cell; a row with more cells than the header keeps them in the last column.
  const t2 = md("| H | I |\n| - | - |\n| x \\| y | z |\n| a | b | c | d |");
  assert.ok(t2.includes("<tr><td>x | y</td><td>z</td></tr>"), t2);
  assert.ok(t2.includes("<tr><td>a</td><td>b | c | d</td></tr>"), t2);
  // A source not written yet: its page still renders and says so, and QUALITY.html lists what is pending.
  const early = render(copy((d) => { for (const f of ["PRD.md", "CUJs.md", "TESTCASES.md", "reports"]) fs.rmSync(path.join(d, f), { recursive: true }); }));
  assert.ok(early["PRD.html"].includes("PRD.md is not written yet."));
  assert.ok(early["CUJs.html"].includes("CUJs.md is not written yet."));
  assert.ok(early["TESTCASES.html"].includes("TESTCASES.md is not written yet."));
  assert.ok(early["QUALITY.html"].includes("Not written yet: PRD.md, CUJs.md, TESTCASES.md."));
  for (const p of Object.values(early)) assert.ok(!p.includes('class="banner"'), "no problem banner for a pending document");
  assert.ok(!render(fixture)["PRD.html"].includes("not written yet"));
  // A bug case TC-B1: its screenshots are embedded, it counts, and it belongs to no CUJ.
  const bugDir = copy((d) => {
    fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-B1 · P1 · Saving twice keeps one note\nFeature: F1 · Type: negative\nCovers: R1 (C4)\nTier: edge · Depth: kept\nRun mode: phone\n");
    fs.appendFileSync(path.join(d, "reports/2026-01-02/REPORT.md"), "| TC-B1 | fail | P1 | Saving twice keeps one note | |\n");
    for (const n of ["TC-B1.png", "TC-B1-before.png"]) fs.copyFileSync(path.join(d, "reports/2026-01-02/TC-1a.png"), path.join(d, "reports/2026-01-02", n));
  });
  const bugModel = readE2e(bugDir);
  const bugQ = quality(bugModel);
  const bugRep = renderPages(bugModel, bugQ)["reports/2026-01-02/REPORT.html"];
  assert.ok(bugRep.includes("TC-B1.png") && bugRep.includes("TC-B1-before.png"), "both TC-B1 screenshots embedded");
  assert.equal(bugQ.cases.total, 7);
  assert.ok(bugQ.by_cuj.every((j) => !j.cases.includes("TC-B1")));
  // A setup case shows a setup chip and no tier or depth chip.
  const setupPages = render(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-00 · P1 · Remove leftovers\nFeature: all · Type: setup\nRun mode: phone\n")));
  const card = setupPages["TESTCASES.html"].split('<article class="card" id="TC-00">')[1].split("</article>")[0];
  assert.ok(card.includes('<span class="chip ">setup</span>'), card);
  assert.ok(!card.includes("tier:") && !card.includes("depth:") && !card.includes("no type"), card);
  assert.ok(setupPages["TESTCASES.html"].includes("1 setup"), "lede counts setup cases");
  assert.ok(render(fixture)["TESTCASES.html"].includes("tier: deep"), "other cases keep their tier chip");
  // Set aside: its own section with the reason, the in-scope denominator in the tiles, a chip in the inventory.
  const asPages = render(copy((d) => fs.appendFileSync(path.join(d, "PRD.md"), "\n- Non-goal: C6 · sharing <b>needs</b> a second phone\n")));
  const aq = asPages["QUALITY.html"];
  assert.ok(aq.includes("Set aside as non-goals") && aq.includes("sharing &lt;b&gt;needs&lt;/b&gt; a second phone"), "section with escaped reason");
  assert.ok(aq.includes("4 of 5") && aq.includes("1 set aside as non-goals"), "in-scope denominator and the set-aside count");
  assert.ok(!aq.includes("not in any feature"), "C6 is no longer listed as in no feature");
  assert.ok(!render(fixture)["QUALITY.html"].includes("Set aside as non-goals"), "no section when nothing is set aside");
  // Left open and acknowledged gaps on QUALITY.html.
  assert.ok(qual.includes("Left open") && qual.includes("R3") && qual.includes("no runnable case"), "open list");
  assert.ok(!qual.includes("Acknowledged gaps"), "no acknowledged section without gaps");
  assert.ok(qual.indexOf("Left open") < qual.indexOf("Not covered by a runnable case"));
  const gapPages = render(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Gaps\n- Gap: R2.f1 · <i>cannot</i> be staged\n- Gap: F2 deep · one screen\n")));
  const gq2 = gapPages["QUALITY.html"];
  assert.ok(gq2.includes("Acknowledged gaps") && gq2.includes("&lt;i&gt;cannot&lt;/i&gt; be staged") && gq2.includes("one screen"), "acknowledged section, escaped");
  assert.ok(gq2.includes('href="PRD.html#R2.f1"'), "gap ref links to the PRD");
  assert.ok(!gq2.includes("R2.f1</a> · a note deleted"), "an acknowledged failure is not in the open list");
  const gapCards = gapPages["TESTCASES.html"].split('<article class="card"').slice(1).map((a) => a.split("</article>")[0]);
  assert.ok(gapCards.length && gapCards.every((a) => !a.includes("Gap:")), "gap lines are not shown as case text");
  assert.ok(gapPages["TESTCASES.html"].indexOf("Gap: R2.f1 · &lt;i&gt;cannot&lt;/i&gt; be staged") > gapPages["TESTCASES.html"].lastIndexOf("</article>"), "the Gaps section is shown as prose, after the last case");
  // Too shallow: listed as open with the depths; a depth Gap moves it to the acknowledged list.
  assert.ok(qual.includes("shallow") && qual.includes("must be checked at elsewhere; the deepest case checks screen"), "shallow item");
  const dp = render(copy((d) => fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Gaps\n- Gap: R4 depth · <b>one</b> screen\n")))["QUALITY.html"];
  assert.ok(!dp.includes("must be checked at"), "acknowledged, so not open");
  assert.ok(dp.includes("</a> depth") && dp.includes("&lt;b&gt;one&lt;/b&gt; screen"), "listed under acknowledged gaps, escaped");

  // Verifier verdicts on the pages. Fixture: TC-1a approved (1 try), TC-1b approved after a repair (same agent),
  // TC-1c repair, TC-2a question (manual), TC-3a unresolved, TC-3b no row.
  const cardOf = (html, id) => html.split('<article class="card"').find((a) => a.startsWith(` id="${id}">`)).split("</article>")[0];
  const chipOf = (html, id, kind, word) => assert.ok(cardOf(html, id).includes(`<span class="chip ${kind}">${word}</span>`), `${id} chip ${word}: ${cardOf(html, id).slice(0, 600)}`);
  chipOf(tcs, "TC-1a", "pass", "approved");
  chipOf(tcs, "TC-1b", "pass", "approved");
  chipOf(tcs, "TC-1c", "warn", "repair");
  chipOf(tcs, "TC-2a", "ask", "question");
  chipOf(tcs, "TC-3a", "warn", "unresolved");
  chipOf(tcs, "TC-3b", "", "unverified");
  assert.ok(cardOf(tcs, "TC-1c").includes("independent agent, attempt 1") && cardOf(tcs, "TC-1b").includes("same agent, attempt 2") && cardOf(tcs, "TC-3a").includes("independent agent, attempt 3"));
  // A case that is not approved shows its latest reason without opening anything; an approved one does not.
  assert.ok(/class="verdict[^"]*">[^]*Verifier:[^]*an app that opens an empty note passes; Expected only checks the screen title\./.test(cardOf(tcs, "TC-1c")));
  assert.ok(cardOf(tcs, "TC-3a").includes("Expected names no title that must be absent") && cardOf(tcs, "TC-2a").includes("Only the user can say"));
  assert.ok(cardOf(tcs, "TC-3b").includes("Not judged yet"));
  assert.ok(!cardOf(tcs, "TC-1a").includes('class="verdict'), "approved: the reason sits in the history only");
  // History: closed, oldest first, titled with the row count; omitted with no rows.
  assert.ok(/<details class="history"><summary>Verdict history \(1\)<\/summary>/.test(cardOf(tcs, "TC-1a")) && !cardOf(tcs, "TC-1a").includes("<details open"));
  const h1b = cardOf(tcs, "TC-1b");
  assert.ok(h1b.includes("Verdict history (2)"));
  assert.ok(h1b.indexOf("an app that shows no error and discards") < h1b.indexOf("the new Expected checks the error"), "oldest first");
  assert.ok(h1b.includes("2026-11-14") && h1b.includes("2026-11-15"));
  assert.ok(!cardOf(tcs, "TC-3b").includes("<details"), "no history block without rows");
  assert.ok(!tcs.includes("not verified") && !qual.includes("not verified") && !rep.includes("not verified") && !cujs.includes("not verified"));
  for (const p of Object.values(pages)) assert.ok(!p.includes("nothing here has been verified"), "footer sentence replaced");
  // Items the verifier does not judge show no verifier chip; the PRD and CUJs show each linked case's status word.
  assert.ok(!cardOf(prd, "R1").includes("verified"));
  assert.ok(/TC-1c<\/a>[^]*?<span class="chip warn">repair<\/span>/.test(cardOf(prd, "R2")), "PRD: case status beside its link");
  assert.ok(cardOf(prd, "R1").includes('<span class="chip pass">approved</span>'));
  assert.ok(cardOf(cujs, "CUJ-1").includes('<span class="chip pass">approved</span>'));
  assert.ok(!/<h3>R1<\/h3>[^]*?<\/div>/.exec(cardOf(prd, "R1"))[0].includes("approved"), "the requirement itself has no verifier chip");
  // A reopen row reads "reopened", by the user.
  const reopened = render(copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-3a | 0 | reopen | user | 3b2c1eaffa0c0ca6 | 2026-11-17 | The user allowed three more tries. |\n")));
  assert.ok(cardOf(reopened["TESTCASES.html"], "TC-3a").includes("reopened") && cardOf(reopened["TESTCASES.html"], "TC-3a").includes("The user allowed three more tries."));
  assert.match(cardOf(reopened["TESTCASES.html"], "TC-3a"), /<b>reopened<\/b> <span class="muted">the user, 2026-11-17<\/span>/);
  // QUALITY.html: approved tiles lead, with-a-case numbers are secondary text; Verifier section.
  assert.ok(/1 of 6<\/b><small>controls have an approved case[^]*?4 of 6 have a case/.test(qual), "capabilities tile");
  assert.ok(/1 of 4<\/b><small>requirements have an approved case[^]*?3 of 4 have a case/.test(qual));
  assert.ok(qual.includes("requirements with an approved case deep enough") && qual.includes("failures have an approved case") && qual.includes("2 of 3 have a case"));
  assert.ok(!qual.includes("<small>capabilities have a case") && !qual.includes("<small>failures have a case"), "no separate with-a-case tiles");
  const ver = qual.slice(qual.indexOf('id="verifier"'));
  assert.ok(ver.includes("approved") && ver.includes("independent agent") && ver.includes("same agent"));
  assert.ok(ver.includes('href="TESTCASES.html#TC-1c"') && ver.includes("Expected only checks the screen title") && ver.includes("Not judged yet"));
  assert.ok(qual.includes("not a run"), "approval is of a design, not a run");
  // Not-judged cases share one line of linked ids; judged ones keep their own.
  assert.match(ver, /<li>Not judged yet \(1\): <a class="nw" href="TESTCASES\.html#TC-3b">TC-3b<\/a><\/li>/);
  const nvq = render(copy((d) => fs.rmSync(path.join(d, "VERIFY.md"))))["QUALITY.html"];
  const nvVer = nvq.slice(nvq.indexOf('id="verifier"'));
  assert.equal(nvVer.split("Not judged yet").length - 1, 1, "one line for all six");
  assert.match(nvVer, /<li>Not judged yet \(6\): <a class="nw" href="TESTCASES\.html#TC-1a">TC-1a<\/a>, <a class="nw" href="TESTCASES\.html#TC-1b">TC-1b<\/a>,[^<]*<a/);
  // A long latest reason: the card's verdict block is clamped by CSS, and the history holds the full text.
  const long = "R2: " + "an app that opens the wrong note still shows a title, ".repeat(14) + "END-OF-REASON.";
  const lp = render(copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), `| TC-1c | 2 | repair | independent | 9ce5e9680a7f9cc1 | 2026-11-17 | ${long} |\n`)))["TESTCASES.html"];
  assert.ok(long.length > 600);
  assert.match(cardOf(lp, "TC-1c"), /<p class="verdict clamp warn">/);
  assert.ok(/<details class="history">[^]*END-OF-REASON\./.test(cardOf(lp, "TC-1c")), "the history holds the full reason");
  assert.ok(cardOf(lp, "TC-1c").includes(long), "the full text, not a cut one");
  assert.match(lp, /\.verdict\.clamp\{[^}]*-webkit-line-clamp:4/);
  assert.ok(qual.includes("approved / with a case") && /<td>\d+% \/ \d+%<\/td>/.test(qual), "by-feature table carries approved beside with-a-case percentages");
  // Escaping: a reason is shown as plain text, Markdown not formatted.
  const ev = render(copy((d) => sub(d, "VERIFY.md", "R2: an app that opens an empty note passes; Expected only checks the screen title.", '<script>alert(1)</script> \\| "x" **bold**')));
  for (const html of [ev["TESTCASES.html"], ev["QUALITY.html"]]) {
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; | &quot;x&quot; **bold**") && !html.includes("<script") && !html.includes("<strong>bold"), html.slice(html.indexOf("&lt;script") - 80, html.indexOf("&lt;script") + 200));
  }
  // Stale: the case changed after it was judged: the card says so with the previous verdict and reason.
  const st = render(copy((d) => sub(d, "TESTCASES.md", "Opening a note shows its text", "Opening a note shows its title")));
  chipOf(st["TESTCASES.html"], "TC-1c", "", "stale");
  assert.ok(/Changed since it was judged[^]*repair[^]*an app that opens an empty note passes/.test(cardOf(st["TESTCASES.html"], "TC-1c")));
  const stVer = st["QUALITY.html"].slice(st["QUALITY.html"].indexOf('id="verifier"'));
  assert.match(stVer, /<li>Not judged yet \(1\): <a class="nw" href="TESTCASES\.html#TC-3b">TC-3b<\/a><\/li>/, "a stale case is not in the not-judged line");
  assert.match(stVer, /TC-1c<\/a> <span class="chip [^"]*">stale<\/span> changed since it was judged/);
  // Invalid: an unreadable ledger row for the case.
  const inv = render(copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-3b | 1 | maybe | same | x | y | z |\n")));
  chipOf(inv["TESTCASES.html"], "TC-3b", "fail", "invalid");
  assert.ok(cardOf(inv["TESTCASES.html"], "TC-3b").includes("VERIFY.md line"));
  // A damaged row superseded by a later verdict shows in the history where it stood.
  const supDir = copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-3b | 1 | maybe | same | x | y | z |\n"));
  const supLine = fs.readFileSync(path.join(supDir, "VERIFY.md"), "utf8").trimEnd().split("\n").length;
  fs.writeFileSync(path.join(supDir, "s.jsonl"), JSON.stringify({ id: "TC-3b", verdict: "repair", by: "independent", reason: "R4: weak." , text: readE2e(supDir).cases.find((c) => c.id === "TC-3b").verify.hash }) + "\n");
  assert.equal(recordVerdicts({ dir: supDir, file: path.join(supDir, "s.jsonl") }).code, 0);
  const supCard = cardOf(render(supDir)["TESTCASES.html"], "TC-3b");
  assert.ok(supCard.includes("Verdict history (2)"), supCard);
  const supHist = supCard.slice(supCard.indexOf('<details class="history">'));
  assert.ok(supHist.indexOf(`<li class="muted">row at VERIFY.md line ${supLine} could not be read (superseded)</li>`) > 0 && supHist.indexOf("could not be read") < supHist.indexOf("R4: weak."), supHist);
  // Setup cases get no verifier chip.
  assert.ok(!card.includes("unverified") && !card.includes("approved"), "setup: no verifier chip");
  // New verdicts mark every page stale: VERIFY.md is one of the hashed sources.
  const vdir = copy();
  write(vdir, render(vdir));
  assert.deepEqual(stalePages(vdir), []);
  fs.writeFileSync(path.join(vdir, "v.jsonl"), JSON.stringify({ id: "TC-3b", verdict: "approved", by: "independent", reason: "R4: a no-match search that shows the list is rejected." , text: readE2e(vdir).cases.find((c) => c.id === "TC-3b").verify.hash }) + "\n");
  assert.equal(recordVerdicts({ dir: vdir, file: path.join(vdir, "v.jsonl"), now: new Date(2026, 10, 20) }).code, 0);
  assert.deepEqual(stalePages(vdir).sort(), ["CUJs.html", "PRD.html", "QUALITY.html", "TESTCASES.html", "reports/2026-01-02/REPORT.html"]);

  // The visible verdict block (outside the history) shows the LATEST row, never an earlier one.
  const block = (html, id) => (/<p class="verdict[^"]*">[^]*?<\/p>/.exec(cardOf(html, id)) ?? [""])[0];
  assert.ok(block(tcs, "TC-3a").includes("Expected names no title that must be absent"), block(tcs, "TC-3a"));
  assert.ok(!block(tcs, "TC-3a").includes("Steps never type a query") && !block(tcs, "TC-3a").includes("the query is typed now"), "not an earlier attempt's reason");
  assert.ok(cardOf(tcs, "TC-3a").includes("Steps never type a query"), "earlier reasons stay in the history");
  // Stale on a case with two verdict rows (repair, then approved): "Before that" names the LAST verdict and reason.
  const stb = render(copy((d) => sub(d, "TESTCASES.md", "Saving with no connection keeps the text", "Saving with no connection keeps the text safe")));
  const sb = block(stb["TESTCASES.html"], "TC-1b");
  assert.ok(sb.includes("Changed since it was judged") && sb.includes("approved") && sb.includes("the new Expected checks the error and the kept text"), sb);
  assert.ok(!sb.includes("repair") && !sb.includes("an app that shows no error and discards"), "not the first row: " + sb);
  // No verdict at all: the opening text says so and claims no approval.
  const noVerdictQ = render(copy((d) => fs.rmSync(path.join(d, "VERIFY.md"))))["QUALITY.html"];
  assert.ok(noVerdictQ.includes("No test case has been judged by the verifier yet.") && !noVerdictQ.includes("The verifier approved"), "no-verdict opening");
  assert.ok(qual.includes("The verifier approved 2 of 6 test cases;"), "opening with verdicts");
  assert.ok(qual.includes("2 of 4 with a case deep enough") && qual.includes("<th>Controls: approved / with a case</th>"), "tile secondary text and table headers");
  assert.ok(!/capabilit/i.test(qual.replace(/<style>[^]*?<\/style>/, "").replace(/<[^>]*>/g, " ")), "people-facing text says controls");
  // Labels and percentages match QUALITY.md: rounded down, "with a case deep enough", no report yet without one.
  for (const p of Object.values(pages)) assert.ok(!p.includes("tested deep enough") && !p.includes("Tested deep enough"), "no 'tested deep enough'");
  assert.ok(qual.includes("<small>requirements with an approved case deep enough (25%)</small>") && qual.includes('<small class="sub">2 of 4 with a case deep enough</small>'), "tile label");
  assert.ok(qual.includes("<b>4 of 6</b><small>controls exercised in the last report (66%)</small>"), "rounded down");
  assert.ok(qual.includes("<th>Deep enough: approved / any case</th>"), "per-feature column");
  assert.ok(/F1<\/a> · Notes [^\n]*?<td>25% \/ 75%<\/td><td>33% \/ 66%<\/td>/.test(qual) && /F1<\/a> · Notes<\/td><td>75%<\/td><td>75%<\/td>/.test(qual), "F1 rows rounded down like QUALITY.md");
  assert.ok(qual.includes("A control used by requirements of two features is counted in both rows"), "per-feature note");
  assert.ok(prd.includes("2 of 3 requirements have a case, 2 with a case deep enough."), "feature card wording");
  const noRepQ = none["QUALITY.html"];
  assert.ok(noRepQ.includes("<b>no report yet</b><small>controls exercised in the last report</small>") && noRepQ.includes("<b>no report yet</b><small>controls passing in the last report</small>"), "no report yet");
  assert.ok(!noRepQ.includes("0 of 6"), "no 0 of 6 without a report");
  const noMode = render(copy((d) => sub(d, "TESTCASES.md", "Tier: core · Depth: screen\nRun mode: task\n", "Tier: core · Depth: screen\n")))["TESTCASES.html"];
  assert.ok(noMode.includes("6 cases: 4 phone, 0 task, 1 manual, 1 with no run mode."), "cases with no run mode counted on TESTCASES.html");
  // Every part of the documents is on exactly one page: feature prose, a requirement's other lines, a heading that is
  // not a feature, the CUJs intro, a group's prose, prose after the last journey, the test cases intro, prose between
  // cases. Planted beside each, <u> is escaped.
  const MARKS = ["MARK_WHAT", "MARK_SCREENS", "MARK_GATES", "MARK_HARM", "MARK_FTAIL", "MARK_REQ", "MARK_UNASSIGNED", "MARK_CUJSTART", "MARK_CUJGROUP", "MARK_ROBUST", "MARK_TCINTRO", "MARK_TCMID", "MARK_INCUJ", "MARK_INCASE", "MARK_CUJMID"];
  const u = (m) => `${m} <u>x</u>`;
  const shown = render(copy((d) => {
    sub(d, "PRD.md", "### F1 · Notes · P0\n", `### F1 · Notes · P0\nWhat: ${u("MARK_WHAT")}\nScreens: ${u("MARK_SCREENS")}\nGates: ${u("MARK_GATES")}\nHarm: ${u("MARK_HARM")}\n\n`);
    sub(d, "PRD.md", "  Fails: none in source\n\n### F2", `  Fails: none in source\n${u("MARK_FTAIL")}\n\n### F2`);
    sub(d, "PRD.md", "  Proof: kept\n", `  Proof: kept\n  Why: ${u("MARK_REQ")}\n`);
    sub(d, "PRD.md", "## Non-goals", `### Unassigned\n- S9 ${u("MARK_UNASSIGNED")}\n\n## Non-goals`);
    sub(d, "CUJs.md", "# Notes CUJs\n", `# Notes CUJs\n\nStart state: ${u("MARK_CUJSTART")}\n`);
    sub(d, "CUJs.md", "## F1 · Notes\n", `## F1 · Notes\n${u("MARK_CUJGROUP")}\n`);
    fs.appendFileSync(path.join(d, "CUJs.md"), `\n## Robustness\n- ${u("MARK_ROBUST")}\n`);
    sub(d, "TESTCASES.md", "# Notes test cases\n", `# Notes test cases\n\n${u("MARK_TCINTRO")}\n`);
    sub(d, "TESTCASES.md", "### TC-3a", `## Search\n${u("MARK_TCMID")}\n\n### TC-3a`);
    sub(d, "CUJs.md", "- The note shows in the list.", `- ${u("MARK_INCUJ")}`);
    sub(d, "CUJs.md", "### CUJ-2", `### Note\n${u("MARK_CUJMID")}\n\n### CUJ-2`);
    sub(d, "TESTCASES.md", "Expected: the title is in the list.", `Expected: ${u("MARK_INCASE")}`);
  }));
  for (const m of MARKS) assert.deepEqual(Object.keys(shown).filter((p) => shown[p].includes(m)), [{ MARK_CUJSTART: "CUJs.html", MARK_CUJGROUP: "CUJs.html", MARK_ROBUST: "CUJs.html", MARK_TCINTRO: "TESTCASES.html", MARK_TCMID: "TESTCASES.html", MARK_INCUJ: "CUJs.html", MARK_INCASE: "TESTCASES.html", MARK_CUJMID: "CUJs.html" }[m] ?? "PRD.html"], m);
  for (const [p, h] of Object.entries(shown)) assert.ok(!h.includes("<u>"), `raw <u> on ${p}`);
  assert.equal((Object.values(shown).join("").match(/&lt;u&gt;x&lt;\/u&gt;/g) ?? []).length, MARKS.length, "each planted <u> shown once, escaped");
  const f1 = shown["PRD.html"].split('<section class="card" id="F1">')[1].split('<article class="card" id="R1">')[0];
  for (const m of ["MARK_WHAT", "MARK_SCREENS", "MARK_GATES", "MARK_HARM", "MARK_FTAIL"]) assert.ok(f1.includes(m), `${m} in the F1 card above its requirements`);
  assert.ok(shown["PRD.html"].split('<article class="card" id="R1">')[1].split("</article>")[0].includes("MARK_REQ"), "the requirement's other line in its card");
  const cu = shown["CUJs.html"];
  assert.ok(cu.indexOf('id="CUJ-1"') < cu.indexOf("MARK_CUJMID") && cu.indexOf("MARK_CUJMID") < cu.indexOf('id="CUJ-2"'), "text between journeys above the next one");
  assert.ok(f1.includes("<strong>What:</strong> MARK_WHAT"), "a label starts its own paragraph, in bold");
  assert.ok(cu.indexOf("MARK_CUJSTART") < cu.indexOf("MARK_CUJGROUP") && cu.indexOf("MARK_CUJGROUP") < cu.indexOf('id="CUJ-1"') && cu.lastIndexOf('id="CUJ-3"') < cu.indexOf("MARK_ROBUST"), "CUJs prose in document order");
  const tc = shown["TESTCASES.html"];
  assert.ok(tc.indexOf("MARK_TCINTRO") < tc.indexOf('id="F1"') && tc.indexOf('id="TC-2a"') < tc.indexOf("MARK_TCMID") && tc.indexOf("MARK_TCMID") < tc.indexOf('id="TC-3a"'), "test cases prose in document order");
  assert.ok(prd.includes("<h1>Notes PRD</h1>") && prd.includes('<section class="prose"><h2>Goal</h2>'), "PRD prose headings start at h2, under the page's h1");
  assert.ok(shown["PRD.html"].includes("<h3>Unassigned</h3>"), "a heading that is not a feature is shown");
  // A requirement under no feature is shown once, in the "Requirements outside a feature" card with its other lines;
  // no requirement's Caps, Proof, Fails or failure lines are shown again as text.
  const LOOSE = `- R9 · MARK_LOOSE a loose requirement.\n  Caps: C6\n  Proof: screen\n  Why: MARK_LOOSEWHY\n  Fails:\n  - R9.f1 · MARK_LOOSEFAIL\n`;
  for (const [label, from, to] of [
    ["under a heading that is not a feature", "## Non-goals", `### Unassigned\n${LOOSE}\n## Non-goals`],
    ["before the first feature", "## Features\n", `## Features\n${LOOSE}`],
    ["under a feature heading that cannot be read", "### F2 · Search · P1", `### F2 · Search\n${LOOSE}`],
  ]) {
    const lp = render(copy((d) => sub(d, "PRD.md", from, to)))["PRD.html"];
    for (const m of ["MARK_LOOSE ", "MARK_LOOSEWHY", "MARK_LOOSEFAIL"]) assert.equal(lp.split(m).length - 1, 1, `${label}: ${m} once`);
    const card = lp.split('<article class="card" id="R9">')[1]?.split("</article>")[0] ?? "";
    assert.ok(lp.includes("Requirements outside a feature") && card.includes("MARK_LOOSEWHY") && card.includes("MARK_LOOSEFAIL"), label);
    assert.ok(!/Caps:|Proof:|Fails:|R\d\.f\d ·/.test(lp.replace(/<style>[\s\S]*?<\/style>/, "")), `${label}: no Caps, Proof, Fails or failure line as text`);
    if (label.includes("cannot be read")) assert.equal(lp.split("Typing in search narrows").length - 1, 1, "R4 once");
  }
  // A fenced block with a "#" line inside a feature block stays in the block, above its requirements.
  const fenced = render(copy((d) => sub(d, "PRD.md", "### F1 · Notes · P0\n", "### F1 · Notes · P0\n```\n# MARK_FENCE\n```\n")))["PRD.html"];
  const fenceCard = fenced.split('<section class="card" id="F1">')[1].split("</section>")[0];
  assert.ok(fenceCard.includes("# MARK_FENCE") && fenceCard.indexOf("MARK_FENCE") < fenceCard.indexOf('id="R1"') && fenceCard.includes('id="R3"'), "fence in the F1 card");
  assert.equal(fenced.split("MARK_FENCE").length - 1, 1, "fence shown once");
  // Text under a "## F<n>" group heading that names no feature, and text above a retired journey or case, is shown once.
  const odd = render(copy((d) => {
    fs.appendFileSync(path.join(d, "CUJs.md"), "\n## Old\nMARK_ABOVECUJ\n\n### CUJ-9 · Old · P2 · phone\nRetired: 2026-01-01 - merged\n\n## F7 · Later\nMARK_CUJF7\n");
    fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n## Old\nMARK_ABOVETC\n\n### TC-9a · P2 · Old\nRetired: 2026-01-01 - merged\n\n## F7 · Later\nMARK_TCF7\n");
  }));
  for (const [m, p] of [["MARK_CUJF7", "CUJs.html"], ["MARK_ABOVECUJ", "CUJs.html"], ["MARK_TCF7", "TESTCASES.html"], ["MARK_ABOVETC", "TESTCASES.html"]]) {
    assert.deepEqual(Object.keys(odd).filter((k) => odd[k].includes(m)), [p], m);
    assert.equal(odd[p].split(m).length - 1, 1, `${m} once`);
  }
  assert.ok(odd["CUJs.html"].includes("<h2>F7 · Later</h2>"), "the heading of a group that names no feature");
  assert.ok(odd["CUJs.html"].indexOf("MARK_ABOVECUJ") < odd["CUJs.html"].indexOf('id="CUJ-9"') && odd["TESTCASES.html"].indexOf("MARK_ABOVETC") < odd["TESTCASES.html"].indexOf('id="TC-9a"'), "above the retired card");
  // Requirements no journey proves: listed on QUALITY.html and at the top of CUJs.html, only when there are any.
  const nj = render(copy((d) => sub(d, "CUJs.md", "Proves: R4\n", "Proves: R4\nRetired: 2026-01-01 - merged\n")));
  for (const p of ["QUALITY.html", "CUJs.html"]) {
    const sec = nj[p].split("Requirements no journey proves")[1]?.split("</ul>")[0] ?? "";
    assert.ok(sec.includes('href="PRD.html#R4"') && sec.includes("Typing in search narrows the list"), `${p} lists R4`);
    assert.ok(!sec.includes("R3"), `${p} lists only R4`);
  }
  assert.ok(nj["CUJs.html"].indexOf("Requirements no journey proves") < nj["CUJs.html"].indexOf('id="CUJ-1"'), "at the top of CUJs.html");
  assert.ok(!qual.includes("no journey proves") && !cujs.includes("no journey proves"), "no list when every requirement has a journey");
  // Every document field that reaches a page is escaped. Each field gets its own marker; a folder or file name
  // cannot hold "/", so there the marker is not closed.
  let n = 0;
  const marks = [];
  const mk = (close = true) => { const m = `MARK-${++n}`; marks.push(m); return `<u>${m}${close ? "</u>" : ""}`; };
  const planted = copy((d) => {
    const r = path.join(d, "reports/2026-01-02");
    sub(d, "INVENTORY.md", '## S1 · NotesListFragment · "Notes"', `## S1 · Src${mk()} · "Notes${mk()}"`);
    sub(d, "INVENTORY.md", '| C6 | description "Share" | hands the note text to the share sheet | app/src/main/java/notes/EditorFragment.kt:141 | | ? |', `| C6 | ${mk()} | ${mk()} | ${mk()} | ${mk()} | ? ${mk()} |`);
    sub(d, "PRD.md", "# Notes PRD\n", `# Notes PRD ${mk()}\n`);
    sub(d, "PRD.md", "## Goal\nKeep short notes on the phone.", `## Goal ${mk()}\nKeep short notes ${mk()} &lt;b&gt; it's`);
    sub(d, "PRD.md", "### F1 · Notes · P0\n", `### F1 · Notes${mk()} · P0\nWhat: ${mk()}\n`);
    sub(d, "PRD.md", "- R1 · A saved note appears in the list with its title.", `- R1 · A saved note ${mk()}`);
    sub(d, "PRD.md", "  Caps: C4\n  Proof: kept\n", `  Caps: C4, ${mk()}\n  Proof: kept\n  Why: ${mk()}\n`);
    sub(d, "PRD.md", "  Proof: screen\n", `  Proof: screen${mk()}\n`);
    sub(d, "PRD.md", "an empty title leaves", `an empty ${mk()} title leaves`);
    fs.appendFileSync(path.join(d, "PRD.md"), `- Non-goal: C6 · ${mk()}\n`);
    sub(d, "CUJs.md", "# Notes CUJs\n", `# Notes CUJs\n\n${mk()}\n`);
    sub(d, "CUJs.md", "## F1 · Notes\n", `## F1 · Notes\n${mk()}\n`);
    sub(d, "CUJs.md", "Write a note and find it again", `Write a note${mk()}`);
    sub(d, "CUJs.md", "Proves: R1, R2\n", `Proves: R1, R2, ${mk()}\n`);
    sub(d, "CUJs.md", "Proves: R4\n", "Proves: R3\n");
    sub(d, "PRD.md", "Typing in search narrows", `Typing ${mk()} narrows`);
    sub(d, "CUJs.md", "- The note shows in the list.", `- The note shows ${mk()}\n- and stays ${mk()}`);
    fs.appendFileSync(path.join(d, "CUJs.md"), `\n### CUJ-9 · Old · P2 · phone\nRetired: ${mk()}\n\n## Robustness\n- ${mk()}\n`);
    sub(d, "TESTCASES.md", "# Notes test cases\n", `# Notes test cases\n\n${mk()}\n`);
    sub(d, "TESTCASES.md", "A saved note is still there", `A saved note ${mk()}`);
    sub(d, "TESTCASES.md", '1. Tap "New note", type a title, tap "Save".', `1. Tap ${mk()}\n2. Then ${mk()}`);
    sub(d, "TESTCASES.md", "Feature: F1 · Type: negative", `Feature: F1 · Type: negative${mk()}`);
    sub(d, "TESTCASES.md", "Tier: core · Depth: screen\nRun mode: task", `Tier: core${mk()} · Depth: screen\nRun mode: task${mk()}`);
    fs.appendFileSync(path.join(d, "TESTCASES.md"), `\n### TC-9a · P2 · Old\nRetired: ${mk()}\n\n## Gaps\n${mk()}\n- Gap: R2.f1 · ${mk()}\n`);
    sub(d, "reports/2026-01-02/REPORT.md", "shows `a | b` blank", `shows ${mk()}`);
    sub(d, "reports/2026-01-02/REPORT.md", "| P1 | Saving with no connection keeps the text |", `| P1 | Saving ${mk()} |`);
    sub(d, "reports/2026-01-02/REPORT.md", "| 12 | 2026-01-02 |", `| 12 ${mk()} | 2026-01-02 |`);
    fs.appendFileSync(path.join(d, "reports/2026-01-02/REPORT.md"), `\n${mk()}\n`);
    fs.copyFileSync(path.join(r, "TC-1a.png"), path.join(r, `TC-1a-${mk(false)}.png`));
    const odd = path.join(d, `reports/zz${mk(false)}`);
    fs.mkdirSync(odd);
    fs.writeFileSync(path.join(odd, "REPORT.md"), "| Case | Result |\n| --- | --- |\n");
    // The verifier's ledger: a verdict reason (TC-3b is stale here, so its card and history show it) and a row's
    // item cell, which an unreadable row's problem message names. By, verdict, attempt and date are read only
    // from fixed words, numbers and calendar dates: a row with anything else there is rejected and never shown.
    fs.appendFileSync(path.join(d, "VERIFY.md"), `| TC-3b | 1 | repair | independent | 0123456789abcdef | 2026-11-17 | R4: ${mk()} |\n| ${mk()} | 2 | repair | independent | 0123456789abcdef | 2026-11-17 | r |\n`);
  });
  const hp = render(planted);
  for (const [p, h] of Object.entries(hp)) assert.ok(!h.includes("<u>"), `raw <u> on ${p}`);
  const all = Object.values(hp).join("");
  assert.deepEqual(marks.filter((m) => !all.includes(`&lt;u&gt;${m}`)), [], "every planted field is on a page, escaped");
  assert.ok(all.includes("&amp;lt;b&amp;gt;") && all.includes("it&#39;s"), "& and ' escaped too");
  // Screenshots: a link is never read, whether it leads outside the folder or to a document inside it.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-html-out-"));
  tmps.push(outside);
  fs.writeFileSync(path.join(outside, "secret.png"), "outside-secret-bytes");
  const linked = copy((d) => {
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(d, "reports/2026-01-02/TC-1b.png"));
    fs.symlinkSync(path.join(d, "PRD.md"), path.join(d, "reports/2026-01-02/TC-1c.png"));
  });
  const lr = render(linked)["reports/2026-01-02/REPORT.html"];
  for (const f of [path.join(outside, "secret.png"), path.join(linked, "PRD.md")]) assert.ok(!lr.includes(fs.readFileSync(f).toString("base64")), `${f} not embedded`);
  assert.equal((lr.match(/data:image\/png;base64,/g) ?? []).length, 1, "only TC-1a.png");
  // Screenshot ids: TC-10's shot is not TC-1's, and a retired case's shot is not embedded.
  const ids = render(copy((d) => {
    fs.appendFileSync(path.join(d, "TESTCASES.md"), "\n### TC-1 · P1 · One\nFeature: F1 · Type: happy\nCovers: R1\nTier: core · Depth: screen\nRun mode: phone\n");
    sub(d, "TESTCASES.md", "Run mode: task", "Run mode: task\nRetired: 2026-01-01 - merged");
    for (const f of ["TC-1.png", "TC-10.png", "TC-10-a.png", "TC-1c.png"]) fs.copyFileSync(path.join(d, "reports/2026-01-02/TC-1a.png"), path.join(d, "reports/2026-01-02", f));
  }))["reports/2026-01-02/REPORT.html"];
  assert.deepEqual([...ids.matchAll(/<span class="muted">([^<]*)<\/span><\/figcaption>/g)].map((m) => m[1]), ["TC-1.png", "TC-1a.png"]);
  console.log("e2e-html ok");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
