/**
 * Turns a judge's per-row verdicts (JSON Lines) into numbers.
 *
 * Run: node eval/score.mjs <run-dir>
 *   reads <run-dir>/e2e/TESTCASES.md and <run-dir>/judge.jsonl,
 *   writes <run-dir>/summary.json and <run-dir>/SCORE.md
 * Run: node eval/score.mjs compare <baseline-a-dir> <baseline-b-dir> <next-dir>
 *   reads the three summary.json files and prints the baselines, their spread, their mean,
 *   the next score and whether it went up, down or did not change
 *
 * Exit codes: 0 done; 1 refused (bad or missing input, stale or missing key; the message says what); 2 usage error.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, loadKey } from "./key.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERDICTS = ["covered", "partly", "missed"];
const KINDS = ["happy", "failure", "recovery", "limit", "conflict"];
const MODES = ["phone", "task", "manual", "retired"]; // a later mode wins over an earlier one
export const LIMITS =
  "Limits: the judge is a model, so its verdicts are checked by hand on a sample; the authoring model may have seen this app's public test plans in training; one app is one data point.";

const lines = (text) => text.replace(/^\uFEFF/, "").split(/\r?\n/);
const HEADING_MODE = /^(manual|task)(?=$|[\s(:\-—–])/i;
const BODY_MODE = /^\s*(?:[-*]\s+)?(?:(?:\*\*)?Feature:.*?\s·\s)?(?:\*\*)?Run mode(?:\*\*)?:(?:\*\*)?\s*(?:\*\*|`)?(phone|task|manual)\b/i;
const RETIRED = /^\s*(?:[-*]\s+)?(?:\*\*)?Retired(?:\*\*)?:/i;

/**
 * Case ids from `### TC-12a · P0 · title [· task|· manual]` headings, in document order, each with its run mode.
 * The mode is a ` · manual` / ` · task` segment after the title (a reason may follow) or a body line
 * `Run mode: phone|task|manual`; manual wins over task, task over phone. A body line `Retired:` marks a
 * retired case, which no verdict may cite.
 */
export function caseIds(markdown) {
  const cases = new Map();
  let id = null;
  const set = (mode) => {
    if (MODES.indexOf(mode) > MODES.indexOf(cases.get(id))) cases.set(id, mode);
  };
  for (const line of lines(markdown)) {
    const m = line.match(/^###\s+(TC-[\w-]+)(.*)$/);
    if (m) {
      id = m[1];
      if (cases.has(id)) throw new Error(`TESTCASES.md repeats ${id}`);
      cases.set(id, "phone");
      const segs = m[2].split(" · ").slice(1).map((s) => s.trim());
      // the title follows the priority (or comes first without one); only segments after it set the mode
      const start = /^P\d+$/i.test(segs[0] ?? "") ? 2 : 1;
      for (const seg of segs.slice(start)) {
        const mode = seg.match(HEADING_MODE);
        if (mode) set(mode[1].toLowerCase());
      }
    } else if (/^###\s/.test(line)) id = null;
    else if (id) {
      if (RETIRED.test(line)) set("retired");
      const mode = line.match(BODY_MODE);
      if (mode) set(mode[1].toLowerCase());
    }
  }
  return cases;
}

/** JSON Lines to objects; a bad line is named by number. */
export function parseJudge(text) {
  const out = [];
  lines(text).forEach((line, i) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`judge.jsonl line ${i + 1} is not valid JSON`);
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error(`judge.jsonl line ${i + 1} must be an object`);
    out.push(row);
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

  const s = { ...bucket(), on_phone: bucket(), by_file: {}, by_kind: {}, cases: {}, unmatched_cases: [] };
  for (const mode of MODES) s.cases[mode] = 0;
  for (const mode of cases.values()) s.cases[mode]++;
  const cited = new Set();
  for (const row of key) {
    const j = byId.get(row.id);
    if (!j) throw new Error(`no judge row for ${row.id}`);
    if (!VERDICTS.includes(j.verdict)) throw new Error(`${row.id}: bad verdict ${JSON.stringify(j.verdict)}`);
    if (typeof j.off_phone !== "boolean") throw new Error(`${row.id}: off_phone must be true or false`);
    if (!KINDS.includes(j.kind)) throw new Error(`${row.id}: bad kind ${JSON.stringify(j.kind)}`);
    const ids = j.tc_ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Error(`${row.id}: tc_ids must be an array of strings`);
    if (typeof j.note !== "string") throw new Error(`${row.id}: note must be a string`);
    if (j.verdict === "missed" && ids.length) throw new Error(`${row.id} is missed but cites ${ids.join(", ")}`);
    if (j.verdict !== "missed" && !ids.length) throw new Error(`${row.id} is ${j.verdict} but cites no case`);
    for (const id of ids) {
      if (!cases.has(id)) throw new Error(`${row.id} cites ${id}, which is not in TESTCASES.md`);
      if (cases.get(id) === "retired") throw new Error(`${row.id} cites ${id}, which is retired`);
      cited.add(id);
    }

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
    `Cases read: ${s.cases.phone} phone, ${s.cases.task} task, ${s.cases.manual} manual, ${s.cases.retired} retired`,
    "",
    table("All rows", { all: s, "on phone": s.on_phone }),
    table("By file", s.by_file),
    table("By kind", s.by_kind),
    `## Cases no key row cites\n\n${s.unmatched_cases.length ? s.unmatched_cases.join(", ") : "none"}\n`,
    LIMITS,
    "",
  ].join("\n");
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Write through a temp name in the same folder, so a reader never sees half a file. */
function writeFile(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Scores one run folder. `key` is `{ qaSha, rows }`; by default the fetched key. */
export function main(runDir, key) {
  const summaryFile = path.join(runDir, "summary.json");
  const scoreFile = path.join(runDir, "SCORE.md");
  // a refused rescore must not leave an older score looking current
  for (const f of [summaryFile, scoreFile]) fs.rmSync(f, { force: true });
  const testcases = fs.readFileSync(path.join(runDir, "e2e", "TESTCASES.md"));
  const judge = fs.readFileSync(path.join(runDir, "judge.jsonl"));
  key ??= { qaSha: config.qaSha, rows: loadKey(path.join(here, ".cache")) };
  const s = score(key.rows, parseJudge(judge.toString("utf8")), caseIds(testcases.toString("utf8")));
  s.inputs = { qaSha: key.qaSha, judge_sha256: sha256(judge), testcases_sha256: sha256(testcases) };
  writeFile(summaryFile, JSON.stringify(s, null, 2));
  writeFile(scoreFile, scoreMd(s));
  console.log(`score ${(s.score * 100).toFixed(1)}%  (${s.on_phone.covered_runnable}/${s.on_phone.total} on phone)`);
}

function readSummary(dir) {
  const file = path.join(dir, "summary.json");
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
  }
  const p = s?.on_phone;
  if (!p || !Number.isFinite(p.covered_runnable) || !Number.isFinite(p.total)) throw new Error(`${file} has no on-phone counts`);
  return s;
}

/** Two baseline runs against a later one: the base is the baselines' mean, the spread their difference. */
export function compare(baselineA, baselineB, nextDir) {
  const [a, b, n] = [baselineA, baselineB, nextDir].map(readSummary);
  const base = (rate(a.on_phone) + rate(b.on_phone)) / 2;
  const sp = spread(a, b);
  const next = rate(n.on_phone);
  return { a: rate(a.on_phone), b: rate(b.on_phone), spread: sp, base, next, verdict: verdict(base, sp, next) };
}

function isMain() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const usage = () => {
    console.error("usage: node eval/score.mjs <run-dir>\n       node eval/score.mjs compare <baseline-a-dir> <baseline-b-dir> <next-dir>");
    process.exit(2);
  };
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  try {
    if (args[0] === "compare") {
      if (args.length !== 4) usage();
      const r = compare(args[1], args[2], args[3]);
      console.log(`baseline A  ${pct(r.a)}  ${args[1]}`);
      console.log(`baseline B  ${pct(r.b)}  ${args[2]}`);
      console.log(`spread      ${(r.spread * 100).toFixed(1)} points`);
      console.log(`mean        ${pct(r.base)}`);
      console.log(`next        ${pct(r.next)}  ${args[3]}`);
      console.log(`verdict     ${r.verdict}`);
    } else if (args.length === 1) main(args[0]);
    else usage();
  } catch (e) {
    console.error(`score.mjs: ${e.message}`);
    process.exit(1);
  }
}
