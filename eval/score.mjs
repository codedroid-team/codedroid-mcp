/**
 * Turns a judge's per-row verdicts (JSON Lines) into numbers.
 *
 * Run: node eval/score.mjs <run-dir>
 *   reads <run-dir>/e2e/TESTCASES.md and <run-dir>/judge.jsonl,
 *   writes <run-dir>/summary.json and <run-dir>/SCORE.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKey } from "./key.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERDICTS = ["covered", "partly", "missed"];
const KINDS = ["happy", "failure", "recovery", "limit", "conflict"];
export const LIMITS =
  "Limits: the judge is a model, so its verdicts are checked by hand on a sample; the authoring model may have seen this app's public test plans in training; one app is one data point.";

/**
 * Case ids from `### TC-12a · P0 · title [· task|· manual]` headings, in document order.
 * The run mode is a trailing ` · manual` / ` · task` segment or a body line `Run mode: manual|task`; manual wins.
 */
export function caseIds(markdown) {
  const cases = new Map();
  let id = null;
  const set = (mode) => {
    if (mode === "manual" || (mode === "task" && cases.get(id) === "phone")) cases.set(id, mode);
  };
  for (const line of markdown.split("\n")) {
    const m = line.match(/^###\s+(TC-[\w-]+)(.*)$/);
    if (m) {
      id = m[1];
      if (cases.has(id)) throw new Error(`TESTCASES.md repeats ${id}`);
      cases.set(id, "phone");
      for (const seg of m[2].split(" · ").slice(1)) {
        const mode = seg.trim().match(/^(manual|task)(?:\s*\(.*\))?$/i);
        if (mode) set(mode[1].toLowerCase());
      }
    } else if (/^###\s/.test(line)) id = null;
    else if (id) {
      const mode = line.match(/^\s*Run mode:\s*(manual|task)\b/i);
      if (mode) set(mode[1].toLowerCase());
    }
  }
  return cases;
}

/** JSON Lines to objects; a bad line is named by number. */
export function parseJudge(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new Error(`judge.jsonl line ${i + 1} is not valid JSON`);
    }
  });
  return out;
}

const bucket = () => ({ total: 0, covered_runnable: 0, covered_manual_only: 0, partly: 0, missed: 0 });
const KEYS = { covered_runnable: 1, covered_manual_only: 1, partly: 1, missed: 1 };
const rate = (b) => (b.total ? b.covered_runnable / b.total : 0);

export function score(key, judge, cases) {
  const byId = new Map();
  for (const row of judge) {
    if (byId.has(row.key_id)) throw new Error(`judge row repeated for ${row.key_id}`);
    byId.set(row.key_id, row);
  }
  const known = new Set(key.map((r) => r.id));
  for (const id of byId.keys()) if (!known.has(id)) throw new Error(`judge row for unknown key id ${id}`);

  const s = { ...bucket(), on_phone: bucket(), by_file: {}, by_kind: {}, unmatched_cases: [] };
  const cited = new Set();
  for (const row of key) {
    const j = byId.get(row.id);
    if (!j) throw new Error(`no judge row for ${row.id}`);
    if (!VERDICTS.includes(j.verdict)) throw new Error(`${row.id}: bad verdict ${JSON.stringify(j.verdict)}`);
    if (typeof j.off_phone !== "boolean") throw new Error(`${row.id}: off_phone must be true or false`);
    if (!KINDS.includes(j.kind)) throw new Error(`${row.id}: bad kind ${JSON.stringify(j.kind)}`);
    const ids = j.tc_ids ?? [];
    for (const id of ids) if (!cases.has(id)) throw new Error(`${row.id} cites ${id}, which is not in TESTCASES.md`);
    if (j.verdict === "covered" && !ids.length) throw new Error(`${row.id} is covered but cites no case`);
    if (j.verdict !== "missed") ids.forEach((id) => cited.add(id));

    const field = j.verdict === "covered" ? (ids.some((id) => cases.get(id) !== "manual") ? "covered_runnable" : "covered_manual_only") : j.verdict;
    const targets = [s, (s.by_file[row.file] ??= bucket()), (s.by_kind[j.kind] ??= bucket())];
    if (!j.off_phone) targets.push(s.on_phone);
    for (const t of targets) {
      t.total++;
      t[field]++;
    }
  }
  s.unmatched_cases = [...cases.keys()].filter((id) => !cited.has(id));
  s.score = rate(s.on_phone);
  return s;
}

export const spread = (a, b) => Math.abs(rate(a.on_phone) - rate(b.on_phone));
export const verdict = (base, spreadValue, next) => (Math.abs(next - base) <= spreadValue + 1e-9 ? "no change" : next > base ? "up" : "down");

function table(title, rows) {
  const head = ["", ...Object.keys(KEYS), "total"];
  return [
    `## ${title}`,
    "",
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...Object.entries(rows).map(([name, b]) => `| ${[name, ...Object.keys(KEYS).map((k) => b[k]), b.total].join(" | ")} |`),
    "",
  ].join("\n");
}

function scoreMd(s) {
  const pct = (s.score * 100).toFixed(1);
  return [
    "# Score",
    "",
    `On-phone score: ${pct}% (${s.on_phone.covered_runnable} of ${s.on_phone.total} on-phone key rows covered by a runnable case)`,
    "",
    table("All rows", { all: s, "on phone": s.on_phone }),
    table("By file", s.by_file),
    table("By kind", s.by_kind),
    `## Cases no key row cites\n\n${s.unmatched_cases.length ? s.unmatched_cases.join(", ") : "none"}\n`,
    LIMITS,
    "",
  ].join("\n");
}

export function main(runDir, keyRows) {
  const cases = caseIds(fs.readFileSync(path.join(runDir, "e2e", "TESTCASES.md"), "utf8"));
  const judge = parseJudge(fs.readFileSync(path.join(runDir, "judge.jsonl"), "utf8"));
  const s = score(keyRows ?? loadKey(path.join(here, ".cache")), judge, cases);
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(s, null, 2));
  fs.writeFileSync(path.join(runDir, "SCORE.md"), scoreMd(s));
  console.log(`score ${(s.score * 100).toFixed(1)}%  (${s.on_phone.covered_runnable}/${s.on_phone.total} on phone)`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) {
    console.error("usage: node eval/score.mjs <run-dir>");
    process.exit(2);
  }
  main(process.argv[2]);
}
