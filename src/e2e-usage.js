/**
 * `codedroid-mcp e2e usage start <step> [dir]` / `e2e usage stop [dir]`: what one run of an app-e2e step cost.
 *
 * start notes the step, the time and the Claude Code session (CLAUDE_CODE_SESSION_ID) in <dir>/.usage-run.json.
 * stop reads that session's transcript and its subagents' (<config>/projects/<project>/<session>.jsonl and
 * <session>/subagents/*.jsonl) between the two times, and saves one record: wall time, tokens per model, an
 * estimated $ from the prices below, and tool calls. It is appended to <dir>/usage.jsonl and, when the day's
 * report folder <dir>/reports/<YYYY-MM-DD>/ exists, added to its usage.json, which the report page shows.
 * Phone-side credits (run_task) are not counted: get_task does not return them.
 * ponytail: Claude Code writes a response to the transcript only after its tool calls return, so the response
 * that runs `stop` is never counted (about 1% of a step's responses). Finishing records later, from `e2e
 * report`, would close that if it matters.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { escapesRoot, notRegular } from "./e2e-write.js";

// $ per million tokens, Anthropic first-party rates. A cache write costs 1.25x input (5-minute) or 2x (1-hour).
// ponytail: a hand-kept table; a model missing here makes the $ estimate null, never too low. Add rows as models ship.
export const PRICES_AS_OF = "2026-11-03";
const PRICES = {
  "claude-fable-5-2": { input: 8, output: 40, cache_read: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01 },
};
const RUN = ".usage-run.json";
const LOG = "usage.jsonl";
const STEP = /^[A-Za-z0-9._-]{1,40}$/;
const SESSION = /^[A-Za-z0-9-]{1,64}$/;

/** YYYY-MM-DD in local time, the way report folders are named. */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "45 s" under 90 seconds, else whole minutes. */
export const duration = (s) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
export const tokenSum = (t) => (t ? t.input + t.output + t.cache_read + t.cache_write : 0);

/** Totals of transcript entries timed within [from, to]: one count per API response (requestId), per model. */
export function summarize(entries, { from, to }) {
  const models = {};
  const seen = new Set();
  const tools = new Map();
  const unpriced = new Set();
  for (const e of entries) {
    if (e?.type !== "assistant" || !e.message) continue;
    const t = Date.parse(e.timestamp);
    if (!(t >= from && t <= to)) continue;
    for (const c of Array.isArray(e.message.content) ? e.message.content : []) {
      if (c?.type === "tool_use" && typeof c.name === "string") tools.set(c.id ?? `${e.requestId}:${tools.size}`, c.name);
    }
    const key = e.requestId ?? e.message.id;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const model = String(e.message.model ?? "unknown").replace(/\[.*\]$/, "");
    const u = e.message.usage;
    if (model === "<synthetic>" || !u) continue;
    const m = (models[model] ??= { requests: 0, input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, usd: 0 });
    const split = u.cache_creation;
    const w1 = Number(split?.ephemeral_1h_input_tokens) || 0;
    const w5 = split ? Number(split.ephemeral_5m_input_tokens) || 0 : Number(u.cache_creation_input_tokens) || 0;
    const add = { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cache_read: Number(u.cache_read_input_tokens) || 0, cache_write_5m: w5, cache_write_1h: w1 };
    m.requests++;
    for (const k of Object.keys(add)) m[k] += add[k];
    const p = PRICES[model];
    if (!p) { unpriced.add(model); m.usd = null; continue; }
    const fast = u.speed === "fast" ? 2 : 1;
    m.usd += (fast * (add.input * p.input + add.output * p.output + add.cache_read * p.cache_read + w5 * 1.25 * p.input + w1 * 2 * p.input)) / 1e6;
  }
  const all = Object.values(models);
  const sum = (k) => all.reduce((a, m) => a + m[k], 0);
  const byTool = {};
  let codedroid = 0;
  for (const name of tools.values()) {
    const parts = name.split("__");
    if (parts[0] !== "mcp" || parts.length < 3 || !/codedroid/i.test(parts[1])) continue;
    codedroid++;
    byTool[parts.at(-1)] = (byTool[parts.at(-1)] ?? 0) + 1;
  }
  return {
    requests: sum("requests"),
    models,
    tokens: { input: sum("input"), output: sum("output"), cache_read: sum("cache_read"), cache_write: sum("cache_write_5m") + sum("cache_write_1h") },
    usd_estimate: unpriced.size ? null : all.reduce((a, m) => a + m.usd, 0),
    unpriced: [...unpriced],
    tool_calls: { total: tools.size, codedroid, by_tool: byTool },
  };
}

/** The session's transcript files: the main one and its subagents'. Empty when none is found. */
function transcripts(claudeDir, session) {
  const projects = path.join(claudeDir, "projects");
  let dirs;
  try { dirs = fs.readdirSync(projects); } catch { return []; }
  for (const d of dirs) {
    const main = path.join(projects, d, `${session}.jsonl`);
    if (!fs.existsSync(main)) continue;
    const sub = path.join(projects, d, session, "subagents");
    let subs = [];
    try { subs = fs.readdirSync(sub).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(sub, f)); } catch { /* no subagents */ }
    return [main, ...subs];
  }
  return [];
}

function readEntries(files) {
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a line cut off while it was being written */ }
    }
  }
  return out;
}

const folder = (dir) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.realpathSync(dir) : null);

/** Write `text` to `full` through a temp file and a rename, never through a link or outside root. */
function safeWrite(root, full, text, { append = false } = {}) {
  if (escapesRoot(root, full) || notRegular(full)) throw new Error(`${path.relative(root, full)} is a link, not a regular file, or leads outside ${root}`);
  const body = append && fs.existsSync(full) ? fs.readFileSync(full, "utf8") + text : text;
  const tmp = `${full}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { flag: "wx" });
  fs.renameSync(tmp, full);
}

export function usageStart({ dir, step, now = Date.now(), session = process.env.CLAUDE_CODE_SESSION_ID }) {
  if (!step || !STEP.test(step)) return { code: 2, lines: ["Usage: codedroid-mcp e2e usage start <step> [dir]: the step is a word such as explore, prd, cujs, testcases, verify, run or rerun"] };
  const root = folder(dir);
  if (!root) return { code: 2, lines: [`No such folder: ${dir}`] };
  const lines = [];
  const full = path.join(root, RUN);
  try {
    const open = JSON.parse(fs.readFileSync(full, "utf8"));
    lines.push(`Dropped the unfinished ${open.step} run started ${open.started}.`);
  } catch { /* none open */ }
  const run = { step, started: new Date(now).toISOString(), session: session && SESSION.test(session) ? session : null };
  try { safeWrite(root, full, JSON.stringify(run) + "\n"); } catch (e) { return { code: 2, lines: [`Cannot write ${RUN}: ${e.code ?? e.message}`] }; }
  lines.push(`Recording ${step}${run.session ? "" : " (no Claude Code session: time only)"}. Run \`codedroid-mcp e2e usage stop\` when the step ends.`);
  return { code: 0, lines };
}

export function usageStop({ dir, now = Date.now(), claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") }) {
  const root = folder(dir);
  if (!root) return { code: 2, lines: [`No such folder: ${dir}`] };
  const runFile = path.join(root, RUN);
  let run;
  try { run = JSON.parse(fs.readFileSync(runFile, "utf8")); } catch { return { code: 2, lines: [`No run is being recorded in ${dir}: run \`codedroid-mcp e2e usage start <step>\` first.`] }; }
  const from = Date.parse(run.started);
  const session = typeof run.session === "string" && SESSION.test(run.session) ? run.session : null;
  const rec = { step: String(run.step), started: run.started, ended: new Date(now).toISOString(), wall_s: Math.max(0, Math.round((now - from) / 1000)), session, client: session ? "claude-code" : null };
  const files = session ? transcripts(claudeDir, session) : [];
  if (files.length) {
    let entries;
    try { entries = readEntries(files); } catch (e) { return { code: 2, lines: [`Cannot read the transcript: ${e.code ?? e.message}`] }; }
    const s = summarize(entries, { from, to: now });
    Object.assign(rec, { tokens: s.tokens, usd_estimate: s.usd_estimate, tool_calls: s.tool_calls, models: s.models, prices_as_of: PRICES_AS_OF });
    if (s.unpriced.length) rec.note = `no price for ${s.unpriced.join(", ")}: no $ estimate`;
  } else {
    Object.assign(rec, { tokens: null, usd_estimate: null, tool_calls: null, note: session ? `transcript not found for session ${session} under ${claudeDir}` : "no Claude Code session: wall time only" });
  }

  const saved = [`${path.basename(dir)}/${LOG}`];
  try { safeWrite(root, path.join(root, LOG), JSON.stringify(rec) + "\n", { append: true }); } catch (e) { return { code: 2, lines: [`Cannot write ${LOG}: ${e.code ?? e.message}`] }; }
  fs.rmSync(runFile, { force: true });
  const day = localDay(now);
  const dayDir = path.join(root, "reports", day);
  if (fs.existsSync(dayDir) && fs.statSync(dayDir).isDirectory()) {
    const full = path.join(dayDir, "usage.json");
    let doc = { runs: [] };
    try {
      if (fs.existsSync(full)) doc = JSON.parse(fs.readFileSync(full, "utf8"));
      if (!Array.isArray(doc?.runs)) throw new Error("it has no runs list");
    } catch (e) {
      return { code: 2, lines: [`Saved to ${saved[0]}, but reports/${day}/usage.json is not readable (${e.message}): fix or remove it, then add this run from the last line of ${LOG}.`] };
    }
    doc.runs.push(rec);
    try { safeWrite(root, full, JSON.stringify(doc, null, 2) + "\n"); } catch (e) { return { code: 2, lines: [`Saved to ${saved[0]}, but cannot write reports/${day}/usage.json: ${e.code ?? e.message}`] }; }
    saved.push(`reports/${day}/usage.json`);
  }
  const cost = rec.tokens ? `, ${rec.tool_calls.codedroid} CodeDroid tool calls, ${tokenSum(rec.tokens).toLocaleString("en-US")} tokens, ${rec.usd_estimate === null ? "no $ estimate" : `$${rec.usd_estimate.toFixed(4)} estimated`}` : ` (${rec.note})`;
  return { code: 0, lines: [`${rec.step}: ${duration(rec.wall_s)}${cost}. Saved to ${saved.join(" and ")}.`] };
}
