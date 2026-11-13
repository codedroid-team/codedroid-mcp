/**
 * `codedroid-mcp e2e verdicts <file>`: validate the verifier's JSON Lines against the e2e folder and append one
 * row per verdict to VERIFY.md (the only writer of that file). Prints nothing; needs no phone, daemon or network.
 */
import fs from "node:fs";
import path from "node:path";
import { readE2e } from "./e2e-model.js";
import { BYS, VERDICTS, cycleOf } from "./e2e-verify.js";
import { escapesRoot } from "./e2e-write.js";

const FIELDS = ["id", "verdict", "by", "reason"];
const MAX_ATTEMPTS = 3;
const HEADER = "# Verifier verdicts\n\nWritten by `e2e verdicts`. Do not edit by hand.\n\n| Item | Attempt | Verdict | By | Text | Date | Reason |\n| --- | --- | --- | --- | --- | --- | --- |\n";
const words = (a) => `${a.slice(0, -1).join(", ")} or ${a.at(-1)}`;
const clean = (s) => s.replace(/[\r\n]+/g, " ").trim();
const today = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function recordVerdicts({ dir, file, now = new Date() }) {
  const fail = (...lines) => ({ code: 2, lines });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(`No such file: ${file}`);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return fail(`No such folder: ${dir}`);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).map((text, i) => ({ text, n: i + 1 })).filter((l) => l.text.trim());
  if (!lines.length) return fail(`${file} holds no verdicts`);

  const model = readE2e(dir);
  if (model.problems.some((p) => p.file === "TESTCASES.md" || p.file === "PRD.md")) {
    return fail('the documents have problems: run "e2e report" and fix them first');
  }

  const faults = [];
  const seen = new Map();
  const todo = [];
  for (const { text, n } of lines) {
    const bad = (m) => faults.push(`${file}:${n}: ${m}`);
    let o;
    try { o = JSON.parse(text); } catch { bad("not valid JSON"); continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) { bad("must be a JSON object"); continue; }
    const before = faults.length;
    for (const f of FIELDS) if (!(f in o)) bad(`missing field "${f}"`);
    for (const f of Object.keys(o)) if (!FIELDS.includes(f)) bad(`unexpected field "${f}"`);
    for (const f of FIELDS) if (f in o && typeof o[f] !== "string") bad(`"${f}" must be a string`);
    if (faults.length > before) continue;
    const { id, verdict, by } = o;
    const reason = clean(o.reason);
    const tc = model.cases.find((c) => c.id === id);
    if (!tc?.verify) bad(`${id} is not a current, judged case`);
    if (!VERDICTS.includes(verdict)) bad(`verdict must be ${words(VERDICTS)}`);
    if (!BYS.includes(by)) bad(`by must be ${words(BYS)}`);
    if (!reason) bad("reason is empty");
    if (seen.has(id)) bad(`${id} appears twice (first on line ${seen.get(id)})`);
    else seen.set(id, n);
    if (tc?.verify && VERDICTS.includes(verdict)) {
      const held = cycleOf(tc.verify.history).length;
      if (tc.verify.status === "invalid") bad(`${id} has an unreadable row in VERIFY.md: fix the file first`);
      else if (verdict === "reopen" && tc.verify.status !== "unresolved") bad(`${id} is not unresolved: "reopen" is only for a case that used its three attempts`);
      else if (verdict !== "reopen" && held >= MAX_ATTEMPTS) bad(`${id} has had three attempts: only "reopen", on the user's word, allows more`);
      else todo.push({ id, verdict, by, reason, attempt: verdict === "reopen" ? 0 : held + 1, hash: tc.verify.hash });
    }
  }
  if (faults.length) return fail(...faults);

  const root = fs.realpathSync(dir);
  const full = path.join(root, "VERIFY.md");
  if (escapesRoot(root, full)) return fail(`Refusing to write VERIFY.md: it is a link or leads outside ${dir}`);
  const date = today(now);
  const rows = todo.map((t) => `| ${t.id} | ${t.attempt} | ${t.verdict} | ${t.by} | ${t.hash} | ${date} | ${t.reason.replace(/\|/g, "\\|")} |\n`).join("");
  try {
    if (!fs.existsSync(full)) fs.writeFileSync(full, HEADER + rows);
    else {
      const old = fs.readFileSync(full, "utf8");
      if (!/^[ \t]*\|[ \t]*Item[ \t]*\|/m.test(old)) return fail("VERIFY.md has no verdict table: delete it or restore it");
      fs.appendFileSync(full, (old.endsWith("\n") ? "" : "\n") + rows);
    }
  } catch (e) {
    return fail(`Cannot write VERIFY.md: ${e.code ?? e.message}`);
  }

  // Self-check: the reader must see each row just written as its case's latest.
  const back = readE2e(dir).verify.rows;
  for (const t of todo) {
    const last = back.findLast((r) => r.item === t.id);
    if (!last || last.verdict !== t.verdict || last.attempt !== t.attempt || last.by !== t.by || last.text !== t.hash || last.date !== date || last.reason !== t.reason) {
      return fail(`${t.id}: VERIFY.md could not be read back after writing`);
    }
  }
  return {
    code: 0,
    lines: [...todo.map((t) => (t.verdict === "reopen" ? `${t.id}: reopened` : `${t.id}: ${t.verdict} (attempt ${t.attempt} of ${MAX_ATTEMPTS})`)), 'Run "e2e report" to update the pages.'],
  };
}
