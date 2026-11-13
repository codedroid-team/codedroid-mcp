// Renders the e2e model and its quality counts as five self-contained HTML pages (no script, no remote asset).
// renderPages returns { relativePath: html } and writes nothing; it only reads files under model.dir.
// Everything that came from a file goes through esc() or the block formatter; agent-written links are shown as text.
import fs from "node:fs";
import path from "node:path";
import { readE2e } from "./e2e-model.js";
import { quality } from "./e2e-quality.js";
import { CSS } from "./e2e-html-style.js";
import { esc, inline, md } from "./e2e-markdown.js";

const PRD = "PRD.html", CUJS = "CUJs.html", TCS = "TESTCASES.html", QUAL = "QUALITY.html";
const chip = (t, kind = "") => `<span class="chip ${kind}">${esc(t)}</span>`;
const bar = (n, d) => `<div class="bar"><span style="width:${d ? Math.round((100 * n) / d) : 0}%"></span></div>`;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const tr = (cells, attr = "") => `<tr${attr}>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

const sources = (model) => esc(Object.entries(model.files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, f]) => `${n}:${f.sha256}`).join(" "));
// Only a path of the shape the model accepts becomes a page name (and so a key and an href).
const reportPage = (model) => (/^reports\/[A-Za-z0-9._-]+\/REPORT\.md$/.test(model.results.report ?? "") ? model.results.report.replace(/\.md$/, ".html") : null);
const pagePaths = (model) => [PRD, CUJS, TCS, QUAL, ...(reportPage(model) ? [reportPage(model)] : [])];

/** The lines under a heading (line is the heading's 1-based number) up to the next heading, labels set off. */
function section(model, name, line, drop) {
  const f = model.files[name];
  if (!f) return "";
  const out = [];
  let fence = false;
  for (const t of fs.readFileSync(f.path, "utf8").split(/\r?\n/).slice(line)) {
    if (/^\s*```/.test(t)) fence = !fence;
    else if (!fence && /^#{1,3} /.test(t)) break;
    else if (!fence && drop.test(t)) continue;
    out.push(fence || /^\s*```/.test(t) ? t : t.replace(/^(Start|Steps|Expected|Cleanup|User action):/, "\n**$1:**"));
  }
  return md(out.join("\n"), { base: 3 });
}

/** The PRD's own prose: everything except the feature blocks and the title. */
function prdProse(model) {
  const f = model.files["PRD.md"];
  if (!f) return { title: "Product requirements", html: "" };
  const keep = [];
  let skip = false, fence = false, title = null;
  for (const t of fs.readFileSync(f.path, "utf8").split(/\r?\n/)) {
    if (/^\s*```/.test(t)) fence = !fence;
    else if (!fence) {
      if (/^### F\d+ · /.test(t)) { skip = true; continue; }
      if (/^#{1,2} /.test(t)) skip = false;
      if (title === null && /^# /.test(t)) { title = t.slice(2).trim(); continue; }
    }
    if (!skip) keep.push(t);
  }
  const text = keep.join("\n").replace(/^## Features\s*$(?=(?:\s*\n)*(?:#|$(?![\s\S])))/m, "");
  return { title: title ?? "Product requirements", html: md(text, { base: 1 }) };
}

export function renderPages(model, q) {
  const byCase = model.results.byCase;
  const hasReport = !!model.results.report;
  const caps = new Map(model.capabilities.map((c) => [c.id, c]));
  const screens = new Map(model.screens.map((s) => [s.id, s]));
  const reqs = new Map(model.requirements.map((r) => [r.id, r]));
  const inFeature = new Set(model.requirements.flatMap((r) => r.caps));
  const untested = new Map(q.untested.map((u) => [u.id, u.why]));
  const home = new Map([
    ...model.capabilities.map((c) => [c.id, inFeature.has(c.id) ? PRD : QUAL]),
    ...model.screens.map((s) => [s.id, QUAL]),
    ...model.cujs.map((j) => [j.id, CUJS]),
    ...model.cases.map((c) => [c.id, TCS]),
    ...model.features.map((f) => [f.id, PRD]),
    ...model.requirements.flatMap((r) => [[r.id, PRD], ...r.fails.map((f) => [f.id, PRD])]),
  ]);
  const casesFor = (ref) => model.cases.filter((c) => c.covers.some((e) => e.ref === ref));
  const result = (id) => {
    const r = byCase[id] ?? (hasReport ? "not run" : null);
    return r ? chip(r, r === "pass" ? "pass" : r === "fail" ? "fail" : "warn") : "";
  };
  const notVerified = chip("not verified");
  const pending = (name) => (model.pending.includes(name) ? `<p class="muted">${name} is not written yet.</p>` : "");

  // One page's chrome. `cur` is its file name, `root` the path back to the e2e folder.
  const frame = (cur, root, title, body) => {
    const link = (id) => {
      const f = home.get(id);
      if (!f) return `<span>${esc(id)}</span>`;
      return `<a class="nw" href="${f === cur ? "" : esc(root + f)}#${esc(id)}">${esc(id)}</a>`;
    };
    const rp = reportPage(model);
    const nav = [[QUAL, "Quality"], [PRD, "PRD"], [CUJS, "CUJs"], [TCS, "Test cases"]]
      .map(([f, label]) => `<a href="${esc(root + f)}"${f === cur ? ' aria-current="page"' : ""}>${label}</a>`);
    nav.push(rp ? `<a href="${esc(rp === cur ? path.basename(rp) : root + rp)}"${rp === cur ? ' aria-current="page"' : ""}>Report</a>` : "<span>Report (none yet)</span>");
    const banner = q.ok ? "" : `<p class="banner" role="alert">The documents have problems, so the counts may be wrong. <a href="${cur === QUAL ? "" : esc(root + QUAL)}#problems">See the ${q.problems.length} problem${q.problems.length === 1 ? "" : "s"}</a>.</p>`;
    return {
      link,
      html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="e2e-sources" content="${sources(model)}">
<style>${CSS}</style></head>
<body><header class="top"><nav aria-label="Pages">${nav.join("")}</nav></header>
<main>${banner}${body(link)}</main>
<footer>Built from the e2e folder. The counts describe the documents; nothing here has been verified yet.</footer>
</body></html>
`,
    };
  };
  const page = (cur, root, title, body) => frame(cur, root, title, body).html;

  const capLine = (link, c) => {
    const s = screens.get(c.screen);
    return `${link(c.id)} ${inline(c.control)}${s ? ` <span class="muted">on &ldquo;${esc(s.title)}&rdquo;</span>` : ""}`;
  };
  const caseLine = (link, c) => `<li>${link(c.id)} ${esc(c.title)} ${c.mode === "manual" ? chip("manual") : ""} ${result(c.id)}</li>`;
  const caseList = (link, cs) => (cs.length ? `<ul class="plain">${cs.map((c) => caseLine(link, c)).join("")}</ul>` : chip("no case", "warn"));
  const featureOf = (id) => model.features.find((f) => f.id === id);

  const prd = page(PRD, "", "PRD", (link) => {
    const { title, html } = prdProse(model);
    const seen = new Set();
    const featureCard = (f, rs) => {
      const k = q.by_feature.find((x) => x.id === f?.id)?.requirements;
      const idAttr = f ? ` id="${esc(f.id)}"` : "";
      return `<section class="card"${idAttr}><div class="head"><h2>${f ? `${esc(f.id)} · ${esc(f.name)}` : "Requirements outside a feature"}</h2><span class="chips">${f ? chip(f.priority) : ""}${notVerified}</span></div>
${k ? `<p class="muted">${k.with_case} of ${k.total} requirements have a case, ${k.at_depth} tested deep enough.</p>` : ""}
${rs.map((r) => reqCard(r)).join("\n")}</section>`;
    };
    const reqCard = (r) => {
      const cs = casesFor(r.id);
      const capsHtml = r.caps.map((id) => {
        const c = caps.get(id);
        if (!c) return `<li>${link(id)}</li>`;
        const first = !seen.has(id);
        seen.add(id);
        return `<li${first ? ` id="${esc(id)}"` : ""}>${capLine(link, c)} <span class="muted">&mdash; ${inline(c.does)}</span></li>`;
      });
      const fails = r.fails.map((f) => `<li id="${esc(f.id)}">${link(f.id)} ${inline(f.text)} ${casesFor(f.id).length ? casesFor(f.id).map((c) => link(c.id)).join(" ") : chip("no case", "warn")}</li>`);
      return `<article class="card" id="${esc(r.id)}"><div class="head"><h3>${esc(r.id)}</h3><span class="chips">${chip(`proof: ${r.proof ?? "?"}`)}${cs.length ? "" : chip("no case", "warn")}${notVerified}</span></div>
<p>${inline(r.text)}</p>
<dl class="meta"><dt>Controls</dt><dd>${capsHtml.length ? `<ul class="plain">${capsHtml.join("")}</ul>` : '<span class="muted">none listed</span>'}</dd>
<dt>Cases</dt><dd>${caseList(link, cs)}</dd>
<dt>Can fail when</dt><dd>${fails.length ? `<ul class="plain">${fails.join("")}</ul>` : '<span class="muted">none in source</span>'}</dd></dl></article>`;
    };
    const loose = model.requirements.filter((r) => !featureOf(r.feature));
    return `<h1>${esc(title)}</h1>
${pending("PRD.md")}<p class="lede">${model.features.length} features, ${model.requirements.length} requirements, ${q.failures.total} ways they can fail.</p>
${html ? `<section class="prose">${html}</section>` : ""}
${model.features.map((f) => featureCard(f, model.requirements.filter((r) => r.feature === f.id))).join("\n")}
${loose.length ? featureCard(null, loose) : ""}`;
  });

  const cujs = page(CUJS, "", "Critical user journeys", (link) => {
    const card = (j) => {
      const qj = q.by_cuj.find((x) => x.id === j.id);
      const cs = qj.cases.map((id) => model.cases.find((c) => c.id === id));
      return `<article class="card" id="${esc(j.id)}"><div class="head"><h3>${esc(j.id)} · ${esc(j.title)}</h3><span class="chips">${chip(j.priority)}${chip(`mode: ${j.mode}`)}${notVerified}</span></div>
<dl class="meta"><dt>Proves</dt><dd>${j.proves.length ? `<ul class="plain">${j.proves.map((id) => `<li>${link(id)} ${reqs.has(id) ? inline(reqs.get(id).text) : ""}</li>`).join("")}</ul>` : '<span class="muted">nothing listed</span>'}</dd>
<dt>Cases</dt><dd>${caseList(link, cs)}</dd></dl>
${section(model, "CUJs.md", j.line, /^Proves:/)}</article>`;
    };
    const groups = [...model.features.map((f) => [f, model.cujs.filter((j) => j.feature === f.id)]), [null, model.cujs.filter((j) => !featureOf(j.feature))]];
    return `<h1>Critical user journeys</h1>
${pending("CUJs.md")}<p class="lede">${model.cujs.length} journeys, each tied to the requirements it proves and the cases that run it.</p>
${groups.filter(([, js]) => js.length).map(([f, js]) => `<h2${f ? ` id="${esc(f.id)}"` : ""}>${f ? `${link(f.id)} · ${esc(f.name)}` : "Other journeys"}</h2>\n${js.map(card).join("\n")}`).join("\n")}`;
  });

  const tcs = page(TCS, "", "Test cases", (link) => {
    const card = (c) => {
      const j = q.by_cuj.find((x) => x.cases.includes(c.id));
      const covers = c.covers.map((e) => `${link(e.ref)}${e.caps.length ? ` (${e.caps.map(link).join(", ")})` : ""}`);
      return `<article class="card" id="${esc(c.id)}"><div class="head"><h3>${esc(c.id)} · ${esc(c.title)}</h3><span class="chips">${chip(c.priority)}${chip(c.type ?? "no type")}${chip(`tier: ${c.tier}`)}${chip(`depth: ${c.depth}`)}${chip(`mode: ${c.mode}`)}${result(c.id)}${notVerified}</span></div>
<dl class="meta"><dt>Covers</dt><dd>${covers.join(", ") || '<span class="muted">nothing</span>'}</dd>${j ? `<dt>Journey</dt><dd>${link(j.id)}</dd>` : ""}</dl>
${section(model, "TESTCASES.md", c.line, /^(Feature|Covers|Tier|Run mode):/)}</article>`;
    };
    const groups = [...model.features.map((f) => [f, model.cases.filter((c) => c.feature === f.id)]), [null, model.cases.filter((c) => !featureOf(c.feature))]];
    return `<h1>Test cases</h1>
${pending("TESTCASES.md")}<p class="lede">${q.cases.total} cases: ${q.cases.by_mode.phone} phone, ${q.cases.by_mode.task} task, ${q.cases.by_mode.manual} manual.${hasReport ? "" : " No report yet, so no results."}</p>
${groups.filter(([, cs]) => cs.length).map(([f, cs]) => `<h2${f ? ` id="${esc(f.id)}"` : ""}>${f ? `${link(f.id)} · ${esc(f.name)}` : "Other cases"}</h2>\n${cs.map(card).join("\n")}`).join("\n")}`;
  });

  const qual = page(QUAL, "", "Test quality", (link) => {
    const c = q.capabilities;
    const tile = (label, n, d, text) => `<div class="tile"><b>${text ?? `${n} of ${d}`}</b><small>${esc(label)}${text ? "" : ` (${pct(n, d)})`}</small>${text ? "" : bar(n, d)}</div>`;
    const problems = q.problems.length
      ? `<section class="card problems" id="problems"><h2>${q.problems.length} problem${q.problems.length === 1 ? "" : "s"} in the documents</h2><p class="muted">Fix these first; the counts below may be wrong until they are fixed.</p><ul>${q.problems.map((p) => `<li><code>${esc(p.file)}${p.line ? `:${p.line}` : ""}</code> ${esc(p.message)}</li>`).join("")}</ul></section>`
      : `<p id="problems" class="muted">No problems found in the documents.</p>`;
    const rows = new Map();
    for (const u of q.untested) rows.set(caps.get(u.id).screen, [...(rows.get(caps.get(u.id).screen) ?? []), u]);
    const gaps = q.untested.length
      ? [...rows].map(([sid, us]) => { const s = screens.get(sid); return `<h3><a href="#${esc(sid)}">${esc(sid)}</a> · ${s ? `${esc(s.title)} <span class="muted">${esc(s.source)}</span>` : ""}</h3>${table(["Id", "Control", "Why"], us.map((u) => tr([link(u.id), inline(u.control), esc(u.why)])))}`; }).join("\n")
      : "<p>Every capability has a case.</p>";
    const inventory = model.screens.map((s) => `<section id="${esc(s.id)}"><h3>${esc(s.id)} · ${esc(s.title)} <span class="muted">${esc(s.source)}</span></h3>${table(["Id", "Control", "Does", "Source", "States", "Seen"],
      model.capabilities.filter((x) => x.screen === s.id).map((x) => {
        const mark = untested.has(x.id) ? `<br>${chip(untested.get(x.id), "warn")}` : "";
        const idCell = inFeature.has(x.id) ? link(x.id) : esc(x.id);
        return tr([idCell + mark, inline(x.control), inline(x.does), inline(x.source), inline(x.states), inline(x.seen)], inFeature.has(x.id) ? "" : ` id="${esc(x.id)}"`);
      }))}</section>`).join("\n");
    return `<h1>Test quality</h1>
<p class="lede">${chip("not verified")} These are counts of the documents, not test results.</p>
${model.pending.length ? `<p class="muted">Not written yet: ${model.pending.join(", ")}.</p>` : ""}
${problems}
<div class="tiles">
${tile("capabilities have a case", c.with_case, c.total)}
${tile("capabilities are in a feature", c.in_feature, c.total)}
${tile("requirements have a case", q.requirements.with_case, q.requirements.total)}
${tile("requirements tested deep enough", q.requirements.at_depth, q.requirements.total)}
${tile("failures have a case", q.failures.with_case, q.failures.total)}
${tile("capabilities exercised in the last report", c.exercised, c.total)}
${tile("capabilities passing in the last report", c.passing, c.total)}
${tile("capabilities not seen on the phone", 0, 0, `${c.not_seen} of ${c.total}`)}
${tile("cases", 0, 0, `${q.cases.total}`)}
</div>
<h2>Not covered by a runnable case</h2>
${gaps}
<h2>By feature</h2>
${table(["Feature", "Controls with a case", "Exercised in report", "Passing in report", "Requirements with a case", "Tested deep enough", "Failures with a case", "Cases smoke / core / deep / edge"],
      q.by_feature.map((f) => { const k = f.capabilities, r = f.requirements, t = f.tiers; return tr([`${link(f.id)} · ${esc(f.name)} ${chip(f.priority)}`, pct(k.with_case, k.total), pct(k.exercised, k.total), pct(k.passing, k.total), pct(r.with_case, r.total), pct(r.at_depth, r.total), pct(f.failures.with_case, f.failures.total), `${t.smoke}/${t.core}/${t.deep}/${t.edge}`]); }))}
<h2>By journey</h2>
${table(["Journey", "Requirements", "Cases", "Controls with a case", "Exercised in report", "Passing in report"],
      q.by_cuj.map((j) => { const k = j.capabilities; return tr([`${link(j.id)} · ${esc(j.title)}`, j.requirements.map(link).join(", "), String(j.cases.length), pct(k.with_case, k.total), pct(k.exercised, k.total), pct(k.passing, k.total)]); }))}
<h2>All controls by screen</h2>
${inventory}`;
  });

  const pages = { [PRD]: prd, [CUJS]: cujs, [TCS]: tcs, [QUAL]: qual };
  const rp = reportPage(model);
  if (rp) {
    const f = model.files[model.results.report];
    const date = path.basename(path.dirname(model.results.report));
    const dir = path.dirname(f.path);
    const ids = model.cases.map((c) => c.id).sort((a, b) => b.length - a.length);
    const shots = new Map();
    for (const name of fs.readdirSync(dir).sort()) {
      const ext = path.extname(name).toLowerCase();
      const stem = name.slice(0, -ext.length);
      const id = ids.find((x) => stem === x || stem.startsWith(`${x}-`) || stem.startsWith(`${x}_`));
      if (!MIME[ext] || !id || !fs.lstatSync(path.join(dir, name)).isFile()) continue;
      shots.set(id, [...(shots.get(id) ?? []), { name, uri: `data:${MIME[ext]};base64,${fs.readFileSync(path.join(dir, name)).toString("base64")}` }]);
    }
    pages[rp] = page(rp, "../../", `Test report ${date}`, (link) => {
      const n = (r) => Object.values(byCase).filter((x) => x === r).length;
      const failed = model.cases.filter((c) => byCase[c.id] === "fail");
      let k = 0;
      const figs = [...shots].map(([id, list]) => list.map(({ name, uri }) => { k++; return `<figure><figcaption>${link(id)} ${result(id)} <span class="muted">${esc(name)}</span></figcaption>
<input type="checkbox" class="zoom" id="zoom${k}" aria-label="Show ${esc(name)} full size"><label for="zoom${k}"><img src="${uri}" alt="Screenshot ${esc(name)}"></label></figure>`; }).join("")).join("\n");
      return `<h1>Test report ${esc(date)}</h1>
<p class="lede"><span class="chips">${chip(`${n("pass")} pass`, "pass")}${chip(`${n("fail")} fail`, n("fail") ? "fail" : "")}${chip(`${n("not run")} not run`, n("not run") ? "warn" : "")}${notVerified}</span></p>
${failed.length ? `<section class="card problems"><h2>Failed cases</h2><ul class="plain">${failed.map((c) => `<li>${link(c.id)} ${esc(c.title)} ${result(c.id)}</li>`).join("")}</ul></section>` : ""}
<section class="prose">${md(fs.readFileSync(f.path, "utf8"), { base: 1 })}</section>
<h2>Screenshots</h2>
${figs ? `<p class="muted">Click a screenshot to show it full size, click again to shrink it.</p><div class="gallery">${figs}</div>` : '<p class="muted">No screenshots beside REPORT.md.</p>'}`;
    });
  }
  return pages;
}

/** Pages that are missing or were built from different source files than the ones on disk now. */
export function stalePages(dir) {
  const model = readE2e(dir);
  const want = `<meta name="e2e-sources" content="${sources(model)}">`;
  return pagePaths(model).filter((rel) => {
    try { return !fs.readFileSync(path.join(dir, rel), "utf8").includes(want); } catch { return true; }
  });
}
