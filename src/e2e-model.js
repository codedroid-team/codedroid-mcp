// Reads an app's e2e/ folder (INVENTORY.md, PRD.md, CUJs.md, TESTCASES.md and the newest report) into one
// model. Content problems are listed in `problems`, never thrown; only a missing folder throws.
// The four sources are written in this order; one that is missing while no later one exists is
// `pending` (not written yet), not a problem.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROOF = ["screen", "elsewhere", "kept"];
const TIERS = ["smoke", "core", "deep", "edge"];
const MODES = ["phone", "task", "manual"];
const RUNNABLE = ["phone", "task"];
const TYPES = ["happy", "negative", "setup"];
const RESULTS = ["pass", "fail", "not run"];
const PRIORITIES = ["P0", "P1", "P2"];
const SOURCES = ["INVENTORY.md", "PRD.md", "CUJs.md", "TESTCASES.md"];
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

export function readE2e(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`e2e folder not found: ${dir}`);
  const m = {
    dir, screens: [], capabilities: [], features: [], requirements: [], nonGoals: [], gaps: [], cujs: [], cases: [],
    results: { report: null, byCase: {} }, problems: [], pending: [], files: {},
  };
  const exists = SOURCES.map((n) => fs.existsSync(path.join(dir, n)));
  const problem = (file, line, message) => m.problems.push({ file, line, message });
  const seen = new Map(); // id -> true, for duplicate detection (ids share one namespace per file kind)
  const defined = (file, line, id) => {
    const key = `${file}\0${id}`;
    if (seen.has(key)) problem(file, line, `${id} is defined twice`);
    seen.set(key, true);
  };
  const read = (name) => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      const i = SOURCES.indexOf(name);
      if (i >= 0 && !exists.slice(i + 1).some(Boolean)) m.pending.push(name);
      else problem(name, 0, `${name} is missing`);
      return null;
    }
    const buf = fs.readFileSync(p);
    m.files[name] = { path: p, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
    const lines = linesOf(buf.toString("utf8"));
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
      if ((h = t.match(/^## (S\d+) · (.+?) · "(.*)"\s*$/))) {
        defined("INVENTORY.md", n, h[1]);
        screen = { id: h[1], source: h[2], title: h[3], line: n };
        m.screens.push(screen);
      } else if (/^#{1,2} /.test(t)) {
        if (/^## S\d/.test(t)) problem("INVENTORY.md", n, UNREADABLE.screen);
        screen = null;
      }
      else if (screen && t.trim().startsWith("|")) {
        const c = splitCells(t);
        if (!/^C\d+$/.test(c[0] ?? "")) continue;
        defined("INVENTORY.md", n, c[0]);
        if (!/^(yes|no|\?)/.test(c[5] ?? "")) problem("INVENTORY.md", n, `${c[0]} Seen must start with yes, no or ?`);
        m.capabilities.push({ id: c[0], screen: screen.id, control: c[1] ?? "", does: c[2] ?? "", source: c[3] ?? "", states: c[4] ?? "", seen: c[5] ?? "", line: n });
      }
    }
    for (const s of m.screens) if (!m.capabilities.some((c) => c.screen === s.id)) problem("INVENTORY.md", s.line, `${s.id} has no capability`);
  }

  const prd = read("PRD.md");
  if (prd) {
    let feature = null;
    let req = null;
    let inFails = false;
    const finish = () => {
      if (!req) return;
      if (!req.has.caps) problem("PRD.md", req.line, `${req.id} has no Caps: line`);
      if (!req.has.proof) problem("PRD.md", req.line, `${req.id} has no Proof: line (${words(PROOF)})`);
      if (!req.has.fails) problem("PRD.md", req.line, `${req.id} has no Fails: line`);
      delete req.has;
      req = null;
    };
    for (const { n, t } of prd) {
      let h;
      if ((h = t.match(/^### (F\d+) · (.+?) · (P\d+)\s*$/))) {
        finish();
        defined("PRD.md", n, h[1]);
        if (!oneOf(h[3], PRIORITIES)) problem("PRD.md", n, `${h[1]} priority must be ${words(PRIORITIES)}`);
        feature = h[1];
        m.features.push({ id: h[1], name: h[2], priority: h[3], line: n });
      } else if (/^#{1,3} /.test(t)) {
        finish();
        if (/^### F\d/.test(t)) problem("PRD.md", n, UNREADABLE.feature);
        feature = null;
      } else if ((h = t.match(/^- Non-goal:\s*(.*)$/))) {
        finish();
        const cut = h[1].indexOf("·");
        const caps = list(cut < 0 ? h[1] : h[1].slice(0, cut));
        const reason = cut < 0 ? "" : h[1].slice(cut + 1).trim();
        m.nonGoals.push({ caps, reason, line: n });
        if (!caps.length) problem("PRD.md", n, "Non-goal line names no capability");
        else if (!reason) problem("PRD.md", n, `Non-goal ${caps.join(", ")} has no reason`);
        for (const c of caps) refs.push(["PRD.md", n, c, "cap"]);
      } else if (feature && /^- R\d/.test(t) && !/^- (R\d+) · /.test(t)) {
        finish();
        problem("PRD.md", n, UNREADABLE.requirement);
      } else if ((h = t.match(/^- (R\d+) · (.*)$/))) {
        finish();
        defined("PRD.md", n, h[1]);
        if (!feature) problem("PRD.md", n, `${h[1]} is under no feature`);
        req = { id: h[1], feature, text: h[2].trim(), caps: [], proof: null, fails: [], line: n, has: {} };
        m.requirements.push(req);
        inFails = false;
      } else if (req && /^\s+\S/.test(t)) {
        let k;
        if ((k = t.match(/^\s+Caps:\s*(.*)$/))) {
          req.has.caps = true; inFails = false;
          req.caps = list(k[1]);
          if (!req.caps.length) problem("PRD.md", n, `${req.id} Caps: names nothing`);
          for (const c of req.caps) refs.push(["PRD.md", n, c, "cap"]);
        } else if ((k = t.match(/^\s+Proof:\s*(.*)$/))) {
          req.has.proof = true; inFails = false;
          req.proof = k[1].trim();
          if (!oneOf(req.proof, PROOF)) problem("PRD.md", n, `Proof must be ${words(PROOF)}`);
        } else if ((k = t.match(/^\s+Fails:\s*(.*)$/))) {
          req.has.fails = true; inFails = true;
        } else if (inFails && (k = t.match(/^\s+- (R\d+\.f\d+) · (.*)$/))) {
          defined("PRD.md", n, k[1]);
          req.fails.push({ id: k[1], text: k[2].trim() });
        }
      }
    }
    finish();
  }

  const cujs = read("CUJs.md");
  if (cujs) {
    let group = null;
    let cuj = null;
    for (const { n, t } of cujs) {
      let h;
      if ((h = t.match(/^### (CUJ-\d+) · (.+) · (P\d+) · (\S+)\s*$/))) {
        defined("CUJs.md", n, h[1]);
        if (!oneOf(h[3], PRIORITIES)) problem("CUJs.md", n, `${h[1]} priority must be ${words(PRIORITIES)}`);
        if (!oneOf(h[4], MODES)) problem("CUJs.md", n, `${h[1]} mode must be ${words(MODES)}`);
        cuj = { id: h[1], title: h[2], priority: h[3], mode: h[4], feature: group, proves: [], line: n, has: false };
        m.cujs.push(cuj);
      } else if ((h = t.match(/^## (F\d+)\b/))) { group = h[1]; cuj = null; }
      else if (/^#{1,3} /.test(t)) {
        if (/^### CUJ-/.test(t)) problem("CUJs.md", n, UNREADABLE.cuj);
        if (/^#{1,2} /.test(t)) group = null;
        cuj = null;
      }
      else if (cuj && (h = t.match(/^Proves:\s*(.*)$/))) {
        cuj.has = true;
        cuj.proves = list(h[1]);
        if (!cuj.proves.length) problem("CUJs.md", n, `${cuj.id} Proves: names nothing`);
        for (const r of cuj.proves) refs.push(["CUJs.md", n, r, "req"]);
      }
    }
    for (const c of m.cujs) { if (!c.has) problem("CUJs.md", c.line, `${c.id} has no Proves: line`); delete c.has; }
  }

  const tcs = read("TESTCASES.md");
  if (tcs) {
    let tc = null;
    for (const { n, t } of tcs) {
      let h;
      if ((h = t.match(/^### (TC-[A-Za-z0-9]+) · (P\d+) · (.+?)\s*$/))) {
        defined("TESTCASES.md", n, h[1]);
        if (!oneOf(h[2], PRIORITIES)) problem("TESTCASES.md", n, `${h[1]} priority must be ${words(PRIORITIES)}`);
        tc = { id: h[1], priority: h[2], title: h[3], feature: null, type: null, covers: [], tier: null, depth: null, mode: null, needs: [], line: n, has: {} };
        m.cases.push(tc);
      } else if (/^#{1,3} /.test(t)) {
        if (/^### TC-/.test(t)) problem("TESTCASES.md", n, UNREADABLE.case);
        tc = null;
      }
      else if ((h = t.match(/^- Gap:\s*(.*)$/))) {
        const cut = h[1].indexOf("·");
        const ref = (cut < 0 ? h[1] : h[1].slice(0, cut)).trim();
        const reason = cut < 0 ? "" : h[1].slice(cut + 1).trim();
        let x;
        const kind = /^R\d+$/.test(ref) ? "requirement" : /^R\d+\.f\d+$/.test(ref) ? "failure" : (x = ref.match(/^(F\d+)\s+deep$/)) ? "deep" : null;
        if (!kind) { problem("TESTCASES.md", n, `Gap "${ref}" is not R<n>, R<n>.f<m> or F<n> deep`); continue; }
        const id = kind === "deep" ? x[1] : ref;
        m.gaps.push({ ref: id, kind, reason, line: n });
        if (!reason) problem("TESTCASES.md", n, `Gap ${ref} has no reason`);
        refs.push(["TESTCASES.md", n, id, kind === "deep" ? "feature" : kind === "failure" ? "fail" : "req"]);
      }
      else if (tc) {
        if ((h = t.match(/^Feature:\s*(\S+)(?:\s*·\s*Type:\s*(\S+))?/))) {
          tc.feature = h[1];
          tc.type = h[2] ?? null;
          if (tc.type && !oneOf(tc.type, TYPES)) problem("TESTCASES.md", n, `Type must be ${words(TYPES)}`);
          if (tc.type === "setup" && tc.feature === "all") continue;
          refs.push(["TESTCASES.md", n, tc.feature, "feature"]);
        } else if ((h = t.match(/^Covers:\s*(.*)$/))) {
          tc.has.covers = true;
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
            refs.push(["TESTCASES.md", n, x[1], "reqOrFail"]);
            for (const c of caps) { refs.push(["TESTCASES.md", n, c, "cap"]); bracketed.push([n, x[1], c]); }
          }
        } else if ((h = t.match(/^Tier:\s*(.*)$/))) {
          tc.has.tier = true;
          const parts = Object.fromEntries(h[0].split("·").map((p) => p.trim().split(/:\s*/)).filter((p) => p.length === 2));
          tc.tier = parts.Tier ?? null;
          if (parts.Depth !== undefined) { tc.has.depth = true; tc.depth = parts.Depth; }
          if (!oneOf(tc.tier, TIERS)) problem("TESTCASES.md", n, `Tier must be ${words(TIERS)}`);
          if (tc.has.depth && !oneOf(tc.depth, PROOF)) problem("TESTCASES.md", n, `Depth must be ${words(PROOF)}`);
        } else if ((h = t.match(/^Depth:\s*(.*)$/))) {
          tc.has.depth = true;
          tc.depth = h[1].trim();
          if (!oneOf(tc.depth, PROOF)) problem("TESTCASES.md", n, `Depth must be ${words(PROOF)}`);
        } else if ((h = t.match(/^Needs:\s*(.*)$/))) {
          tc.needs = h[1].match(/\bTC-[A-Za-z0-9]+/g) ?? [];
          for (const id of tc.needs) refs.push(["TESTCASES.md", n, id, "case"]);
        } else if ((h = t.match(/^Run mode:\s*(.*)$/))) {
          tc.has.mode = true;
          tc.mode = h[1].trim();
          if (!oneOf(tc.mode, MODES)) problem("TESTCASES.md", n, `Run mode must be ${words(MODES)}`);
        }
      }
    }
    for (const c of m.cases) {
      for (const [k, label] of [["covers", "Covers: line"], ["tier", `Tier: line (${words(TIERS)})`], ["depth", `Depth: line (${words(PROOF)})`], ["mode", `Run mode: line (${words(MODES)})`]]) {
        if (c.type === "setup" && k !== "mode") continue; // a setup case proves nothing: only its Run mode matters
        if (!c.has[k]) problem("TESTCASES.md", c.line, `${c.id} has no ${label}`);
      }
      delete c.has;
    }
  }

  // The newest report: the reports/<name>/REPORT.md whose folder name sorts last.
  const rdir = path.join(dir, "reports");
  const withReport = fs.existsSync(rdir) ? fs.readdirSync(rdir).filter((f) => fs.existsSync(path.join(rdir, f, "REPORT.md"))).sort() : [];
  const folders = withReport.filter((f) => /^[A-Za-z0-9._-]+$/.test(f));
  for (const f of withReport) {
    if (!folders.includes(f)) problem("reports", 0, `report folder "${f}" is skipped: use only letters, digits, dot, dash and underscore`);
  }
  if (folders.length) {
    const name = `reports/${folders.at(-1)}/REPORT.md`;
    m.results.report = name;
    const rep = read(name);
    let at = -1;
    for (let i = 0; i < rep.length && at < 0; i++) {
      if (!rep[i].t.trim().startsWith("|")) continue;
      const c = splitCells(rep[i].t);
      if (c[0] === "Case" && c[1] === "Result") at = i;
    }
    if (at < 0) problem(name, 0, "REPORT.md has no Case/Result table");
    else {
      for (let i = at + 2; i < rep.length && rep[i].t.trim().startsWith("|"); i++) {
        const [id, res] = splitCells(rep[i].t);
        if (!id) continue;
        const known = !tcs || m.cases.some((c) => c.id === id);
        if (id in m.results.byCase) { problem(name, rep[i].n, `${id} is defined twice`); continue; }
        if (!known) { problem(name, rep[i].n, `${id} is referenced but not defined`); continue; }
        const r = (res ?? "").replace(/\*\*/g, "").trim().toLowerCase();
        const result = r.startsWith("not run") ? "not run" : r.startsWith("pass") ? "pass" : r.startsWith("fail") ? "fail" : null;
        if (!result) problem(name, rep[i].n, `${id} Result must be ${words(RESULTS)}`);
        else m.results.byCase[id] = result;
      }
    }
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
  for (const [file, line, id, kind] of refs) {
    if (ids[kind] && !ids[kind].has(id)) problem(file, line, `${id} is referenced but not defined`);
  }
  for (const g of m.gaps) {
    const real = m.cases.filter((c) => c.type !== "setup");
    if (g.kind === "deep" ? real.some((c) => c.feature === g.ref && c.tier === "deep")
      : real.some((c) => RUNNABLE.includes(c.mode) && c.covers.some((e) => e.ref === g.ref))) {
      problem("TESTCASES.md", g.line, `${g.ref} has a Gap line and a ${g.kind === "deep" ? "deep " : ""}case`);
    }
  }
  for (const g of m.nonGoals) {
    for (const cap of g.caps) {
      for (const r of m.requirements) if (r.caps.includes(cap)) problem("PRD.md", g.line, `${cap} is in a Non-goal line and in ${r.id}'s Caps`);
    }
  }
  for (const [line, ref, cap] of bracketed) {
    const r = m.requirements.find((q) => q.id === ref.replace(/\.f\d+$/, ""));
    if (r && !r.caps.includes(cap) && (!ids.cap || ids.cap.has(cap))) problem("TESTCASES.md", line, `${cap} is not in ${r.id}'s Caps`);
  }
  return m;
}
