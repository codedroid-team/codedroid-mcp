/**
 * `codedroid-mcp e2e report`: read an app's e2e folder, write QUALITY.md, quality.json and the HTML
 * pages into it (or with check, only say which are stale). Reads and writes files; prints nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { readE2e } from "./e2e-model.js";
import { quality, qualityJson, qualityMd } from "./e2e-quality.js";
import { renderPages, stalePages } from "./e2e-html.js";
import { escapesRoot, notRegular } from "./e2e-write.js";
import { finishUsage } from "./e2e-usage.js";

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const DOCS = ["INVENTORY.md", "PRD.md", "CUJs.md", "TESTCASES.md"];

export function runE2eReport({ dir, check = false, claudeDir }) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { code: 2, lines: [`No such folder: ${dir}`] };
  const root = fs.realpathSync(dir);
  // A source the reader cannot open is exit 2, like a folder that does not exist; 1 means the documents have problems.
  const cannotRead = (e) => {
    if (!e.code) throw e;
    return { code: 2, lines: [`Cannot read ${path.relative(root, e.path ?? root) || "."}: ${e.code}`] };
  };
  let docs;
  try { docs = DOCS.some((n) => fs.lstatSync(path.join(root, n), { throwIfNoEntry: false })); } catch (e) { return cannotRead(e); }
  if (!docs) return { code: 2, lines: [`No e2e documents in ${dir}: expected INVENTORY.md, PRD.md, CUJs.md or TESTCASES.md`] };
  // First, so the report page shows them: usage records stop left pending get the response that ran stop.
  let finished = 0;
  if (!check) {
    try { finished = finishUsage({ root, claudeDir }); } catch (e) { return { code: 2, lines: [`Cannot finish the usage records: ${e.code ?? e.message}`] }; }
  }

  if (check) {
    let stale;
    try { stale = stalePages(dir); } catch (e) { return cannotRead(e); }
    for (const f of ["QUALITY.md", "quality.json"]) if (!fs.existsSync(path.join(root, f))) stale.push(f);
    return stale.length ? { code: 1, lines: stale.map((f) => `stale: ${f}`) } : { code: 0, lines: ["All pages are current."] };
  }

  let model, q, files;
  try {
    model = readE2e(dir);
    q = quality(model);
    const pages = renderPages(model, q); // first: a screenshot it cannot read adds a problem
    q.ok = model.problems.length === 0;
    files = { "QUALITY.md": qualityMd(q, model), "quality.json": qualityJson(q, model), ...pages };
  } catch (e) {
    return cannotRead(e);
  }
  const refuse = (rel) => ({ code: 2, lines: [`Refusing to write ${rel}: it is a link or leads outside ${dir}`] });
  const targets = Object.keys(files).map((rel) => [rel, path.join(root, rel)]);
  // Check every target before writing any: no link may lead a write outside the folder, and only a regular file is replaced.
  for (const [rel, full] of targets) {
    if (escapesRoot(root, full)) return refuse(rel);
    if (notRegular(full)) return { code: 2, lines: [`Refusing to write ${rel}: it is not a regular file`] };
  }
  // Each output goes to a new temp file beside it, then all are renamed over their targets: a write never goes
  // through a link swapped in after the check, and a failure before the renames changes no target.
  const temps = [];
  let current;
  try {
    for (const [rel, full] of targets) {
      current = rel;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const tmp = `${full}.tmp-${process.pid}`;
      const fd = fs.openSync(tmp, "wx");
      temps.push([tmp, full, rel]);
      try { fs.writeFileSync(fd, files[rel]); } finally { fs.closeSync(fd); }
    }
    for (const [tmp, full, rel] of temps) { current = rel; fs.renameSync(tmp, full); }
  } catch (e) {
    for (const [tmp] of temps) fs.rmSync(tmp, { force: true });
    return { code: 2, lines: [`Cannot write ${current}: ${e.code ?? e.message}`] };
  }

  const c = q.capabilities, r = q.requirements, f = q.failures;
  const scope = c.set_aside ? `${c.total - c.set_aside} ${c.total - c.set_aside === 1 ? "control" : "controls"} in scope (${c.set_aside} set aside)` : count(c.total, "control", "controls");
  const ack = (n) => (n ? `, ${n} acknowledged` : "");
  const lines = [
    `${scope}, ${c.with_case} with a case, ${c.approved} with an approved case; ${count(r.total, "requirement", "requirements")}, ${r.with_case} with a case${ack(r.acknowledged)}, ${r.at_depth} with a case deep enough; ${count(f.total, "failure", "failures")}, ${f.with_case} with a case${ack(f.acknowledged)}; ${count(q.cases.total, "case", "cases")}.`,
  ];
  if (q.report) lines.push(`Last report ${q.report}: ${q.results.pass} passed, ${q.results.fail} failed, ${q.results["not run"]} not run; ${r.passing} of ${count(r.total, "requirement", "requirements")} passing.`);
  const md = `${dir.replace(/\/+$/, "") || "/"}/QUALITY.md`;
  const v = q.verify;
  if (v.judged && v.unverified === v.judged) lines.push("No case has been judged by the verifier yet.");
  else if (q.not_approved.length) lines.push(`${q.not_approved.length} of ${v.judged} ${v.judged === 1 ? "case" : "cases"} not approved by the verifier${v.unverified ? ` (${v.unverified} not judged yet)` : ""}: see ${md}`);
  if (model.pending.length) lines.push(`Not written yet: ${model.pending.join(", ")}. Next: ${model.pending[0]}.`);
  const ps = q.problems, MAX = 20;
  if (ps.length) {
    lines.push(`${count(ps.length, "problem", "problems")}:`);
    if (ps.length > MAX) {
      const kinds = new Map();
      for (const p of ps) {
        const k = p.message.replace(/\b(?:TC-[A-Za-z0-9]+|CUJ-\d+|R\d+(?:\.f\d+)?|[CFS]\d+)\b/g, "<id>");
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
      lines.push(...[...kinds].sort((x, y) => y[1] - x[1]).map(([k, n]) => `  ${n} \u00d7 ${k}`));
    }
    lines.push(...ps.slice(0, MAX).map((p) => `${p.file}:${p.line}: ${p.message}`));
    if (ps.length > MAX) lines.push(`and ${ps.length - MAX} more: see ${md}`);
  }
  if (q.open.length) lines.push(`${q.open.length} left open: see ${md}`);
  if (finished) lines.push(`Finished ${count(finished, "usage record", "usage records")} with the response that ran stop.`);
  lines.push(`Open ${path.resolve(dir, "QUALITY.html")}`);
  return { code: q.problems.length ? 1 : 0, lines };
}
