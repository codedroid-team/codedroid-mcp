/**
 * `codedroid-mcp e2e report`: read an app's e2e folder, write QUALITY.md, quality.json and the HTML
 * pages into it (or with check, only say which are stale). Reads and writes files; prints nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { readE2e } from "./e2e-model.js";
import { quality, qualityJson, qualityMd } from "./e2e-quality.js";
import { renderPages, stalePages } from "./e2e-html.js";

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function runE2eReport({ dir, check = false }) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { code: 2, lines: [`No such folder: ${dir}`] };
  const root = fs.realpathSync(dir);

  if (check) {
    const stale = stalePages(dir);
    for (const f of ["QUALITY.md", "quality.json"]) if (!fs.existsSync(path.join(root, f))) stale.push(f);
    return stale.length ? { code: 1, lines: stale.map((f) => `stale: ${f}`) } : { code: 0, lines: ["All pages are current."] };
  }

  const model = readE2e(dir);
  const q = quality(model);
  const files = { "QUALITY.md": qualityMd(q, model), "quality.json": qualityJson(q, model), ...renderPages(model, q) };
  const refuse = (rel) => ({ code: 2, lines: [`Refusing to write ${rel}: it is a link or leads outside ${dir}`] });
  const targets = Object.keys(files).map((rel) => [rel, path.join(root, rel)]);
  // Check every target before writing any: no link may lead a write outside the folder.
  for (const [rel, full] of targets) {
    let at = path.dirname(full);
    while (!fs.existsSync(at)) at = path.dirname(at); // the nearest folder that exists; the rest is made below it
    const real = fs.realpathSync(at);
    if (real !== root && !real.startsWith(root + path.sep)) return refuse(rel);
    try { if (fs.lstatSync(full).isSymbolicLink()) return refuse(rel); } catch { /* not there yet */ }
  }
  for (const [rel, full] of targets) {
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, files[rel]);
    } catch (e) {
      return { code: 2, lines: [`Cannot write ${rel}: ${e.code ?? e.message}`] };
    }
  }

  const c = q.capabilities, r = q.requirements, f = q.failures;
  const scope = c.set_aside ? `${c.total - c.set_aside} ${c.total - c.set_aside === 1 ? "capability" : "capabilities"} in scope (${c.set_aside} set aside)` : count(c.total, "capability", "capabilities");
  const ack = (n) => (n ? `, ${n} acknowledged` : "");
  const lines = [
    `${scope}, ${c.with_case} with a case; ${count(r.total, "requirement", "requirements")}, ${r.with_case} with a case${ack(r.acknowledged)}, ${r.at_depth} tested deep enough; ${count(f.total, "failure", "failures")}, ${f.with_case} with a case${ack(f.acknowledged)}; ${count(q.cases.total, "case", "cases")}.`,
  ];
  if (model.pending.length) lines.push(`Not written yet: ${model.pending.join(", ")}. Next: ${model.pending[0]}.`);
  const md = `${dir.replace(/\/+$/, "") || "/"}/QUALITY.md`;
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
  lines.push(`Open ${path.resolve(dir, "QUALITY.html")}`);
  return { code: q.problems.length ? 1 : 0, lines };
}
