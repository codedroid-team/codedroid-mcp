/**
 * `codedroid-mcp e2e usage start|stop`: what a run of an app-e2e step cost, read from the Claude Code
 * transcript of the session that ran it, saved to e2e/usage.jsonl and beside the day's report.
 *
 * Run: node test/e2e-usage.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarize, usageStart, usageStop, localDay } from "../src/e2e-usage.js";
import { readE2e } from "../src/e2e-model.js";
import { quality } from "../src/e2e-quality.js";
import { renderPages, stalePages } from "../src/e2e-html.js";
import { runE2eReport } from "../src/e2e-report.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-usage-"));
const fixture = new URL("./fixtures/e2e-sample", import.meta.url).pathname;
const bin = new URL("../src/index.js", import.meta.url).pathname;
let n = 0;
const fresh = () => {
  const dir = path.join(tmp, `case${n++}`, "e2e");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const T0 = Date.parse("2026-11-24T10:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const asst = (s, req, model, usage, tools = []) => ({
  type: "assistant", timestamp: at(s), requestId: req,
  message: { model, usage, content: tools.map(([id, name]) => ({ type: "tool_use", id, name, input: {} })) },
});
const U = (input, output, read = 0, w5 = 0, w1 = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read,
  cache_creation_input_tokens: w5 + w1, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
});

// --- summarize: dedupe, window, per-model sums, prices, tool calls
{
  const entries = [
    asst(-5, "r0", "claude-opus-5-5", U(9999, 9999)), // before the run
    asst(1, "r1", "claude-opus-5-5", U(1000, 1000, 1000, 1000, 1000), [["t1", "mcp__codedroid__tap"]]),
    asst(1, "r1", "claude-opus-5-5", U(1000, 1000, 1000, 1000, 1000), [["t1", "mcp__codedroid__tap"]]), // same response, logged twice
    asst(2, "r2", "claude-opus-5-5", U(0, 0), [["t2", "mcp__plugin_codedroid_codedroid__get_screen"], ["t3", "Bash"]]),
    asst(3, "r3", "claude-sonnet-5-5", U(2000, 500), [["t4", "mcp__codedroid__tap"]]),
    asst(4, "r4", "<synthetic>", U(0, 0)),
    { type: "user", timestamp: at(4), message: { content: "hi" } },
    asst(99, "r9", "claude-opus-5-5", U(9999, 9999)), // after the run
  ];
  const s = summarize(entries, { from: T0, to: T0 + 60_000 });
  assert.equal(s.requests, 3);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  const { usd: opusUsd, ...opus } = s.models["claude-opus-5-5"];
  assert.deepEqual(opus, { requests: 2, input: 1000, output: 1000, cache_read: 1000, cache_write_5m: 1000, cache_write_1h: 1000 });
  close(opusUsd, 0.004 + 0.02 + 0.0002 + 0.005 + 0.008);
  const { usd: sonUsd, ...son } = s.models["claude-sonnet-5-5"];
  assert.deepEqual(son, { requests: 1, input: 2000, output: 500, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });
  close(sonUsd, 0.004 + 0.005);
  assert.equal(s.models["<synthetic>"], undefined);
  assert.deepEqual(s.tokens, { input: 3000, output: 1500, cache_read: 1000, cache_write: 2000 });
  close(s.usd_estimate, 0.0372 + 0.009);
  assert.deepEqual(s.unpriced, []);
  assert.deepEqual(s.tool_calls, { total: 4, codedroid: 3, by_tool: { tap: 2, get_screen: 1 } });
}
// Property: duplicating and shuffling entries (a transcript logs one response 1-3 times, files are read in any
// order) never changes the totals. Seeded, so a failure repeats.
{
  let seed = 42;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % k; };
  const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"];
  for (let trial = 0; trial < 200; trial++) {
    const base = Array.from({ length: 1 + rnd(12) }, (_, i) => asst(rnd(20), `r${i}`, MODELS[rnd(4)], U(rnd(5000), rnd(900), rnd(9000), rnd(3000), rnd(3000)), rnd(2) ? [[`t${i}`, `mcp__codedroid__${["tap", "swipe", "get_screen"][rnd(3)]}`]] : []));
    const noisy = base.flatMap((e) => Array.from({ length: 1 + rnd(3) }, () => structuredClone(e)));
    for (let i = noisy.length - 1; i > 0; i--) { const j = rnd(i + 1); [noisy[i], noisy[j]] = [noisy[j], noisy[i]]; }
    const w = { from: T0 + rnd(5) * 1000, to: T0 + (10 + rnd(10)) * 1000 };
    const a = summarize(base, w), b = summarize(noisy, w);
    assert.deepEqual(b.tokens, a.tokens, `trial ${trial}`);
    assert.deepEqual(b.tool_calls, a.tool_calls, `trial ${trial}`);
    assert.equal(b.requests, a.requests);
    assert.ok(Math.abs(b.usd_estimate - a.usd_estimate) < 1e-9, `trial ${trial}`);
  }
}
// The window includes both ends.
{
  const s = summarize([asst(0, "a", "claude-opus-5-5", U(1, 0)), asst(10, "b", "claude-opus-5-5", U(1, 0)), asst(10.001, "c", "claude-opus-5-5", U(1, 0))], { from: T0, to: T0 + 10_000 });
  assert.equal(s.tokens.input, 2);
}
// A model without a price: its tokens count, the $ estimate is null rather than too low.
{
  const s = summarize([asst(1, "a", "claude-opus-4-1", U(10, 10)), asst(2, "b", "claude-opus-5-5", U(10, 10))], { from: T0, to: T0 + 10_000 });
  assert.equal(s.models["claude-opus-4-1"].usd, null);
  assert.equal(s.usd_estimate, null);
  assert.deepEqual(s.unpriced, ["claude-opus-4-1"]);
  assert.equal(s.tokens.input, 20);
}
// Without the cache_creation split, every cache write counts as a 5-minute write; an entry without requestId still counts once.
{
  const e = asst(1, undefined, "claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 });
  const s = summarize([e], { from: T0, to: T0 + 10_000 });
  assert.equal(s.models["claude-haiku-5-5"].cache_write_5m, 1_000_000);
  assert.equal(s.models["claude-haiku-5-5"].usd, 0.125);
}

// --- start / stop on a fake Claude config dir
const claudeDir = path.join(tmp, "claude");
const SID = "11111111-2222-3333-4444-555555555555";
const proj = path.join(claudeDir, "projects", "-some-project");
fs.mkdirSync(path.join(proj, SID, "subagents"), { recursive: true });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
fs.writeFileSync(path.join(proj, `${SID}.jsonl`), jsonl([asst(1, "m1", "claude-opus-5-5", U(100, 10), [["x1", "mcp__codedroid__tap"]])]) + "not json\n");
fs.writeFileSync(path.join(proj, SID, "subagents", "agent-a.jsonl"), jsonl([asst(2, "s1", "claude-sonnet-5-5", U(50, 5), [["x2", "mcp__codedroid__get_screen"]])]));
fs.writeFileSync(path.join(proj, "other-session.jsonl"), jsonl([asst(2, "o1", "claude-opus-5-5", U(7777, 7777))]));

{
  const dir = fresh();
  const day = localDay(T0 + 30_000);
  fs.mkdirSync(path.join(dir, "reports", day), { recursive: true });
  let r = usageStart({ dir, step: "run", now: T0, session: SID });
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.ok(fs.existsSync(path.join(dir, ".usage-run.json")));
  r = usageStop({ dir, now: T0 + 30_000, claudeDir });
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.ok(!fs.existsSync(path.join(dir, ".usage-run.json")), "the open run is closed");
  const log = fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  const rec = log[0];
  assert.equal(rec.step, "run");
  assert.equal(rec.session, SID);
  assert.equal(rec.started, new Date(T0).toISOString());
  assert.equal(rec.wall_s, 30);
  assert.equal(rec.client, "claude-code");
  assert.deepEqual(rec.tokens, { input: 150, output: 15, cache_read: 0, cache_write: 0 }, "main and subagent transcripts, not another session's");
  assert.deepEqual(rec.tool_calls, { total: 2, codedroid: 2, by_tool: { tap: 1, get_screen: 1 } });
  assert.equal(typeof rec.usd_estimate, "number");
  assert.ok(rec.prices_as_of);
  const day1 = JSON.parse(fs.readFileSync(path.join(dir, "reports", day, "usage.json"), "utf8"));
  assert.deepEqual(day1.runs, [rec]);
  assert.ok(r.lines.some((l) => /run: 30 s, 2 CodeDroid tool calls, 165 tokens, \$0\.\d+ estimated/.test(l)), r.lines.join("\n"));

  // A second run the same day is added to the same usage.json and log.
  usageStart({ dir, step: "rerun", now: T0, session: SID });
  usageStop({ dir, now: T0 + 30_000, claudeDir });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "reports", day, "usage.json"), "utf8")).runs.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trim().split("\n").length, 2);
}
// No report folder for the day: only the log is written.
{
  const dir = fresh();
  usageStart({ dir, step: "explore", now: T0, session: SID });
  assert.equal(usageStop({ dir, now: T0 + 5_000, claudeDir }).code, 0);
  assert.ok(fs.existsSync(path.join(dir, "usage.jsonl")));
  assert.ok(!fs.existsSync(path.join(dir, "reports")));
}
// Stop with no open run: exit 2, nothing written.
{
  const dir = fresh();
  const r = usageStop({ dir, now: T0, claudeDir });
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /No run is being recorded/);
  assert.ok(!fs.existsSync(path.join(dir, "usage.jsonl")));
}
// No Claude Code session (another client): time is kept, tokens are null and the record says why.
{
  const dir = fresh();
  usageStart({ dir, step: "prd", now: T0, session: null });
  const r = usageStop({ dir, now: T0 + 2_000, claudeDir });
  assert.equal(r.code, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8"));
  assert.equal(rec.wall_s, 2);
  assert.equal(rec.tokens, null);
  assert.equal(rec.usd_estimate, null);
  assert.equal(rec.tool_calls, null);
  assert.match(rec.note, /no Claude Code session/);
}
// A session whose transcript is not found: same, with its own note.
{
  const dir = fresh();
  usageStart({ dir, step: "prd", now: T0, session: "99999999-0000-0000-0000-000000000000" });
  usageStop({ dir, now: T0 + 2_000, claudeDir });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8"));
  assert.equal(rec.tokens, null);
  assert.match(rec.note, /transcript not found/);
}
// A session id that is not a plain id is never used as a path.
{
  const dir = fresh();
  assert.match(usageStart({ dir, step: "prd", now: T0, session: "../../etc/passwd" }).lines.at(-1), /no Claude Code session: time only/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".usage-run.json"), "utf8")).session, null);
  usageStop({ dir, now: T0 + 2_000, claudeDir });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8"));
  assert.equal(rec.session, null);
  assert.equal(rec.tokens, null);
}
// A hand-edited open run with an unsafe session is not used as a path either.
{
  const dir = fresh();
  fs.writeFileSync(path.join(dir, ".usage-run.json"), JSON.stringify({ step: "run", started: new Date(T0).toISOString(), session: `../projects/-some-project/${SID}` }));
  usageStop({ dir, now: T0 + 1_000, claudeDir });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8"));
  assert.equal(rec.session, null);
  assert.equal(rec.tokens, null);
}
// Starting while a run is open replaces it and says so.
{
  const dir = fresh();
  usageStart({ dir, step: "cujs", now: T0, session: SID });
  const r = usageStart({ dir, step: "testcases", now: T0 + 1_000, session: SID });
  assert.equal(r.code, 0);
  assert.ok(r.lines.some((l) => /Dropped the unfinished cujs run/.test(l)), r.lines.join("\n"));
  usageStop({ dir, now: T0 + 3_000, claudeDir });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8")).step, "testcases");
}
// A step name that is not a plain word is refused; a missing folder is exit 2.
{
  const dir = fresh();
  assert.equal(usageStart({ dir, step: "a b", now: T0 }).code, 2);
  assert.equal(usageStart({ dir, step: undefined, now: T0 }).code, 2);
  assert.equal(usageStart({ dir: path.join(tmp, "nope"), step: "run", now: T0 }).code, 2);
  assert.equal(usageStop({ dir: path.join(tmp, "nope"), now: T0, claudeDir }).code, 2);
  assert.ok(!fs.existsSync(path.join(dir, ".usage-run.json")));
}
// A usage.json that is not ours (bad JSON) is not overwritten: exit 2, the log still has the run.
{
  const dir = fresh();
  const day = localDay(T0);
  fs.mkdirSync(path.join(dir, "reports", day), { recursive: true });
  fs.writeFileSync(path.join(dir, "reports", day, "usage.json"), "{broken");
  usageStart({ dir, step: "run", now: T0, session: SID });
  const r = usageStop({ dir, now: T0, claudeDir });
  assert.equal(r.code, 2);
  assert.equal(fs.readFileSync(path.join(dir, "reports", day, "usage.json"), "utf8"), "{broken");
  assert.ok(fs.existsSync(path.join(dir, "usage.jsonl")));
}

// Fast mode doubles the price; a "[1m]" suffix on the model name is the same model; a tool_use without id still counts.
{
  const fast = { ...U(1_000_000, 0), speed: "fast" };
  const e = asst(1, "f", "claude-opus-5-5[1m]", fast, [[undefined, "mcp__codedroid__swipe"]]);
  const s = summarize([e], { from: T0, to: T0 + 10_000 });
  assert.equal(s.models["claude-opus-5-5"].usd, 8);
  assert.deepEqual(s.tool_calls.by_tool, { swipe: 1 });
  // A tool name that is not an MCP CodeDroid tool is counted in total only.
  const t = summarize([asst(1, "g", "claude-opus-5-5", U(0, 0), [["a", "mcp__github__x"], ["b", "mcp__codedroid"]])], { from: T0, to: T0 + 10_000 });
  assert.deepEqual(t.tool_calls, { total: 2, codedroid: 0, by_tool: {} });
}
// Malformed entries (content not a list, no model, non-numeric counts) count as zeros, never throw.
{
  const odd = { type: "assistant", timestamp: at(1), requestId: "q", message: { content: "text", usage: { input_tokens: "x" } } };
  const s = summarize([odd, null, { type: "assistant", timestamp: "not a date", message: {} }], { from: T0, to: T0 + 10_000 });
  assert.deepEqual(s.models.unknown, { requests: 1, input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, usd: null });
  assert.equal(s.tool_calls.total, 0);
}
// A transcript that cannot be read: exit 2, the open run stays for a retry.
if (process.getuid?.() !== 0) {
  const cfg = path.join(tmp, "claude3");
  const sid3 = "33333333-0000-0000-0000-000000000000";
  fs.mkdirSync(path.join(cfg, "projects", "p"), { recursive: true });
  const t = path.join(cfg, "projects", "p", `${sid3}.jsonl`);
  fs.writeFileSync(t, "");
  fs.chmodSync(t, 0);
  const dir = fresh();
  usageStart({ dir, step: "run", now: T0, session: sid3 });
  const r = usageStop({ dir, now: T0, claudeDir: cfg });
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /Cannot read the transcript: EACCES/);
  assert.ok(fs.existsSync(path.join(dir, ".usage-run.json")));
  fs.chmodSync(t, 0o600);
}
// A Claude config dir with no projects folder, and a session with no subagents folder.
{
  const dir = fresh();
  usageStart({ dir, step: "prd", now: T0, session: SID });
  usageStop({ dir, now: T0 + 1_000, claudeDir: path.join(tmp, "no-such-config") });
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8")).note, /transcript not found/);
  const cfg = path.join(tmp, "claude2");
  const sid2 = "22222222-0000-0000-0000-000000000000";
  fs.mkdirSync(path.join(cfg, "projects", "p"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "projects", "p", `${sid2}.jsonl`), jsonl([asst(1, "z", "claude-opus-4-1", U(5, 5))]));
  const dir2 = fresh();
  usageStart({ dir: dir2, step: "prd", now: T0, session: sid2 });
  const r = usageStop({ dir: dir2, now: T0 + 1_000, claudeDir: cfg });
  const rec = JSON.parse(fs.readFileSync(path.join(dir2, "usage.jsonl"), "utf8"));
  assert.deepEqual(rec.tokens, { input: 5, output: 5, cache_read: 0, cache_write: 0 });
  assert.match(rec.note, /no price for claude-opus-4-1/);
  assert.match(r.lines[0], /10 tokens, no \$ estimate/);
}
// usage.jsonl that is a link is never written through: exit 2, the open run stays.
{
  const dir = fresh();
  const outside = path.join(tmp, "outside.jsonl");
  fs.writeFileSync(outside, "");
  fs.symlinkSync(outside, path.join(dir, "usage.jsonl"));
  usageStart({ dir, step: "run", now: T0, session: SID });
  const r = usageStop({ dir, now: T0, claudeDir });
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /Cannot write usage\.jsonl/);
  assert.equal(fs.readFileSync(outside, "utf8"), "");
  assert.ok(fs.existsSync(path.join(dir, ".usage-run.json")));
  // .usage-run.json as a link: start refuses too.
  const d2 = fresh();
  fs.symlinkSync(outside, path.join(d2, ".usage-run.json"));
  assert.equal(usageStart({ dir: d2, step: "run", now: T0, session: SID }).code, 2);
  assert.equal(fs.readFileSync(outside, "utf8"), "");
}
// usage.json that is JSON but has no runs list: not overwritten.
{
  const dir = fresh();
  const day = localDay(T0);
  fs.mkdirSync(path.join(dir, "reports", day), { recursive: true });
  fs.writeFileSync(path.join(dir, "reports", day, "usage.json"), '{"other":1}');
  usageStart({ dir, step: "run", now: T0, session: SID });
  const r = usageStop({ dir, now: T0, claudeDir });
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /no runs list/);
  assert.equal(fs.readFileSync(path.join(dir, "reports", day, "usage.json"), "utf8"), '{"other":1}');
}
// usage.json in the report folder that is a link: not written through.
{
  const dir = fresh();
  const day = localDay(T0);
  fs.mkdirSync(path.join(dir, "reports", day), { recursive: true });
  const outside = path.join(tmp, "outside-usage.json");
  fs.writeFileSync(outside, '{"runs":[]}');
  fs.symlinkSync(outside, path.join(dir, "reports", day, "usage.json"));
  usageStart({ dir, step: "run", now: T0, session: SID });
  const r = usageStop({ dir, now: T0, claudeDir });
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /cannot write reports\/.*usage\.json/);
  assert.equal(fs.readFileSync(outside, "utf8"), '{"runs":[]}');
}

// --- the report page shows the day's usage.json, and goes stale when it changes
{
  const dir = fresh();
  fs.cpSync(fixture, dir, { recursive: true });
  const model0 = readE2e(dir);
  const report = model0.results.report;
  assert.ok(report, "the fixture has a report");
  const rdir = path.join(dir, path.dirname(report));
  const page = () => { const m = readE2e(dir); return renderPages(m, quality(m))[report.replace(/\.md$/, ".html")]; };
  assert.ok(!page().includes("Cost of this run"), "no usage.json: no cost section");
  const rec = { step: "run", started: at(0), ended: at(90), wall_s: 90, tokens: { input: 1234, output: 56, cache_read: 7, cache_write: 8 }, usd_estimate: 0.0123, tool_calls: { total: 12, codedroid: 10, by_tool: { tap: 6 } }, models: {} };
  fs.writeFileSync(path.join(rdir, "usage.json"), JSON.stringify({ runs: [rec, { ...rec, step: "<b>x</b>", usd_estimate: null }, { step: "bare" }, null] }));
  const html = page();
  assert.ok(html.includes("Cost of this run"), "cost section");
  assert.ok(html.includes("1,305"), "tokens of a run (input+output+cache)");
  assert.ok(html.includes("$0.0123"), "$ of a run");
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"), "step names are escaped");
  assert.ok(/Total[\s\S]*3 min[\s\S]*20/.test(html), "a total row");
  assert.ok(html.includes("not priced"), "a run without $ says so");
  assert.ok(html.includes("$0.0123 <span class=\"muted\">(some runs not priced)</span>"), "the total says it is partial");
  // stale after usage.json changes
  const m1 = readE2e(dir);
  for (const [rel, h] of Object.entries(renderPages(m1, quality(m1)))) fs.writeFileSync(path.join(dir, rel), h);
  assert.deepEqual(stalePages(dir), []);
  fs.writeFileSync(path.join(rdir, "usage.json"), JSON.stringify({ runs: [rec] }));
  assert.deepEqual(stalePages(dir), [report.replace(/\.md$/, ".html")]);
  // unreadable usage.json, or one without a runs list: a problem, no crash, no cost section
  for (const [bad, why] of [["{nope", /is not readable: .*JSON/], ['{"other":1}', /is not readable: no runs list/]]) {
    fs.writeFileSync(path.join(rdir, "usage.json"), bad);
    const m = readE2e(dir);
    const html = renderPages(m, quality(m))[report.replace(/\.md$/, ".html")];
    assert.ok(m.problems.some((p) => /usage\.json/.test(p.file) && why.test(p.message)), JSON.stringify(m.problems));
    assert.ok(!html.includes("Cost of this run"));
  }
}

// --- e2e report finishes pending records: the response that ran stop reaches the transcript only after
// stop returns, so stop marks its record pending and the next e2e report counts it.
{
  const cfg = path.join(tmp, "claude-finish");
  const sid = "44444444-0000-0000-0000-000000000000";
  const pdir = path.join(cfg, "projects", "p");
  fs.mkdirSync(pdir, { recursive: true });
  const t = path.join(pdir, `${sid}.jsonl`);
  const dir = fresh();
  fs.cpSync(fixture, dir, { recursive: true });
  const T = new Date(2026, 0, 2, 12).getTime(); // local noon on the fixture's newest report day
  const rdir = path.join(dir, "reports", localDay(T));
  const atT = (s) => new Date(T + s * 1000).toISOString();
  const row = (s, req, usage, tools = []) => ({ type: "assistant", timestamp: atT(s), requestId: req, message: { model: "claude-opus-5-5", usage, content: tools.map(([id, name]) => ({ type: "tool_use", id, name })) } });
  fs.writeFileSync(t, jsonl([row(1, "a", U(100, 10), [["k1", "mcp__codedroid__tap"]])]));
  usageStart({ dir, step: "run", now: T, session: sid });
  let r = usageStop({ dir, now: T + 20_000, claudeDir: cfg });
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.match(r.lines[0], /e2e report adds the response that ran stop/);
  const log = () => fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const day = () => JSON.parse(fs.readFileSync(path.join(rdir, "usage.json"), "utf8")).runs;
  assert.equal(log()[0].pending, true);
  assert.equal(day()[0].pending, true);
  // Now the stop call's own response is on disk (inside the window), and a later one (the next step's) after it.
  fs.appendFileSync(t, jsonl([row(19, "b", U(1000, 20), [["k2", "Bash"]]), row(25, "c", U(9999, 9999))]));
  // --check writes nothing.
  runE2eReport({ dir, check: true, claudeDir: cfg });
  assert.equal(log()[0].pending, true);
  r = runE2eReport({ dir, claudeDir: cfg });
  assert.ok(r.lines.some((l) => /Finished 1 usage record/.test(l)), r.lines.join("\n"));
  for (const rec of [log()[0], day()[0]]) {
    assert.equal(rec.pending, undefined);
    assert.deepEqual(rec.tokens, { input: 1100, output: 30, cache_read: 0, cache_write: 0 });
    assert.deepEqual(rec.tool_calls, { total: 2, codedroid: 1, by_tool: { tap: 1 } });
    assert.equal(rec.models["claude-opus-5-5"].requests, 2);
    assert.equal(rec.wall_s, 20);
  }
  const page = fs.readFileSync(path.join(rdir, "REPORT.html"), "utf8");
  assert.ok(page.includes("1,130"), "the page shows the finished numbers");
  // A second report finishes nothing and does not touch either file.
  const files = [path.join(dir, "usage.jsonl"), path.join(rdir, "usage.json")];
  const past = new Date(2020, 0, 1);
  for (const f of files) fs.utimesSync(f, past, past);
  const before = files.map((f) => fs.readFileSync(f, "utf8"));
  r = runE2eReport({ dir, claudeDir: cfg });
  assert.ok(!r.lines.some((l) => /Finished/.test(l)));
  assert.deepEqual(files.map((f) => fs.readFileSync(f, "utf8")), before);
  for (const f of files) assert.equal(fs.statSync(f).mtimeMs, past.getTime(), `${f} not rewritten`);
  assert.deepEqual(stalePages(dir), []);
  // Nothing pending: a usage.jsonl that is a link is only read, so the report does not fail.
  const linked = path.join(tmp, "linked-done.jsonl");
  fs.renameSync(files[0], linked);
  fs.symlinkSync(linked, files[0]);
  assert.notEqual(runE2eReport({ dir, claudeDir: cfg }).code, 2);
}
// A pending record whose transcript is gone stays pending, and the report still runs; lines it cannot parse are kept.
{
  const dir = fresh();
  fs.cpSync(fixture, dir, { recursive: true });
  const rec = { step: "prd", started: at(0), ended: at(5), wall_s: 5, session: "55555555-0000-0000-0000-000000000000", tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, pending: true };
  fs.writeFileSync(path.join(dir, "usage.jsonl"), `${JSON.stringify(rec)}\nnot json\n`);
  const r = runE2eReport({ dir, claudeDir: path.join(tmp, "claude-none") });
  assert.notEqual(r.code, 2, r.lines.join("\n"));
  assert.equal(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8"), `${JSON.stringify(rec)}\nnot json\n`);
}
// A report folder's usage.json that is not JSON, or has no runs list, is left alone: the page lists it as a problem.
{
  const dir = fresh();
  fs.cpSync(fixture, dir, { recursive: true });
  for (const bad of ['{"other":1}', "{nope"]) {
    fs.writeFileSync(path.join(dir, "reports", "2025-12-01", "usage.json"), bad);
    const r = runE2eReport({ dir, claudeDir: path.join(tmp, "claude-none") });
    assert.notEqual(r.code, 2, r.lines.join("\n"));
    assert.equal(fs.readFileSync(path.join(dir, "reports", "2025-12-01", "usage.json"), "utf8"), bad);
  }
}
// A record pending under an unsafe session, or not pending, is never re-read; a finished unpriced model keeps its note.
{
  const dir = fresh();
  fs.cpSync(fixture, dir, { recursive: true });
  const cfg = path.join(tmp, "claude-note");
  const sid = "66666666-0000-0000-0000-000000000000";
  fs.mkdirSync(path.join(cfg, "projects", "p"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "projects", "p", `${sid}.jsonl`), jsonl([asst(1, "n", "claude-opus-4-1", U(3, 3)), asst(2, "m", "claude-opus-5-5", U(3, 3))]));
  const base = { step: "prd", started: at(0), ended: at(5), tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
  // A transcript where an unsafe session id would lead (projects/p/../<id>.jsonl): never read.
  fs.writeFileSync(path.join(cfg, "projects", `${sid}.jsonl`), jsonl([asst(1, "evil", "claude-opus-5-5", U(777, 777))]));
  const recs = [{ ...base, session: sid, pending: true }, { ...base, session: `../${sid}`, pending: true }, { ...base, session: sid }, { ...base, session: sid, pending: "yes" }];
  fs.writeFileSync(path.join(dir, "usage.jsonl"), recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = runE2eReport({ dir, claudeDir: cfg });
  assert.ok(r.lines.includes("Finished 1 usage record with the response that ran stop."), r.lines.join("\n"));
  const out = fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(out[0].tokens.input, 6);
  assert.match(out[0].note, /no price for claude-opus-4-1/);
  assert.deepEqual(out.slice(1), recs.slice(1));
  // When a finish leaves every model priced, an old no-price note goes.
  fs.writeFileSync(path.join(cfg, "projects", "p", `${sid}.jsonl`), jsonl([asst(2, "m", "claude-opus-5-5", U(3, 3))]));
  fs.writeFileSync(path.join(dir, "usage.jsonl"), JSON.stringify({ ...base, session: sid, pending: true, note: "no price for x" }) + "\n");
  runE2eReport({ dir, claudeDir: cfg });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8")).note, undefined);
}
// usage.jsonl that is a link: the report refuses to write through it.
{
  const dir = fresh();
  fs.cpSync(fixture, dir, { recursive: true });
  const cfg = path.join(tmp, "claude-finish");
  const outside = path.join(tmp, "outside-finish.jsonl");
  const rec = { step: "prd", started: new Date(new Date(2026, 0, 2, 12).getTime()).toISOString(), ended: new Date(new Date(2026, 0, 2, 12).getTime() + 20_000).toISOString(), session: "44444444-0000-0000-0000-000000000000", pending: true };
  fs.writeFileSync(outside, JSON.stringify(rec) + "\n");
  fs.symlinkSync(outside, path.join(dir, "usage.jsonl"));
  const r = runE2eReport({ dir, claudeDir: cfg });
  assert.equal(r.code, 2);
  assert.match(r.lines[0], /usage\.jsonl/);
  assert.equal(fs.readFileSync(outside, "utf8"), JSON.stringify(rec) + "\n");
}

// --- the CLI: start/stop through the real binary, session from CLAUDE_CODE_SESSION_ID, config from CLAUDE_CONFIG_DIR
{
  const dir = fresh();
  const env = { ...process.env, HOME: tmp, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_SESSION_ID: SID };
  const run = (...a) => spawnSync(process.execPath, [bin, "e2e", "usage", ...a], { encoding: "utf8", env, timeout: 10000 });
  let r = run("start", "verify", dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".usage-run.json"), "utf8")).session, SID);
  r = run("stop", dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /verify: /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8")).step, "verify");
  assert.equal(run("stop", dir).status, 2);
  assert.equal(run("bogus", dir).status, 2);
  assert.equal(run("start").status, 2, "start needs a step");
  // Without CLAUDE_CONFIG_DIR the transcript is looked for under ~/.claude.
  const home = path.join(tmp, "home");
  fs.cpSync(claudeDir, path.join(home, ".claude"), { recursive: true });
  const { CLAUDE_CONFIG_DIR, ...rest } = env;
  const d2 = fresh();
  const run2 = (...a) => spawnSync(process.execPath, [bin, "e2e", "usage", ...a], { encoding: "utf8", env: { ...rest, HOME: home }, timeout: 10000 });
  assert.equal(run2("start", "run", d2).status, 0);
  assert.equal(run2("stop", d2).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d2, "usage.jsonl"), "utf8")).client, "claude-code");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("e2e-usage: all passed");
