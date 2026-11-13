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
  assert.ok(prd.includes("not verified"));
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
  console.log("e2e-html ok");
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
