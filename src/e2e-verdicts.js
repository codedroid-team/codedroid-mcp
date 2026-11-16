/**
 * `codedroid-mcp e2e verdicts <file>`: validate the verifier's JSON Lines against the e2e folder and append one
 * row per verdict to VERIFY.md (the only writer of that file). `e2e verdicts --due` lists the cases to judge next,
 * each with the code of its current text, which the verdict must carry back. Needs no phone, daemon or network.
 */
import fs from "node:fs";
import path from "node:path";
import { readE2e } from "./e2e-model.js";
import { BYS, USER, VERDICTS, cycleOf } from "./e2e-verify.js";
import { escapesRoot } from "./e2e-write.js";

const FIELDS = ["id", "verdict", "by", "reason", "text"]; // `text` is not needed on a reopen, which judges nothing
const DUE = ["unverified", "stale", "invalid", "repair"];
const DOCS_PROBLEMS = 'the documents have problems: run "e2e report" and fix them first';
const MAX_ATTEMPTS = 3;
const HEADER = "# Verifier verdicts\n\nWritten by `e2e verdicts`. Do not edit by hand.\n\n| Item | Attempt | Verdict | By | Text | Date | Reason |\n| --- | --- | --- | --- | --- | --- | --- |\n";
const words = (a) => `${a.slice(0, -1).join(", ")} or ${a.at(-1)}`;
const clean = (s) => s.replace(/[\r\n]+/g, " ").trim();
/** An id as echoed in a fault line: quoted when it holds a control character. */
const shown = (id) => (/[\u0000-\u001f\u007f-\u009f]/.test(id) ? JSON.stringify(id) : id);
const today = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function recordVerdicts({ dir, file, now = new Date() }) {
  const fail = (...lines) => ({ code: 2, lines });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(`No such file: ${file}`);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return fail(`No such folder: ${dir}`);
  const lines = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((text, i) => ({ text, n: i + 1 })).filter((l) => l.text.trim());
  if (!lines.length) return fail(`${file} holds no verdicts`);

  const model = readE2e(dir);
  if (docsProblems(model)) return fail(DOCS_PROBLEMS);

  const faults = [];
  const seen = new Map();
  const todo = [];
  for (const { text, n } of lines) {
    const bad = (m) => faults.push(`${file}:${n}: ${m}`);
    let o;
    try { o = JSON.parse(text); } catch { bad("not valid JSON"); continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) { bad("must be a JSON object"); continue; }
    const before = faults.length;
    const fields = o.verdict === "reopen" ? FIELDS.filter((f) => f !== "text") : FIELDS;
    for (const f of fields) if (!(f in o)) bad(`missing field "${f}"`);
    for (const f of Object.keys(o)) if (!FIELDS.includes(f)) bad(`unexpected field "${f}"`);
    for (const f of fields) if (f in o && typeof o[f] !== "string") bad(`"${f}" must be a string`);
    if (faults.length > before) continue;
    const { id, verdict, by } = o;
    const reason = clean(o.reason);
    const tc = model.cases.find((c) => c.id === id);
    if (!tc?.verify) bad(`${shown(id)} is not a current, judged case`);
    if (!VERDICTS.includes(verdict)) bad(`verdict must be ${words(VERDICTS)}`);
    if (verdict === "reopen") {
      if (by !== USER) bad(`"reopen" must have by "${USER}": only the user allows more attempts`);
    } else if (by === USER) bad(`by "${USER}" is only for "reopen"; a verdict's by is ${words(BYS)}`);
    else if (!BYS.includes(by)) bad(`by must be ${words(BYS)}`);
    if (!reason) bad("reason is empty");
    else if (!reason.isWellFormed()) bad("reason is not well-formed Unicode");
    if (seen.has(id)) bad(`${shown(id)} appears twice (first on line ${seen.get(id)})`);
    else seen.set(id, n);
    if (verdict !== "reopen") {
      if (!/^[0-9a-f]{16}$/.test(o.text)) bad('"text" must be 16 hex characters: the code after the @ that e2e verdicts --due gave');
      else if (tc?.verify && o.text !== tc.verify.hash) bad(`${id} changed since it was judged (or the text code is wrong): judge it again`);
    }
    const latest = tc?.verify?.history.at(-1);
    if (latest && latest.verdict === verdict && latest.text === tc.verify.hash && latest.reason === reason) {
      bad(`${id}: this verdict is already recorded`);
    }
    if (tc?.verify && VERDICTS.includes(verdict)) {
      const held = cycleOf(tc.verify.history, tc.verify.rejected).length; // a rejected row holds its slot
      if (verdict === "reopen" && held < MAX_ATTEMPTS) bad(`${id} is not unresolved: "reopen" is only for a case that used its three attempts`);
      else if (verdict !== "reopen" && held >= MAX_ATTEMPTS) bad(`${id} has had three attempts: only "reopen", on the user's word, allows more`);
      else todo.push({ id, verdict, by, reason, attempt: verdict === "reopen" ? 0 : held + 1, hash: tc.verify.hash });
    }
  }
  if (faults.length) return fail(...faults);

  const root = fs.realpathSync(dir);
  const full = path.join(root, "VERIFY.md");
  if (escapesRoot(root, full)) return fail(`Refusing to write VERIFY.md: it is a link or leads outside ${dir}`);
  const fence = model.problems.find((p) => p.file === "VERIFY.md" && p.message === "code fence opened here is never closed");
  if (fence) return fail(`VERIFY.md line ${fence.line} opens a code fence that is never closed: rows written after it could not be read`);
  const date = today(now);
  const rows = todo.map((t) => `| ${t.id} | ${t.attempt} | ${t.verdict} | ${t.by} | ${t.hash} | ${date} | ${t.reason.replace(/\|/g, "\\|")} |\n`).join("");
  // Exit 2 means nothing was recorded: on any failure after this point VERIFY.md goes back to its old bytes.
  const created = !fs.existsSync(full);
  const oldSize = created ? 0 : fs.statSync(full).size;
  const restore = () => { try { if (created) fs.rmSync(full, { force: true }); else fs.truncateSync(full, oldSize); } catch { /* reported below */ } };
  try {
    if (created) fs.writeFileSync(full, HEADER + rows, { flag: "wx" });
    else {
      const old = fs.readFileSync(full, "utf8");
      if (!/^[ \t]*\|[ \t]*Item[ \t]*\|/m.test(old)) return fail("VERIFY.md has no verdict table: delete it or restore it");
      fs.appendFileSync(full, (old.endsWith("\n") ? "" : "\n") + rows);
    }
  } catch (e) {
    if (e.code !== "EEXIST") restore();
    return fail(`Cannot write VERIFY.md: ${e.code ?? e.message}`);
  }

  // Self-check: the reader must see each row just written as its case's latest.
  const back = readE2e(dir).verify.rows;
  for (const t of todo) {
    const last = back.findLast((r) => r.item === t.id);
    if (!last || last.verdict !== t.verdict || last.attempt !== t.attempt || last.by !== t.by || last.text !== t.hash || last.date !== date || last.reason !== t.reason) {
      restore();
      return fail(`${t.id}: VERIFY.md could not be read back after writing; nothing was recorded`);
    }
  }
  return {
    code: 0,
    lines: [...todo.map((t) => (t.verdict === "reopen" ? `${t.id}: reopened` : `${t.id}: ${t.verdict} (attempt ${t.attempt} of ${MAX_ATTEMPTS})`)), 'Run "e2e report" to update the pages.'],
  };
}

const docsProblems = (model) => model.problems.some((p) => p.file === "TESTCASES.md" || p.file === "PRD.md");

/**
 * The cases due for judging, as lines `F2: TC-02a@<code> TC-02b@<code>` (feature, then each case with the code of
 * its current text, in document order), or one line saying none is. Due: unverified, stale, invalid or repair with
 * attempts left in its cycle, or reopened (latest row a reopen). Never approved, question or unresolved; a case
 * whose cycle used three attempts waits for the user whatever its status, as the writer would refuse it.
 */
export function dueCases(model) {
  const due = (c) => {
    const v = c.verify;
    if (!v) return false; // setup, retired
    if (v.history.at(-1)?.verdict === "reopen") return true;
    return DUE.includes(v.status) && cycleOf(v.history, v.rejected).length < MAX_ATTEMPTS;
  };
  const byFeature = new Map();
  for (const c of model.cases.filter(due)) byFeature.set(c.feature, [...(byFeature.get(c.feature) ?? []), `${c.id}@${c.verify.hash}`]);
  const lines = [...byFeature].map(([f, ids]) => `${f}: ${ids.join(" ")}`);
  return lines.length ? lines : ["No case is due for judging."];
}

/** `codedroid-mcp e2e verdicts --due [dir]`: prints dueCases; writes nothing. */
export function listDue({ dir }) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { code: 2, lines: [`No such folder: ${dir}`] };
  const model = readE2e(dir);
  if (docsProblems(model)) return { code: 2, lines: [DOCS_PROBLEMS] };
  return { code: 0, lines: dueCases(model) };
}
