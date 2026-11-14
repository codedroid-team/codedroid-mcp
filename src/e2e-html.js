// Renders the e2e model and its quality counts as five self-contained HTML pages (no script, no remote asset).
// renderPages returns { relativePath: html } and writes nothing; it only reads files under model.dir.
// Everything that came from a file goes through esc() or the block formatter; agent-written links are shown as text.
import crypto from "node:crypto";
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
const TONE = { approved: "pass", repair: "warn", unresolved: "warn", question: "ask", invalid: "fail" };
const who = (by) => (by === "independent" ? "independent agent" : by === "same" ? "same agent" : by === "user" ? "the user" : "");
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// `extra` is more [name, sha256] pairs for a page, such as the screenshots a report page embeds.
const sources = (model, extra = []) => esc([...Object.entries(model.files).map(([n, f]) => [n, f.sha256]), ...extra].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, h]) => `${n}:${h}`).join(" "));
// Only a path of the shape the model accepts becomes a page name (and so a key and an href).
const reportPage = (model) => (/^reports\/[A-Za-z0-9._-]+\/REPORT\.md$/.test(model.results.report ?? "") ? model.results.report.replace(/\.md$/, ".html") : null);
/** The screenshots beside the used report that belong to a case: { id, name, buf }, by file name. A link is never read. */
function screenshots(model) {
  const f = model.files[model.results.report];
  if (!f) return [];
  const dir = path.dirname(f.path);
  const ids = model.cases.filter((c) => c.retired === null).map((c) => c.id).sort((a, b) => b.length - a.length);
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const ext = path.extname(name).toLowerCase();
    const stem = name.slice(0, -ext.length);
    const id = ids.find((x) => stem === x || stem.startsWith(`${x}-`) || stem.startsWith(`${x}_`));
    if (!MIME[ext] || !id || !fs.lstatSync(path.join(dir, name)).isFile()) continue;
    out.push({ id, name, buf: fs.readFileSync(path.join(dir, name)) });
  }
  return out;
}
const shotSources = (model, shots) => shots.map(({ name, buf }) => [`${path.dirname(model.results.report)}/${name}`, crypto.createHash("sha256").update(buf).digest("hex")]);
const pagePaths = (model) => [PRD, CUJS, TCS, QUAL, ...(reportPage(model) ? [reportPage(model)] : [])];

/** The lines under a heading (line is the heading's 1-based number) up to the next heading, labels set off. */
function section(model, name, line, drop) {
  const f = model.files[name];
  if (!f) return "";
  const out = [];
  let fence = false;
  for (const t of f.text.split(/\r?\n/).slice(line)) {
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
  for (const t of f.text.split(/\r?\n/)) {
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
  const casesFor = (ref) => model.cases.filter((c) => c.retired === null && c.covers.some((e) => e.ref === ref));
  const result = (id) => {
    const r = byCase[id] ?? (hasReport ? "not run" : null);
    return r ? chip(r, r === "pass" ? "pass" : r === "fail" ? "fail" : "warn") : "";
  };
  // The verifier's word for a case: a chip, and who judged on which attempt. Setup and retired cases have none.
  const verdictChip = (c) => (c.verify ? chip(c.verify.status, TONE[c.verify.status] ?? "") : "");
  const verdictBy = (c) => (c.verify?.by ? `<small class="by">${esc(who(c.verify.by))}${c.verify.attempt ? `, attempt ${c.verify.attempt}` : ""}</small>` : "");
  const verdictBlock = (c) => {
    const v = c.verify;
    if (!v || v.status === "approved") return "";
    const last = v.history.filter((h) => h.verdict !== "reopen").at(-1);
    const text = v.status === "unverified" ? "Not judged yet"
      : v.status === "stale" ? `Changed since it was judged. Before that: ${last.verdict}, ${last.reason}`
      : v.reason;
    return `<p class="verdict ${TONE[v.status] ?? ""}"><b>Verifier:</b> ${esc(text)}</p>`;
  };
  const verdictHistory = (c) => {
    const h = c.verify?.history ?? [];
    if (!h.length) return "";
    const row = (r) => `<li>${r.verdict === "reopen" ? "<b>reopened</b>" : `attempt ${r.attempt}, <b>${esc(r.verdict)}</b>`} <span class="muted">${esc(who(r.by))}, ${esc(r.date)}</span><br>${esc(r.reason)}</li>`;
    return `<details class="history"><summary>Verdict history (${h.length})</summary><ol>${h.map(row).join("")}</ol></details>`;
  };
  const pending = (name) => (model.pending.includes(name) ? `<p class="muted">${name} is not written yet.</p>` : "");

  // One page's chrome. `cur` is its file name, `root` the path back to the e2e folder.
  const frame = (cur, root, title, body, extra = []) => {
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
<meta name="e2e-sources" content="${sources(model, extra)}">
<style>${CSS}</style></head>
<body><header class="top"><nav aria-label="Pages">${nav.join("")}</nav></header>
<main>${banner}${body(link)}</main>
<footer>Built from the e2e folder. The counts describe the documents, not test runs; the verifier approves a test's design, not a run.</footer>
</body></html>
`,
    };
  };
  const page = (cur, root, title, body, extra) => frame(cur, root, title, body, extra).html;

  const capLine = (link, c) => {
    const s = screens.get(c.screen);
    return `${link(c.id)} ${inline(c.control)}${s ? ` <span class="muted">on &ldquo;${esc(s.title)}&rdquo;</span>` : ""}`;
  };
  const caseLine = (link, c) => `<li>${link(c.id)} ${esc(c.title)} ${c.mode === "manual" ? chip("manual") : ""} ${result(c.id)} ${verdictChip(c)}</li>`;
  const caseList = (link, cs) => (cs.length ? `<ul class="plain">${cs.map((c) => caseLine(link, c)).join("")}</ul>` : chip("no case", "warn"));
  const featureOf = (id) => model.features.find((f) => f.id === id);

  const prd = page(PRD, "", "PRD", (link) => {
    const { title, html } = prdProse(model);
    const seen = new Set();
    const featureCard = (f, rs) => {
      const k = q.by_feature.find((x) => x.id === f?.id)?.requirements;
      const idAttr = f ? ` id="${esc(f.id)}"` : "";
      return `<section class="card"${idAttr}><div class="head"><h2>${f ? `${esc(f.id)} · ${esc(f.name)}` : "Requirements outside a feature"}</h2><span class="chips">${f ? chip(f.priority) : ""}</span></div>
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
      const fails = r.fails.map((f) => `<li id="${esc(f.id)}">${link(f.id)} ${inline(f.text)} ${casesFor(f.id).length ? casesFor(f.id).map((c) => `${link(c.id)} ${verdictChip(c)}`).join(" ") : chip("no case", "warn")}</li>`);
      return `<article class="card" id="${esc(r.id)}"><div class="head"><h3>${esc(r.id)}</h3><span class="chips">${chip(`proof: ${r.proof ?? "?"}`)}${cs.length ? "" : chip("no case", "warn")}</span></div>
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
      return `<article class="card" id="${esc(j.id)}"><div class="head"><h3>${esc(j.id)} · ${esc(j.title)}</h3><span class="chips">${chip(j.priority)}${chip(`mode: ${j.mode}`)}</span></div>
<dl class="meta"><dt>Proves</dt><dd>${j.proves.length ? `<ul class="plain">${j.proves.map((id) => `<li>${link(id)} ${reqs.has(id) ? inline(reqs.get(id).text) : ""}</li>`).join("")}</ul>` : '<span class="muted">nothing listed</span>'}</dd>
<dt>Cases</dt><dd>${caseList(link, cs)}</dd></dl>
${section(model, "CUJs.md", j.line, /^Proves:/)}</article>`;
    };
    const live = model.cujs.filter((j) => j.retired === null);
    const gone = model.cujs.filter((j) => j.retired !== null);
    const groups = [...model.features.map((f) => [f, live.filter((j) => j.feature === f.id)]), [null, live.filter((j) => !featureOf(j.feature))]];
    const retiredCard = (j) => `<article class="card" id="${esc(j.id)}"><div class="head"><h3>${esc(j.id)} · ${esc(j.title)}</h3><span class="chips">${chip("retired")}</span></div><p class="muted">${esc(j.retired)}</p></article>`;
    return `<h1>Critical user journeys</h1>
${pending("CUJs.md")}<p class="lede">${live.length} journeys, each tied to the requirements it proves and the cases that run it.${gone.length ? ` ${gone.length} retired, not counted.` : ""}</p>
${groups.filter(([, js]) => js.length).map(([f, js]) => `<h2${f ? ` id="${esc(f.id)}"` : ""}>${f ? `${link(f.id)} · ${esc(f.name)}` : "Other journeys"}</h2>\n${js.map(card).join("\n")}`).join("\n")}
${gone.length ? `<h2>Retired</h2>\n${gone.map(retiredCard).join("\n")}` : ""}`;
  });

  const tcs = page(TCS, "", "Test cases", (link) => {
    const card = (c) => {
      const j = q.by_cuj.find((x) => x.cases.includes(c.id));
      const covers = c.covers.map((e) => `${link(e.ref)}${e.caps.length ? ` (${e.caps.map(link).join(", ")})` : ""}`);
      return `<article class="card" id="${esc(c.id)}"><div class="head"><h3>${esc(c.id)} · ${esc(c.title)}</h3><span class="chips">${chip(c.priority)}${chip(c.type ?? "no type")}${c.type === "setup" ? "" : chip(`tier: ${c.tier}`) + chip(`depth: ${c.depth}`)}${chip(`mode: ${c.mode}`)}${result(c.id)}${verdictChip(c)}${verdictBy(c)}</span></div>
<dl class="meta">${c.type === "setup" ? "" : `<dt>Covers</dt><dd>${covers.join(", ") || '<span class="muted">nothing</span>'}</dd>`}${j ? `<dt>Journey</dt><dd>${link(j.id)}</dd>` : ""}</dl>
${verdictBlock(c)}
${section(model, "TESTCASES.md", c.line, /^(Feature|Covers|Tier|Run mode):/)}${verdictHistory(c)}</article>`;
    };
    const live = model.cases.filter((c) => c.retired === null);
    const gone = model.cases.filter((c) => c.retired !== null);
    const retiredCard = (c) => `<article class="card" id="${esc(c.id)}"><div class="head"><h3>${esc(c.id)} · ${esc(c.title)}</h3><span class="chips">${chip("retired")}</span></div><p class="muted">${esc(c.retired)}</p></article>`;
    const groups = [...model.features.map((f) => [f, live.filter((c) => c.feature === f.id)]), [null, live.filter((c) => !featureOf(c.feature))]];
    return `<h1>Test cases</h1>
${pending("TESTCASES.md")}<p class="lede">${q.cases.total} cases: ${q.cases.by_mode.phone} phone, ${q.cases.by_mode.task} task, ${q.cases.by_mode.manual} manual${q.cases.setup ? `, ${q.cases.setup} setup` : ""}.${gone.length ? ` ${gone.length} retired, not counted.` : ""}${hasReport ? "" : " No report yet, so no results."}</p>
${groups.filter(([, cs]) => cs.length).map(([f, cs]) => `<h2${f ? ` id="${esc(f.id)}"` : ""}>${f ? `${link(f.id)} · ${esc(f.name)}` : "Other cases"}</h2>\n${cs.map(card).join("\n")}`).join("\n")}
${gone.length ? `<h2>Retired</h2>\n${gone.map(retiredCard).join("\n")}` : ""}`;
  });

  const qual = page(QUAL, "", "Test quality", (link) => {
    const c = q.capabilities;
    const scope = c.total - c.set_aside;
    const tile = (label, n, d, text, sub) => `<div class="tile"><b>${text ?? `${n} of ${d}`}</b><small>${esc(label)}${text ? "" : ` (${pct(n, d)})`}</small>${text ? "" : bar(n, d)}${sub ? `<small class="sub">${esc(sub)}</small>` : ""}</div>`;
    // An approved tile leads; the number with any case (approved or not) is its secondary text.
    const atile = (label, a, w, d, what = "have a case") => tile(label, a, d, undefined, `${w} of ${d} ${what}`);
    const v = q.verify;
    const status = (k) => v[k] ? `<li>${chip(k, TONE[k] ?? "")} ${v[k]}</li>` : "";
    const verifier = `<h2 id="verifier">Verifier</h2>
<p class="muted">The verifier judges whether a test case's design would catch a broken app. Approval is of a design, not of a run.</p>
${v.judged ? `<ul class="plain inline">${["approved", "repair", "question", "unresolved", "stale", "unverified", "invalid"].map(status).join("")}</ul>
<p class="muted">Latest verdicts by an independent agent: ${v.by.independent}. By the same agent: ${v.by.same}.${v.approved ? ` Approved on the first attempt: ${v.approved_first}, after a repair: ${v.approved_after_repair}.` : ""}</p>
${q.not_approved.length ? `<ul class="plain">${q.not_approved.map((n) => `<li>${link(n.id)} ${chip(n.status, TONE[n.status] ?? "")} ${esc(n.reason)}</li>`).join("")}</ul>` : "<p>Every test case is approved.</p>"}` : "<p>There are no test cases to judge.</p>"}`;
    const problems = q.problems.length
      ? `<section class="card problems" id="problems"><h2>${q.problems.length} problem${q.problems.length === 1 ? "" : "s"} in the documents</h2><p class="muted">Fix these first; the counts below may be wrong until they are fixed.</p><ul>${q.problems.map((p) => `<li><code>${esc(p.file)}${p.line ? `:${p.line}` : ""}</code> ${esc(p.message)}</li>`).join("")}</ul></section>`
      : `<p id="problems" class="muted">No problems found in the documents.</p>`;
    const rows = new Map();
    for (const u of q.untested) rows.set(caps.get(u.id).screen, [...(rows.get(caps.get(u.id).screen) ?? []), u]);
    const gaps = q.untested.length
      ? [...rows].map(([sid, us]) => { const s = screens.get(sid); return `<h3><a href="#${esc(sid)}">${esc(sid)}</a> · ${s ? `${esc(s.title)} <span class="muted">${esc(s.source)}</span>` : ""}</h3>${table(["Id", "Control", "Why"], us.map((u) => tr([link(u.id), inline(u.control), esc(u.why)])))}`; }).join("\n")
      : "<p>Every control has a case.</p>";
    const rest = (o) => inline(o.what.slice(o.what.startsWith(`${o.ref} · `) ? o.ref.length + 3 : o.ref.length));
    const open = `<h2 id="open">Left open</h2>\n${q.open.length
      ? `<p class="muted">Nothing below has a runnable case that settles it, or a Gap line. Write the case or the Gap line.</p><ul class="plain">${q.open.map((o) => `<li>${link(o.ref)} ${chip(o.kind, "warn")} ${rest(o)}</li>`).join("")}</ul>`
      : "<p>Nothing is left open.</p>"}`;
    const acknowledged = q.gaps.length
      ? `<h2>Acknowledged gaps</h2>\n<ul class="plain">${q.gaps.map((g) => `<li>${link(g.ref)}${g.kind === "deep" || g.kind === "depth" ? ` ${g.kind}` : ""} <span class="muted">&mdash;</span> ${esc(g.reason)}</li>`).join("")}</ul>`
      : "";
    const asideRows = new Map();
    for (const u of q.set_aside) asideRows.set(caps.get(u.id).screen, [...(asideRows.get(caps.get(u.id).screen) ?? []), u]);
    const aside = q.set_aside.length
      ? `<h2>Set aside as non-goals</h2>\n${[...asideRows].map(([sid, us]) => { const s = screens.get(sid); return `<h3><a href="#${esc(sid)}">${esc(sid)}</a> · ${s ? `${esc(s.title)} <span class="muted">${esc(s.source)}</span>` : ""}</h3>${table(["Id", "Control", "Reason"], us.map((u) => tr([link(u.id), inline(u.control), esc(u.reason)])))}`; }).join("\n")}`
      : "";
    const asideIds = new Set(q.set_aside.map((u) => u.id));
    const inventory = model.screens.map((s) => `<section id="${esc(s.id)}"><h3>${esc(s.id)} · ${esc(s.title)} <span class="muted">${esc(s.source)}</span></h3>${table(["Id", "Control", "Does", "Source", "States", "Seen"],
      model.capabilities.filter((x) => x.screen === s.id).map((x) => {
        const mark = untested.has(x.id) ? `<br>${chip(untested.get(x.id), "warn")}` : asideIds.has(x.id) ? `<br>${chip("set aside")}` : "";
        const idCell = inFeature.has(x.id) ? link(x.id) : esc(x.id);
        return tr([idCell + mark, inline(x.control), inline(x.does), inline(x.source), inline(x.states), inline(x.seen)], inFeature.has(x.id) ? "" : ` id="${esc(x.id)}"`);
      }))}</section>`).join("\n");
    return `<h1>Test quality</h1>
<p class="lede">These are counts of the documents, not test results. ${v.judged - v.unverified ? `The verifier approved ${v.approved} of ${v.judged} test cases; approval is of a test's design, not a run.` : "No test case has been judged by the verifier yet."} ${q.report ? `Results come from ${esc(q.report)}.` : "There is no report yet, so no results."}</p>
${model.pending.length ? `<p class="muted">Not written yet: ${model.pending.join(", ")}.</p>` : ""}
${problems}
${c.set_aside ? `<p class="muted">Percentages count the ${scope} controls in scope; ${c.set_aside} set aside as non-goals.</p>` : ""}
<div class="tiles">
${atile("controls have an approved case", c.approved, c.with_case, scope)}
${atile("requirements have an approved case", q.requirements.approved, q.requirements.with_case, q.requirements.total)}
${atile("requirements tested deep enough by approved cases", q.requirements.at_depth_approved, q.requirements.at_depth, q.requirements.total, "tested deep enough by any case")}
${atile("failures have an approved case", q.failures.approved, q.failures.with_case, q.failures.total)}
${tile("controls are in a feature", c.in_feature, scope)}
${tile("requirements and failures acknowledged as gaps", 0, 0, `${q.requirements.acknowledged + q.failures.acknowledged}`)}
${tile("left open", 0, 0, `${q.open.length}`)}
${tile("controls exercised in the last report", c.exercised, scope)}
${tile("controls passing in the last report", c.passing, scope)}
${tile("controls not seen on the phone", 0, 0, `${c.not_seen} of ${scope}`)}
${tile("cases", 0, 0, `${q.cases.total}`)}
${q.cases.retired || q.cujs.retired ? tile("retired, not counted", 0, 0, `${q.cases.retired} cases, ${q.cujs.retired} journeys`) : ""}
</div>
${verifier}
${open}
${acknowledged}
<h2>Not covered by a runnable case</h2>
${gaps}
${aside}
<h2>By feature</h2>
${table(["Feature", "Controls: approved / with a case", "Requirements: approved / with a case"],
      q.by_feature.map((f) => { const k = f.capabilities, r = f.requirements; return tr([`${link(f.id)} · ${esc(f.name)} ${chip(f.priority)}`, `${pct(k.approved, k.total)} / ${pct(k.with_case, k.total)}`, `${pct(r.approved, r.total)} / ${pct(r.with_case, r.total)}`]); }))}
${table(["Feature", "Tested deep enough: approved / any case", "Failures: approved / with a case"],
      q.by_feature.map((f) => { const r = f.requirements, x = f.failures; return tr([`${link(f.id)} · ${esc(f.name)}`, `${pct(r.at_depth_approved, r.total)} / ${pct(r.at_depth, r.total)}`, `${pct(x.approved, x.total)} / ${pct(x.with_case, x.total)}`]); }))}
${table(["Feature", "Exercised in report", "Passing in report", "Cases smoke / core / deep / edge"],
      q.by_feature.map((f) => { const k = f.capabilities, t = f.tiers; return tr([`${link(f.id)} · ${esc(f.name)}`, pct(k.exercised, k.total), pct(k.passing, k.total), `${t.smoke}/${t.core}/${t.deep}/${t.edge}`]); }))}
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
    const found = screenshots(model);
    const shots = new Map();
    for (const { id, name, buf } of found) shots.set(id, [...(shots.get(id) ?? []), { name, uri: `data:${MIME[path.extname(name).toLowerCase()]};base64,${buf.toString("base64")}` }]);
    pages[rp] = page(rp, "../../", `Test report ${date}`, (link) => {
      const n = (r) => Object.values(byCase).filter((x) => x === r).length;
      const failed = model.cases.filter((c) => byCase[c.id] === "fail");
      let k = 0;
      const figs = [...shots].map(([id, list]) => list.map(({ name, uri }) => { k++; return `<figure><figcaption>${link(id)} ${result(id)} <span class="muted">${esc(name)}</span></figcaption>
<input type="checkbox" class="zoom" id="zoom${k}" aria-label="Show ${esc(name)} full size"><label for="zoom${k}"><img src="${uri}" alt="Screenshot ${esc(name)}"></label></figure>`; }).join("")).join("\n");
      return `<h1>Test report ${esc(date)}</h1>
<p class="lede"><span class="chips">${chip(`${n("pass")} pass`, "pass")}${chip(`${n("fail")} fail`, n("fail") ? "fail" : "")}${chip(`${n("not run")} not run`, n("not run") ? "warn" : "")}</span></p>
${failed.length ? `<section class="card problems"><h2>Failed cases</h2><ul class="plain">${failed.map((c) => `<li>${link(c.id)} ${esc(c.title)} ${result(c.id)}</li>`).join("")}</ul></section>` : ""}
<section class="prose">${md(f.text, { base: 1 })}</section>
<h2>Screenshots</h2>
${figs ? `<p class="muted">Click a screenshot to show it full size, click again to shrink it.</p><div class="gallery">${figs}</div>` : '<p class="muted">No screenshots beside REPORT.md.</p>'}`;
    }, shotSources(model, found));
  }
  return pages;
}

/** Pages that are missing or were built from different source files than the ones on disk now. */
export function stalePages(dir) {
  const model = readE2e(dir);
  const rp = reportPage(model);
  const wants = (rel) => `<meta name="e2e-sources" content="${sources(model, rel === rp ? shotSources(model, screenshots(model)) : [])}">`;
  return pagePaths(model).filter((rel) => {
    try { return !fs.readFileSync(path.join(dir, rel), "utf8").includes(wants(rel)); } catch { return true; }
  });
}
