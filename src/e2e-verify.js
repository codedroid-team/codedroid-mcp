// The verifier's ledger (e2e/VERIFY.md) read back: the rows, the text a verdict was given on, and each case's status.
// Reading only; the command that appends verdicts is separate.
import crypto from "node:crypto";

export const VERDICTS = ["approved", "repair", "question", "reopen"];
export const BYS = ["independent", "same"];
const COLS = 7;
const words = (a) => `${a.slice(0, -1).join(", ")} or ${a.at(-1)}`;

const clean = (lines) => lines.map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
const slice = (text, [from, to]) => clean(text.split(/\r?\n/).slice(from - 1, to));

/** The judged text: the case block, then each covered requirement's block in id order, each after a `--- <id>` line. */
export function caseText(model, caseId) {
  const tc = model.cases.find((c) => c.id === caseId);
  if (!tc || !model.files["TESTCASES.md"]) return null;
  const parts = [slice(model.files["TESTCASES.md"].text, tc.lines)];
  const ids = [...new Set(tc.covers.map((e) => e.ref.replace(/\.f\d+$/, "")))].sort((a, b) => a.slice(1) - b.slice(1));
  for (const id of ids) {
    const req = model.requirements.find((r) => r.id === id);
    if (req && model.files["PRD.md"]) parts.push(`--- ${id}`, slice(model.files["PRD.md"].text, req.lines));
  }
  return parts.join("\n");
}

/** First 16 hex characters of the sha256 of the judged text, or null for an unknown case. */
export function caseHash(model, caseId) {
  const t = caseText(model, caseId);
  return t === null ? null : crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);
}

/** The cells of a ledger row: split on `|` not written `\|`; no backtick handling (a reason may hold a lone backtick). */
const cellsOf = (row) => {
  const c = row.trim().split(/(?<!\\)\|/);
  if (row.trim().startsWith("|")) c.shift();
  if (row.trim().endsWith("|") && !row.trim().endsWith("\\|") && c.length) c.pop();
  return c.map((x) => x.trim().replace(/\\\|/g, "|"));
};

/**
 * Rows of the ledger table and the problems in them. A reopen row carries attempt 0 (written `0`; `-` also read).
 * A row that cannot be read goes to `rejected` ({ item, line, message }; item is its first cell) and is skipped
 * by the numbering; a row whose attempt breaks the numbering is readable and kept. Fenced lines are not read.
 */
export function parseVerify(markdown) {
  const rows = [];
  const problems = [];
  const rejected = [];
  let fenced = false;
  const next = new Map(); // item -> attempt number of its last verdict row in this cycle
  markdown.split(/\r?\n/).forEach((t, i) => {
    const line = i + 1;
    if (/^\s*```/.test(t)) { fenced = !fenced; return; }
    if (fenced || !t.trim().startsWith("|")) return;
    const c = cellsOf(t);
    if (c[0] === "Item" || c.every((x) => /^:?-+:?$/.test(x))) return; // header, separator
    const bad = (message) => { problems.push({ line, message }); rejected.push({ item: c[0] ?? "", line, message }); return null; };
    if (c.length !== COLS) return bad(`row has ${c.length} cells, expected ${COLS}`);
    const [item, att, verdict, by, text, date, reason] = c;
    if (!VERDICTS.includes(verdict)) return bad(`verdict must be ${words(VERDICTS)}`);
    if (!BYS.includes(by)) return bad(`By must be ${words(BYS)}`);
    if (!/^\d+$/.test(att) && att !== "-") return bad("Attempt must be a number");
    if (!/^[0-9a-f]{16}$/.test(text)) return bad("Text must be 16 hex characters");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("Date must be YYYY-MM-DD");
    if (!reason) return bad("reason is empty");
    const attempt = att === "-" ? 0 : Number(att);
    if (verdict === "reopen") {
      if (attempt !== 0) return bad("reopen must have attempt 0 or -");
      next.set(item, 0);
    } else {
      const prev = next.get(item) ?? 0;
      if (attempt !== prev + 1) problems.push({ line, message: `${item} attempt ${attempt} does not follow attempt ${prev}` });
      next.set(item, verdict === "approved" ? 0 : attempt);
    }
    rows.push({ item, attempt, verdict, by, text, date, reason, line });
  });
  return { rows, problems, rejected };
}

/** The rows of the current cycle: those after the last approved or reopen row (all verdict rows, none reopen). */
export function cycleOf(rows) {
  return rows.slice(rows.findLastIndex((r) => r.verdict === "approved" || r.verdict === "reopen") + 1);
}

/**
 * One case's status from its rows (file order) and current hash. A cycle is the verdict rows after the last
 * approved or reopen row. Order: no rows or only reopen rows -> unverified; latest verdict row's Text is not the
 * hash -> stale; latest is approved -> approved; three or more in the cycle -> unresolved; latest question ->
 * question; else repair. A trailing reopen empties the cycle (attempt 0), so it takes the status of the latest
 * verdict with the counter reset: approved stays approved, question stays question, anything else is repair.
 * (`invalid`, an unreadable row for the case, is set by the model, which sees the rejected rows.)
 */
export function statusOf(rows, hash) {
  const verdicts = rows.filter((r) => r.verdict !== "reopen");
  const last = verdicts.at(-1);
  if (!last) return { status: "unverified", attempt: 0, by: null, reason: null, history: rows };
  const cycle = cycleOf(rows);
  const reopened = rows.at(-1).verdict === "reopen";
  const status = last.text !== hash ? "stale" : last.verdict === "approved" ? "approved" : cycle.length >= 3 ? "unresolved" : last.verdict;
  return { status, attempt: reopened ? 0 : last.attempt, by: last.by, reason: last.reason, history: rows };
}
