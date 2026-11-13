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
  assert.ok(!gapPages["TESTCASES.html"].includes("Gap:"), "gap lines are not shown as case text");
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
  // A reopen row reads "reopened".
  const reopened = render(copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-3a | 0 | reopen | independent | 38f398cb4a7e8d60 | 2026-11-17 | The user allowed three more tries. |\n")));
  assert.ok(cardOf(reopened["TESTCASES.html"], "TC-3a").includes("reopened") && cardOf(reopened["TESTCASES.html"], "TC-3a").includes("The user allowed three more tries."));
  // QUALITY.html: approved tiles lead, with-a-case numbers are secondary text; Verifier section.
  assert.ok(/1 of 6<\/b><small>controls have an approved case[^]*?4 of 6 have a case/.test(qual), "capabilities tile");
  assert.ok(/1 of 4<\/b><small>requirements have an approved case[^]*?3 of 4 have a case/.test(qual));
  assert.ok(qual.includes("requirements tested deep enough by approved cases") && qual.includes("failures have an approved case") && qual.includes("2 of 3 have a case"));
  assert.ok(!qual.includes("<small>capabilities have a case") && !qual.includes("<small>failures have a case"), "no separate with-a-case tiles");
  const ver = qual.slice(qual.indexOf('id="verifier"'));
  assert.ok(ver.includes("approved") && ver.includes("independent agent") && ver.includes("same agent"));
  assert.ok(ver.includes('href="TESTCASES.html#TC-1c"') && ver.includes("Expected only checks the screen title") && ver.includes("Not judged yet"));
  assert.ok(qual.includes("not a run"), "approval is of a design, not a run");
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
  // Invalid: an unreadable ledger row for the case.
  const inv = render(copy((d) => fs.appendFileSync(path.join(d, "VERIFY.md"), "| TC-3b | 1 | maybe | same | x | y | z |\n")));
  chipOf(inv["TESTCASES.html"], "TC-3b", "fail", "invalid");
  assert.ok(cardOf(inv["TESTCASES.html"], "TC-3b").includes("VERIFY.md line"));
  // Setup cases get no verifier chip.
  assert.ok(!card.includes("unverified") && !card.includes("approved"), "setup: no verifier chip");
  // New verdicts mark every page stale: VERIFY.md is one of the hashed sources.
  const vdir = copy();
  write(vdir, render(vdir));
  assert.deepEqual(stalePages(vdir), []);
  fs.writeFileSync(path.join(vdir, "v.jsonl"), JSON.stringify({ id: "TC-3b", verdict: "approved", by: "independent", reason: "R4: a no-match search that shows the list is rejected." }) + "\n");
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
  assert.ok(qual.includes("2 of 4 tested deep enough by any case") && qual.includes("<th>Controls: approved / with a case</th>"), "tile secondary text and table headers");
  assert.ok(!/capabilit/i.test(qual.replace(/<style>[^]*?<\/style>/, "").replace(/<[^>]*>/g, " ")), "people-facing text says controls");
  console.log("e2e-html ok");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
