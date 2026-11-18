// Reads an app's e2e/ folder (INVENTORY.md, PRD.md, CUJs.md, TESTCASES.md and the newest report) into one
// model. Content problems are listed in `problems`, never thrown; only a missing folder throws.
// The four sources are written in this order; one that is missing while no later one exists is
// `pending` (not written yet), not a problem.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RULE } from "./e2e-markdown.js";
import { caseHash, parseVerify, statusOf } from "./e2e-verify.js";

const PROOF = ["screen", "elsewhere", "kept"];
const TIERS = ["smoke", "core", "deep", "edge"];
const MODES = ["phone", "task", "manual"];
const RUNNABLE = ["phone", "task"];
const TYPES = ["happy", "negative", "setup"];
const RESULTS = ["pass", "fail", "not run"];
const PRIORITIES = ["P0", "P1", "P2"];
const SOURCES = ["INVENTORY.md", "PRD.md", "CUJs.md", "TESTCASES.md"];
const DEPTH_TWICE = (id) => `${id} gives Depth twice: on its Tier: line and on a Depth: line`;
const WHY_MANUAL = (id) => `${id} is manual and has no Why manual: line`;
const FAILS_FORM = (id) => `${id} Fails: must list failures or say "none in source"`;
const UNREADABLE = {
  screen: 'screen heading is not readable: use "## S<n> · <source> · "<title>""',
  feature: 'feature heading is not readable: use "### F<n> · <name> · <priority>"',
  requirement: 'requirement is not readable: use "- R<n> · <text>"',
  cuj: 'CUJ heading is not readable: use "### CUJ-<n> · <title> · <priority> · <run mode>"',
  case: 'case heading is not readable: use "### TC-<id> · <priority> · <title>"',
};

/** The cells of a Markdown table row: split on `|` outside backticks, trimmed, edge pipes make no cell. */
export function splitCells(row) {
  const cells = [];
  let cur = "";
  let tick = false;
  for (const ch of row) {
    if (ch === "`") tick = !tick;
    if (ch === "|" && !tick) { cells.push(cur); cur = ""; } else cur += ch;
  }
  cells.push(cur);
  const t = row.trim();
  if (t.startsWith("|")) cells.shift();
  if (t.endsWith("|") && cells.length) cells.pop();
  return cells.map((c) => c.trim());
}

const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
const oneOf = (v, allowed) => allowed.includes(v);
const words = (a) => `${a.slice(0, -1).join(", ")} or ${a.at(-1)}`;

/** Non-fenced lines as { n, t } with 1-based numbers; `open` is the line of a fence never closed. */
function linesOf(text) {
  const all = text.split(/\r?\n/);
  let fenced = 0;
  all.forEach((t, i) => { if (/^\s*```/.test(t)) fenced = fenced ? 0 : i + 1; });
  const out = [];
  let inside = false;
  all.forEach((t, i) => {
    if (/^\s*```/.test(t) && !(fenced && i + 1 >= fenced)) { inside = !inside; return; }
    if (fenced && i + 1 === fenced) return; // ponytail: the unclosed fence line itself is dropped
    if (!inside) out.push({ n: i + 1, t });
  });
  out.open = fenced;
  return out;
}

const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const LINKED = (rel) => `${rel} is a link or leads outside the folder: not read`;

/** True when rel (a "/" path under root, the folder's real path) or any folder on the way is a link, or it resolves outside root. */
export function leavesFolder(root, rel) {
  let cur = root;
  for (const part of rel.split("/")) {
    cur = path.join(cur, part);
    try { if (fs.lstatSync(cur).isSymbolicLink()) return true; } catch { return false; } // not there: nothing to read
  }
  const real = fs.realpathSync(cur);
  return real !== root && !real.startsWith(root + path.sep);
}

/** For a name shaped YYYY-MM-DD: whether it is a calendar day. Undefined for any other name. */
const isDay = (f) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return undefined;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(f);
};

/** The heading's level and text, or null. */
const heading = (t) => { const h = t.match(/^(#{1,6}) (.*)$/); return h ? { level: h[1].length, text: h[2] } : null; };

/** Each item's block runs from its first line to the line before the next boundary (or the end of the file). */
function closeBlocks(items, bounds, text) {
  const total = text.split(/\r?\n/).length;
  for (const it of items) it.lines[1] = (bounds.find((b) => b > it.lines[0]) ?? total + 1) - 1;
}

export function readE2e(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`e2e folder not found: ${dir}`);
  const root = fs.realpathSync(dir);
  const m = {
    dir, screens: [], capabilities: [], features: [], requirements: [], nonGoals: [], gaps: [], cujs: [], cases: [],
    results: { report: null, byCase: {} }, problems: [], pending: [], files: {}, verify: { rows: [], orphans: 0, superseded: [] },
  };
  const exists = SOURCES.map((n) => lexists(path.join(root, n)));
  const problem = (file, line, message) => m.problems.push({ file, line, message });
  // A second line of one kind in one item is a problem; the first one counts.
  const again = (file, n, has, key, id, label) => { if (has[key]) problem(file, n, `${id} has two ${label} lines`); return has[key]; };
  const seen = new Map(); // id -> true, for duplicate detection (ids share one namespace per file kind)
  const defined = (file, line, id) => {
    const key = `${file}\0${id}`;
    if (seen.has(key)) problem(file, line, `${id} is defined twice`);
    seen.set(key, true);
  };
  const read = (name) => {
    const p = path.join(root, name);
    if (!lexists(p)) {
      if (name === "VERIFY.md") return null; // optional: nothing judged yet
      const i = SOURCES.indexOf(name);
      if (i >= 0 && !exists.slice(i + 1).some(Boolean)) m.pending.push(name);
      else problem(name, 0, `${name} is missing`);
      return null;
    }
    if (leavesFolder(root, name)) { problem(name, 0, LINKED(name)); return null; }
    if (!fs.lstatSync(p).isFile()) { problem(name, 0, `${name} is not a regular file: not read`); return null; } // a pipe would hang
    const buf = fs.readFileSync(p);
    const text = buf.toString("utf8").replace(/^\uFEFF/, "");
    m.files[name] = { path: p, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
    Object.defineProperty(m.files[name], "text", { value: text }); // for the pages; never written out
    const lines = linesOf(text);
    if (lines.open) problem(name, lines.open, "code fence opened here is never closed");
    return lines;
  };
  const bracketed = []; // [line, ref, cap] Covers brackets, checked against the requirement's Caps
  const refs = []; // [file, line, id, kind] checked once every file is parsed

  const inv = read("INVENTORY.md");
  if (inv) {
    let screen = null;
    for (const { n, t } of inv) {
      let h;
      const hd = heading(t);
      if (hd && (h = t.match(/^## (S\d+) · (.+?) · "(.*)"\s*$/))) {
        defined("INVENTORY.md", n, h[1]);
        screen = { id: h[1], source: h[2], title: h[3], line: n };
        m.screens.push(screen);
      } else if (hd) {
        if (hd.level === 2 ? /^S\d/.test(hd.text) : /^S\d+ ·/.test(hd.text)) problem("INVENTORY.md", n, UNREADABLE.screen);
        screen = null;
      }
      else if (t.includes("|")) {
        const c = splitCells(t);
        const row = t.trim().startsWith("|");
        if (!/^C\d+$/.test(c[0] ?? "")) {
          if (row && /^c\d+$/i.test((c[0] ?? "").replace(/[*_`\s]/g, ""))) problem("INVENTORY.md", n, "capability id must be written C<n>");
          continue;
        }
        if (!row) { if (t.split("|").length > 5) problem("INVENTORY.md", n, "table row must start with |"); continue; }
        if (!screen) { problem("INVENTORY.md", n, `${c[0]} is under no screen: put the row under its "## S<n> · ..." heading`); continue; }
        defined("INVENTORY.md", n, c[0]);
        if (!/^(yes|no|\?)/.test(c[5] ?? "")) problem("INVENTORY.md", n, `${c[0]} Seen must start with yes, no or ?`);
        m.capabilities.push({ id: c[0], screen: screen.id, control: c[1] ?? "", does: c[2] ?? "", source: c[3] ?? "", states: c[4] ?? "", seen: c[5] ?? "", line: n });
      }
    }
    for (const s of m.screens) if (!m.capabilities.some((c) => c.screen === s.id)) problem("INVENTORY.md", s.line, `${s.id} has no capability`);
    // A Source written path:line (or path:from-to) is checked against the repo that holds the e2e folder, when the
    // path's first folder is there: a folder copied away from its app is not flooded with problems.
    const repo = path.dirname(root);
    const lengths = new Map();
    for (const c of m.capabilities) {
      const s = c.source.match(/^([^\s:]+):(\d+)(?:-(\d+))?$/);
      const parts = s ? s[1].split(/[\\/]/) : [];
      if (!s || path.isAbsolute(s[1]) || parts.includes("..") || !lexists(path.join(repo, parts[0]))) continue;
      const full = path.join(repo, s[1]);
      if (!lengths.has(full)) {
        let st = null;
        try { st = fs.lstatSync(full); } catch { /* missing */ }
        const text = st?.isFile() ? fs.readFileSync(full, "utf8") : null;
        lengths.set(full, !st ? -1 : text === null ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
      }
      const len = lengths.get(full), last = Number(s[3] ?? s[2]);
      if (len === -1) problem("INVENTORY.md", c.line, `${c.id} Source ${s[1]} is not in the repo`);
      else if (len > 0 && last > len) problem("INVENTORY.md", c.line, `${c.id} Source line ${last} is past the end of ${s[1]} (${len} lines)`);
    }
  }

  const prd = read("PRD.md");
  if (prd) {
    let feature = null;
    let req = null;
    let inFails = false;
    const bounds = []; // lines at the margin: each ends the requirement above it
    const finish = () => {
      if (!req) return;
      if (!req.has.caps) problem("PRD.md", req.line, `${req.id} has no Caps: line`);
      if (!req.has.proof) problem("PRD.md", req.line, `${req.id} has no Proof: line (${words(PROOF)})`);
      if (!req.has.fails) problem("PRD.md", req.line, `${req.id} has no Fails: line`);
      else if (req.has.failsEmpty && !req.fails.length) problem("PRD.md", req.has.failsLine, FAILS_FORM(req.id));
      delete req.has;
      req = null;
    };
    for (const { n, t } of prd) {
      let h;
      const hd = heading(t);
      // Only indented lines belong to a requirement: any line at the margin ends it, here and in its block.
      if (/^\S/.test(t)) { finish(); bounds.push(n); }
      if (hd && (h = t.match(/^### (F\d+) · (.+?) · (P\d+)\s*$/))) {
        defined("PRD.md", n, h[1]);
        if (!oneOf(h[3], PRIORITIES)) problem("PRD.md", n, `${h[1]} priority must be ${words(PRIORITIES)}`);
        feature = h[1];
        m.features.push({ id: h[1], name: h[2], priority: h[3], line: n });
      } else if (hd) {
        if (hd.level === 3 ? /^F\d/.test(hd.text) : /^F\d+(?:\s|$)/.test(hd.text)) problem("PRD.md", n, UNREADABLE.feature);
        feature = null;
      } else if (/^\s+[-*] Non-goal:/.test(t)) {
        problem("PRD.md", n, "Non-goal line must start at the beginning of the line");
      } else if ((h = t.match(/^[-*] Non-goal:\s*(.*)$/))) {
        const cut = h[1].indexOf("·");
        const caps = list(cut < 0 ? h[1] : h[1].slice(0, cut));
        const reason = cut < 0 ? "" : h[1].slice(cut + 1).trim();
        m.nonGoals.push({ caps, reason, line: n });
        if (!caps.length) problem("PRD.md", n, "Non-goal line names no capability");
        else if (!reason) problem("PRD.md", n, `Non-goal ${caps.join(", ")} has no reason`);
        for (const c of caps) refs.push(["PRD.md", n, c, "cap"]);
      } else if (feature && (h = t.match(/^( {0,3})(?:[-*+•–]|\d+[.)])\s+[*_\s]*[RrＲｒ][0-9０-９]+(\S*)( · )?/)) && (!h[1] || (!req && !h[2] && h[3])) && !/^- (R\d+) · /.test(t)) {
        // Another list form, or a lower-case or full-width R. Indented, only "R<n> · " outside a requirement:
        // other indented items are prose, and inside a requirement they belong to it.
        problem("PRD.md", n, UNREADABLE.requirement);
      } else if ((h = t.match(/^- (R\d+) · (.*)$/))) {
        defined("PRD.md", n, h[1]);
        if (!feature) problem("PRD.md", n, `${h[1]} is under no feature`);
        req = { id: h[1], feature, text: h[2].trim(), caps: [], proof: null, fails: [], line: n, lines: [n, 0], has: {} };
        m.requirements.push(req);
        inFails = false;
      } else if (req && /^\s+\S/.test(t)) {
        let k;
        if ((k = t.match(/^\s+Caps:\s*(.*)$/))) {
          if (again("PRD.md", n, req.has, "caps", req.id, "Caps:")) continue;
          req.has.caps = true; inFails = false;
          const noCaps = /^none$/i.test(k[1].trim()); // `Caps: none`: no control in the inventory
          req.caps = noCaps ? [] : list(k[1]);
          if (!req.caps.length && !noCaps) problem("PRD.md", n, `${req.id} Caps: names nothing`);
          for (const c of req.caps) refs.push(["PRD.md", n, c, "cap"]);
        } else if ((k = t.match(/^\s+Proof:\s*(.*)$/))) {
          if (again("PRD.md", n, req.has, "proof", req.id, "Proof:")) continue;
          req.has.proof = true; inFails = false;
          req.proof = k[1].trim();
          if (!oneOf(req.proof, PROOF)) problem("PRD.md", n, `Proof must be ${words(PROOF)}`);
        } else if ((k = t.match(/^\s+Fails:\s*(.*)$/))) {
          if (again("PRD.md", n, req.has, "fails", req.id, "Fails:")) continue;
          req.has.fails = true; inFails = true;
          const text = k[1].trim();
          req.has.failsLine = n;
          if (!text) req.has.failsEmpty = true; // items must follow
          else if (text.toLowerCase() !== "none in source") problem("PRD.md", n, FAILS_FORM(req.id));
        } else if (inFails && /^\s+(?:[-*+]|\d+[.)])(?:\s|$)/.test(t)) {
          if (!(k = t.match(/^\s+- (R\d+\.f\d+) · (.*)$/))) problem("PRD.md", n, 'failure line is not readable: use "- R<n>.f<m> · <text>"');
          else if (!k[1].startsWith(`${req.id}.f`)) problem("PRD.md", n, `${k[1]} is under ${req.id}: a failure id starts with its requirement's id`);
          else {
            defined("PRD.md", n, k[1]);
            req.fails.push({ id: k[1], text: k[2].trim() });
          }
        }
      }
    }
    finish();
    closeBlocks(m.requirements, bounds, m.files["PRD.md"].text);
  }

  const cujs = read("CUJs.md");
  if (cujs) {
    let group = null;
    let cuj = null;
    for (const { n, t } of cujs) {
      let h;
      const hd = heading(t);
      if (hd && (h = t.match(/^### (CUJ-\d+) · (.+) · (P\d+) · (\S+)\s*$/))) {
        defined("CUJs.md", n, h[1]);
        if (!oneOf(h[3], PRIORITIES)) problem("CUJs.md", n, `${h[1]} priority must be ${words(PRIORITIES)}`);
        if (!oneOf(h[4], MODES)) problem("CUJs.md", n, `${h[1]} mode must be ${words(MODES)}`);
        cuj = { id: h[1], title: h[2], priority: h[3], mode: h[4], feature: group, proves: [], retired: null, line: n, has: false };
        m.cujs.push(cuj);
      } else if (hd && hd.level === 2 && (h = hd.text.match(/^(F\d+)\b/))) { group = h[1]; cuj = null; }
      else if (hd) {
        if (/^CUJ-/.test(hd.text)) problem("CUJs.md", n, UNREADABLE.cuj);
        const unreadable = hd.level !== 2 && /^F\d/.test(hd.text);
        if (unreadable) problem("CUJs.md", n, 'feature heading is not readable: use "## F<n> · <name>"');
        if (hd.level <= 2 || unreadable) group = null; // the journeys under it are in no feature known
        cuj = null;
      }
      else if (cuj && (h = t.match(/^Retired:\s*(.*)$/))) {
        cuj.retired = h[1].trim();
        if (!cuj.retired) problem("CUJs.md", n, `${cuj.id} Retired: has no reason`);
      }
      else if (cuj && /^Why manual:\s*\S/.test(t)) cuj.why = true;
      else if (cuj && (h = t.match(/^Proves:\s*(.*)$/))) {
        if (again("CUJs.md", n, cuj, "has", cuj.id, "Proves:")) continue;
        cuj.has = true;
        cuj.proves = list(h[1]);
        if (!cuj.proves.length && cuj.retired === null) problem("CUJs.md", n, `${cuj.id} Proves: names nothing`);
        for (const r of cuj.proves) refs.push(["CUJs.md", n, r, "req", cuj]);
      }
    }
    for (const c of m.cujs) {
      if (!c.has && c.retired === null) problem("CUJs.md", c.line, `${c.id} has no Proves: line`);
      if (c.mode === "manual" && !c.why && c.retired === null) problem("CUJs.md", c.line, WHY_MANUAL(c.id));
      delete c.has;
      delete c.why;
    }
  }

  const cujsRead = Boolean(cujs);
  const tcs = read("TESTCASES.md");
  if (tcs) {
    let tc = null;
    const bounds = [];
    for (const { n, t } of tcs) {
      let h;
      const hd = heading(t);
      if (hd && hd.level <= 3) bounds.push(n); // h4–h6 are rendered inside the case, so they are judged too
      if (hd && (h = t.match(/^### (TC-[A-Za-z0-9]+) · (P\d+) · (.+?)\s*$/))) {
        defined("TESTCASES.md", n, h[1]);
        if (!oneOf(h[2], PRIORITIES)) problem("TESTCASES.md", n, `${h[1]} priority must be ${words(PRIORITIES)}`);
        tc = { id: h[1], priority: h[2], title: h[3], feature: null, type: null, covers: [], tier: null, depth: null, mode: null, needs: [], retired: null, line: n, lines: [n, 0], has: {} };
        m.cases.push(tc);
      } else if (hd) {
        if (/^TC-/.test(hd.text)) problem("TESTCASES.md", n, UNREADABLE.case);
        tc = null;
      }
      else if (/^\s+[-*] Gap:/.test(t)) problem("TESTCASES.md", n, "Gap line must start at the beginning of the line");
      else if ((h = t.match(/^[-*] Gap:\s*(.*)$/))) {
        const cut = h[1].indexOf("·");
        const ref = (cut < 0 ? h[1] : h[1].slice(0, cut)).trim();
        const reason = cut < 0 ? "" : h[1].slice(cut + 1).trim();
        let x;
        const kind = /^R\d+$/.test(ref) ? "requirement" : /^R\d+\.f\d+$/.test(ref) ? "failure"
          : (x = ref.match(/^(F\d+)\s+deep$/)) ? "deep" : (x = ref.match(/^(R\d+)\s+depth$/)) ? "depth" : null;
        if (!kind) { problem("TESTCASES.md", n, `Gap "${ref}" is not R<n>, R<n> depth, R<n>.f<m> or F<n> deep`); continue; }
        const id = kind === "deep" || kind === "depth" ? x[1] : ref;
        if (m.gaps.some((g) => g.ref === id && g.kind === kind)) problem("TESTCASES.md", n, `${id} has two Gap lines`);
        m.gaps.push({ ref: id, kind, reason, line: n });
        if (!reason) problem("TESTCASES.md", n, `Gap ${ref} has no reason`);
        refs.push(["TESTCASES.md", n, id, kind === "deep" ? "feature" : kind === "failure" ? "fail" : "req"]);
      }
      else if (tc) {
        // Covers: is one line: an indented line or an R<n> line right under it is a wrapped Covers: line, never read.
        if (tc.has.coversLine === n - 1 && /^(\s+\S|R\d)/.test(t)) problem("TESTCASES.md", n, `${tc.id} Covers: goes on to this line: keep it on one line`);
        if (/^Expected:/.test(t)) tc.has.expected = true;
        else if (/^Why manual:\s*\S/.test(t)) tc.has.why = true;
        else if ((h = t.match(/^Retired:\s*(.*)$/))) {
          tc.retired = h[1].trim();
          if (!tc.retired) problem("TESTCASES.md", n, `${tc.id} Retired: has no reason`);
        } else if ((h = t.match(/^Feature:\s*(\S+)(?:\s*·\s*Type:\s*(\S+))?/))) {
          if (again("TESTCASES.md", n, tc.has, "feature", tc.id, "Feature:")) continue;
          tc.has.feature = true;
          tc.feature = h[1];
          tc.type = h[2] ?? null;
          if (tc.type && !oneOf(tc.type, TYPES)) problem("TESTCASES.md", n, `Type must be ${words(TYPES)}`);
          if (tc.type === "setup" && tc.feature === "all") continue;
          refs.push(["TESTCASES.md", n, tc.feature, "feature", tc]);
        } else if ((h = t.match(/^Covers:\s*(.*)$/))) {
          if (again("TESTCASES.md", n, tc.has, "covers", tc.id, "Covers:")) continue;
          tc.has.covers = true;
          tc.has.coversLine = n;
          let depth = 0;
          let cur = "";
          const entries = [];
          for (const ch of h[1] + ",") {
            if (ch === "(") depth++;
            if (ch === ")") depth--;
            if (ch === "," && depth <= 0) { entries.push(cur.trim()); cur = ""; } else cur += ch;
          }
          if (!entries.some(Boolean)) problem("TESTCASES.md", n, `${tc.id} Covers: names nothing`);
          for (const e of entries.filter(Boolean)) {
            const x = e.match(/^(R\d+(?:\.f\d+)?)\s*(?:\(([^)]*)\))?$/);
            if (!x) { problem("TESTCASES.md", n, `Covers entry "${e}" is not a requirement id`); continue; }
            const caps = list(x[2] ?? "");
            tc.covers.push({ ref: x[1], caps });
            refs.push(["TESTCASES.md", n, x[1], "reqOrFail", tc]);
            for (const c of caps) { refs.push(["TESTCASES.md", n, c, "cap", tc]); bracketed.push([n, x[1], c, tc]); }
          }
        } else if ((h = t.match(/^Tier:\s*(.*)$/))) {
          if (again("TESTCASES.md", n, tc.has, "tier", tc.id, "Tier:")) continue;
          tc.has.tier = true;
          const parts = Object.fromEntries(h[0].split("·").map((p) => p.trim().split(/:\s*/)).filter((p) => p.length === 2));
          tc.tier = parts.Tier ?? null;
          if (parts.Depth !== undefined) {
            if (tc.has.depth) problem("TESTCASES.md", n, DEPTH_TWICE(tc.id));
            else { tc.has.depth = "tier"; tc.depth = parts.Depth; }
          }
          if (!oneOf(tc.tier, TIERS)) problem("TESTCASES.md", n, `Tier must be ${words(TIERS)}`);
          if (tc.has.depth && !oneOf(tc.depth, PROOF)) problem("TESTCASES.md", n, `Depth must be ${words(PROOF)}`);
        } else if ((h = t.match(/^Depth:\s*(.*)$/))) {
          if (tc.has.depth === "tier") { problem("TESTCASES.md", n, DEPTH_TWICE(tc.id)); continue; }
          if (again("TESTCASES.md", n, tc.has, "depth", tc.id, "Depth:")) continue;
          tc.has.depth = "line";
          tc.depth = h[1].trim();
          if (!oneOf(tc.depth, PROOF)) problem("TESTCASES.md", n, `Depth must be ${words(PROOF)}`);
        } else if ((h = t.match(/^Needs:\s*(.*)$/))) {
          tc.needs = h[1].match(/\bTC-[A-Za-z0-9]+/g) ?? [];
          for (const id of tc.needs) refs.push(["TESTCASES.md", n, id, "case", tc]);
        } else if ((h = t.match(/^Run mode:\s*(.*)$/))) {
          if (again("TESTCASES.md", n, tc.has, "mode", tc.id, "Run mode:")) continue;
          tc.has.mode = true;
          tc.mode = h[1].trim();
          if (!oneOf(tc.mode, MODES)) problem("TESTCASES.md", n, `Run mode must be ${words(MODES)}`);
        }
      }
    }
    closeBlocks(m.cases, bounds, m.files["TESTCASES.md"].text);
    for (const c of m.cases) {
      if (c.retired !== null) { delete c.has; continue; } // retired: no missing line is a problem
      if (!c.has.feature) problem("TESTCASES.md", c.line, `${c.id} has no Feature: line`);
      for (const [k, label] of [["covers", "Covers: line"], ["tier", `Tier: line (${words(TIERS)})`], ["depth", `Depth: line (${words(PROOF)})`], ["mode", `Run mode: line (${words(MODES)})`]]) {
        if (c.type === "setup" && k !== "mode") continue; // a setup case proves nothing: only its Run mode matters
        if (!c.has[k]) problem("TESTCASES.md", c.line, `${c.id} has no ${label}`);
      }
      if (c.type !== "setup" && !c.has.expected) problem("TESTCASES.md", c.line, `${c.id} has no Expected: line`);
      if (c.mode === "manual" && !c.has.why) problem("TESTCASES.md", c.line, WHY_MANUAL(c.id));
      // A numbered case is for its CUJ (TC-12a for CUJ-12; a bug case TC-B1 for none), and has that CUJ's feature.
      const num = c.type !== "setup" && cujsRead && c.id.match(/^TC-(\d+)[A-Za-z]*$/);
      if (num) {
        const n = Number(num[1]);
        const cuj = m.cujs.find((j) => Number(j.id.slice(4)) === n);
        if (!cuj) problem("TESTCASES.md", c.line, `${c.id} is numbered for CUJ-${n}, which is not in CUJs.md`);
        else if (c.feature && cuj.feature && c.feature !== cuj.feature) problem("TESTCASES.md", c.line, `${c.id} has Feature: ${c.feature}, but CUJ-${n} is under ${cuj.feature}`);
      }
      delete c.has;
    }
  }

  // The report used: the newest reports/YYYY-MM-DD/REPORT.md (zero-padded date, compared as dates). Partial runs
  // (<date>-bug-<case>, <date>-maintain, <date>-smoke) sit beside it and are not used; with no dated folder, the last by name.
  const rdir = path.join(root, "reports");
  let names = [];
  if (lexists(rdir)) {
    if (leavesFolder(root, "reports")) problem("reports", 0, LINKED("reports"));
    else if (!fs.lstatSync(rdir).isDirectory()) problem("reports", 0, "reports is not a folder: not read");
    else names = fs.readdirSync(rdir).sort();
  }
  // In a dated folder an error other than "not there" is thrown, so a folder that cannot be read is exit 2.
  const hasReport = (f) => {
    if (!isDay(f)) return lexists(path.join(rdir, f, "REPORT.md"));
    try { return !!fs.lstatSync(path.join(rdir, f, "REPORT.md"), { throwIfNoEntry: false }); } catch (e) {
      if (e.code === "ENOTDIR") return false;
      e.path = path.join(rdir, f);
      throw e;
    }
  };
  const withReport = names.filter(hasReport);
  const folders = [];
  for (const f of withReport) {
    const rel = `reports/${f}/REPORT.md`;
    if (!/^[A-Za-z0-9._-]+$/.test(f)) problem("reports", 0, `report folder "${f}" is skipped: use only letters, digits, dot, dash and underscore`);
    else if (leavesFolder(root, rel)) problem(rel, 0, LINKED(rel));
    else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(f) && !/^\d{4}-\d{2}-\d{2}$/.test(f)) problem("reports", 0, `report folder "${f}" must be named YYYY-MM-DD`);
    else if (isDay(f) === false) problem("reports", 0, `report folder "${f}" is not a date`);
    else folders.push(f);
  }
  const dated = folders.filter((f) => isDay(f));
  const used = (dated.length ? dated : folders).at(-1);
  for (const f of names) {
    if (used && f > used && isDay(f) && !withReport.includes(f) && fs.lstatSync(path.join(rdir, f)).isDirectory()) problem("reports", 0, `reports/${f} has no REPORT.md: the numbers come from reports/${used}/REPORT.md`);
  }
  if (used) {
    const name = `reports/${used}/REPORT.md`;
    m.results.report = name;
    const rep = read(name) ?? [];
    let at = -1;
    for (let i = 0; i < rep.length; i++) {
      if (!rep[i].t.trim().startsWith("|")) continue;
      const c = splitCells(rep[i].t);
      if (c[0] !== "Case" || c[1] !== "Result") continue;
      if (at < 0) at = i;
      else problem(name, rep[i].n, "REPORT.md has two Case/Result tables: keep one");
    }
    const sep = at < 0 ? "" : rep[at + 1]?.t.trim() ?? "";
    if (at < 0) { if (m.files[name]) problem(name, 0, 'REPORT.md has no Case/Result table: its results table must start with the columns "Case" and "Result"'); } // one not read is a problem already
    else if (!RULE.test(sep)) problem(name, rep[at].n, "Case/Result table has no separator row");
    else {
      for (let i = at + 2; i < rep.length && rep[i].t.trim().startsWith("|"); i++) {
        const [id, res] = splitCells(rep[i].t);
        if (!id) continue;
        const known = !tcs || m.cases.some((c) => c.id === id);
        if (m.cases.some((c) => c.id === id && c.retired !== null)) continue; // a retired case's row counts for nothing
        if (id in m.results.byCase) { problem(name, rep[i].n, `${id} is defined twice`); continue; }
        if (!known) { problem(name, rep[i].n, `${id} is referenced but not defined`); continue; }
        const r = (res ?? "").replace(/\*\*/g, "").trim().toLowerCase();
        const result = r.startsWith("not run") ? "not run" : r.startsWith("pass") ? "pass" : r.startsWith("fail") ? "fail" : null;
        if (!result) problem(name, rep[i].n, `${id} Result must be ${words(RESULTS)}`);
        else m.results.byCase[id] = result;
      }
    }
  }

  // The verifier's ledger: rows for cases that are judged (not setup, not retired) give each its status; other rows are orphans.
  let rejected = [];
  let verifyProblems = [];
  if (read("VERIFY.md")) {
    const v = parseVerify(m.files["VERIFY.md"].text);
    m.verify.rows = v.rows;
    rejected = v.rejected;
    verifyProblems = v.problems;
  }
  const judged = new Set(m.cases.filter((c) => c.retired === null && c.type !== "setup").map((c) => c.id));
  m.verify.orphans = m.verify.rows.filter((r) => !judged.has(r.item)).length;
  // An unreadable row for a judged case is superseded by a later readable verdict for it (a reopen is not a
  // verdict): no longer a problem, listed in `superseded`. The latest unreadable row after the latest verdict
  // makes the case invalid, with that row's problem.
  const lastVerdictLine = (id) => m.verify.rows.filter((r) => r.item === id && r.verdict !== "reopen").at(-1)?.line ?? 0;
  const superseded = rejected.filter((r) => judged.has(r.item) && r.line < lastVerdictLine(r.item));
  m.verify.superseded = superseded.map(({ item, line }) => ({ item, line }));
  for (const p of verifyProblems) if (!superseded.some((r) => r.line === p.line)) problem("VERIFY.md", p.line, p.message);
  for (const c of m.cases) {
    if (!judged.has(c.id)) { c.verify = null; continue; }
    const hash = caseHash(m, c);
    const own = rejected.filter((r) => r.item === c.id).map(({ line }) => ({ line, superseded: line < lastVerdictLine(c.id) }));
    c.verify = { ...statusOf(m.verify.rows.filter((r) => r.item === c.id), hash, own), hash, rejected: own };
    const bad = own.findLast((r) => !r.superseded); // damaged after the latest verdict: never approved
    if (bad) Object.assign(c.verify, { status: "invalid", reason: `VERIFY.md line ${bad.line} cannot be read` });
    if (m.cases.filter((x) => x.id === c.id).length > 1) Object.assign(c.verify, { status: "invalid", reason: `${c.id} is defined twice` });
  }

  // References, checked only against files that were read.
  const ids = {
    cap: inv && new Set(m.capabilities.map((c) => c.id)),
    req: prd && new Set(m.requirements.map((r) => r.id)),
    fail: prd && new Set(m.requirements.flatMap((r) => r.fails.map((f) => f.id))),
    reqOrFail: prd && new Set(m.requirements.flatMap((r) => [r.id, ...r.fails.map((f) => f.id)])),
    feature: prd && new Set(m.features.map((f) => f.id)),
    case: tcs && new Set(m.cases.map((c) => c.id)),
  };
  for (const [file, line, id, kind, owner] of refs) {
    if (owner && owner.retired !== null) continue; // a retired item may point at what no longer exists
    if (ids[kind] && !ids[kind].has(id)) problem(file, line, `${id} is referenced but not defined`);
  }
  for (const g of m.gaps) {
    const run = m.cases.filter((c) => c.retired === null && c.type !== "setup" && RUNNABLE.includes(c.mode));
    const covering = run.filter((c) => c.covers.some((e) => e.ref === g.ref));
    if (g.kind === "deep") {
      if (run.some((c) => c.feature === g.ref && c.tier === "deep")) problem("TESTCASES.md", g.line, `${g.ref} has a Gap line and a deep case`);
    } else if (g.kind === "depth") {
      const r = m.requirements.find((q) => q.id === g.ref);
      if (!r) continue;
      if (!covering.length) problem("TESTCASES.md", g.line, `${g.ref} has a depth Gap line but no runnable case`);
      else if (covering.some((c) => PROOF.indexOf(c.depth) >= PROOF.indexOf(r.proof))) problem("TESTCASES.md", g.line, `${g.ref} has a depth Gap line but already has a case deep enough`);
    } else if (covering.length) {
      problem("TESTCASES.md", g.line, `${g.ref} has a Gap line and a case`);
    }
  }
  for (const g of m.nonGoals) {
    for (const cap of g.caps) {
      for (const r of m.requirements) if (r.caps.includes(cap)) problem("PRD.md", g.line, `${cap} is in a Non-goal line and in ${r.id}'s Caps`);
    }
  }
  for (const [line, ref, cap, owner] of bracketed) {
    if (owner.retired !== null) continue;
    const r = m.requirements.find((q) => q.id === ref.replace(/\.f\d+$/, ""));
    if (r && !r.caps.includes(cap) && (!ids.cap || ids.cap.has(cap))) problem("TESTCASES.md", line, `${cap} is not in ${r.id}'s Caps`);
  }
  return m;
}
