/**
 * `codedroid-mcp e2e report`: read an app's e2e folder, write QUALITY.md, quality.json and the HTML
 * pages into it (or with check, only say which are stale). Reads and writes files; prints nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { readE2e } from "./e2e-model.js";
import { quality, qualityJson, qualityMd } from "./e2e-quality.js";
import { renderPages, stalePages } from "./e2e-html.js";

export function runE2eReport({ dir, check = false }) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { code: 2, lines: [`No such folder: ${dir}`] };
  const root = path.resolve(dir);

  if (check) {
    const stale = stalePages(dir);
    for (const f of ["QUALITY.md", "quality.json"]) if (!fs.existsSync(path.join(root, f))) stale.push(f);
    return stale.length ? { code: 1, lines: stale.map((f) => `stale: ${f}`) } : { code: 0, lines: ["All pages are current."] };
  }

  const model = readE2e(dir);
  const q = quality(model);
  const files = { "QUALITY.md": qualityMd(q, model), "quality.json": qualityJson(q, model), ...renderPages(model, q) };
  const targets = Object.keys(files).map((rel) => [rel, path.resolve(root, rel)]);
  for (const [rel, full] of targets) {
    if (!full.startsWith(root + path.sep)) return { code: 2, lines: [`Refusing to write outside ${dir}: ${rel}`] };
  }
  for (const [rel, full] of targets) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel]);
  }

  const c = q.capabilities, r = q.requirements, f = q.failures;
  const lines = [
    `${c.total} capabilities, ${c.with_case} with a case; ${r.total} requirements, ${r.with_case} with a case, ${r.at_depth} tested deep enough; ${f.total} failures, ${f.with_case} with a case; ${q.cases.total} cases.`,
  ];
  if (q.problems.length) {
    lines.push(`${q.problems.length} problems:`, ...q.problems.map((p) => `${p.file}:${p.line}: ${p.message}`));
  }
  lines.push(`Open ${path.join(root, "QUALITY.html")}`);
  return { code: q.problems.length ? 1 : 0, lines };
}
