// Coverage counted from the e2e model (see e2e-model.js): how much of the app the test documents reach.
// These are counts of the documents, not test results. No file I/O here; the CLI writes the files.

const DEPTH = ["screen", "elsewhere", "kept"];
const RUNNABLE = ["phone", "task"];

/** The six capability counters for a set of capability ids. */
function capCounts(ids, inFeature, withCase, exercised, passing, seenYes) {
  const a = [...ids];
  return {
    total: a.length,
    in_feature: a.filter((c) => inFeature.has(c)).length,
    with_case: a.filter((c) => withCase.has(c)).length,
    exercised: a.filter((c) => exercised.has(c)).length,
    passing: a.filter((c) => passing.has(c)).length,
    not_seen: a.filter((c) => !seenYes.has(c)).length,
  };
}

export function quality(model) {
  const caps = new Map(model.capabilities.map((c) => [c.id, c]));
  const reqs = new Map(model.requirements.map((r) => [r.id, r]));
  const failIds = new Set(model.requirements.flatMap((r) => r.fails.map((f) => f.id)));
  const result = (c) => model.results.byCase[c.id];
  const runnable = model.cases.filter((c) => RUNNABLE.includes(c.mode));

  // What each case reaches. Covers entries the model reported as undefined are dropped here.
  const reach = (c) => {
    const out = new Set();
    for (const { ref, caps: bracket } of c.covers) {
      const r = reqs.get(ref.replace(/\.f\d+$/, ""));
      if (!r || (ref.includes(".f") && !failIds.has(ref))) continue;
      for (const id of bracket.length ? bracket : r.caps) if (caps.has(id) && r.caps.includes(id)) out.add(id);
    }
    return out;
  };
  const inFeature = new Set(model.requirements.flatMap((r) => r.caps).filter((id) => caps.has(id)));
  const withCase = new Set();
  const exercised = new Set();
  const passing = new Set();
  for (const c of runnable) {
    for (const id of reach(c)) {
      withCase.add(id);
      if (result(c) === "pass" || result(c) === "fail") exercised.add(id);
      if (result(c) === "pass") passing.add(id);
    }
  }
  const manualOnly = new Set(model.cases.filter((c) => c.mode === "manual").flatMap((c) => [...reach(c)]));
  const seenYes = new Set(model.capabilities.filter((c) => c.seen.startsWith("yes")).map((c) => c.id));
  const counts = (ids) => capCounts(ids, inFeature, withCase, exercised, passing, seenYes);

  const coverRefs = new Set(runnable.flatMap((c) => c.covers.map((e) => e.ref)));
  const reqCounts = (list) => ({
    total: list.length,
    with_case: list.filter((r) => coverRefs.has(r.id)).length,
    at_depth: list.filter((r) => runnable.some((c) => c.covers.some((e) => e.ref === r.id)
      && DEPTH.indexOf(c.depth) >= DEPTH.indexOf(r.proof))).length,
  });
  const failCounts = (list) => {
    const f = list.flatMap((r) => r.fails);
    return { total: f.length, with_case: f.filter((x) => coverRefs.has(x.id)).length };
  };
  const tally = (list, key, values) => Object.fromEntries(values.map((v) => [v, list.filter((c) => c[key] === v).length]));

  const capsOf = (list) => new Set(list.flatMap((r) => r.caps).filter((id) => caps.has(id)));
  const screens = new Map(model.screens.map((s) => [s.id, s]));

  return {
    ok: model.problems.length === 0,
    problems: model.problems,
    capabilities: counts(caps.keys()),
    requirements: reqCounts(model.requirements),
    failures: failCounts(model.requirements),
    cases: {
      total: model.cases.length,
      by_mode: tally(model.cases, "mode", ["phone", "task", "manual"]),
      by_tier: tally(model.cases, "tier", ["smoke", "core", "deep", "edge"]),
    },
    by_feature: model.features.map((f) => {
      const rs = model.requirements.filter((r) => r.feature === f.id);
      return {
        id: f.id, name: f.name, priority: f.priority,
        capabilities: counts(capsOf(rs)),
        requirements: reqCounts(rs),
        failures: failCounts(rs),
        tiers: tally(model.cases.filter((c) => c.feature === f.id), "tier", ["smoke", "core", "deep", "edge"]),
      };
    }),
    by_cuj: model.cujs.map((j) => {
      const n = j.id.replace("CUJ-", "");
      return {
        id: j.id, title: j.title, requirements: j.proves,
        cases: model.cases.filter((c) => new RegExp(`^TC-${n}[a-z]`).test(c.id)).map((c) => c.id),
        capabilities: counts(capsOf(j.proves.map((id) => reqs.get(id)).filter(Boolean))),
      };
    }),
    untested: model.capabilities.filter((c) => !withCase.has(c.id)).map((c) => {
      const s = screens.get(c.screen);
      return {
        id: c.id, screen: s ? `"${s.title}" (${s.source})` : c.screen, control: c.control,
        why: !inFeature.has(c.id) ? "not in any feature" : manualOnly.has(c.id) ? "manual case only" : "no case",
      };
    }),
    verified: "not verified", // until the verifier exists
  };
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const frac = (n, d) => `${n} of ${d} (${pct(n, d)})`;

export function qualityMd(q, model) {
  const out = ["# Test quality", ""];
  out.push("These are counts of the documents, not test results. Nothing has been verified by the verifier yet.", "");
  if (q.problems.length) {
    out.push("## Problems", "");
    for (const p of q.problems) out.push(`- ${p.file}:${p.line}: ${p.message}`);
    out.push("");
  }
  const c = q.capabilities;
  out.push("## Headline", "");
  if (!q.ok) out.push("The counts below may be wrong until the problems above are fixed.", "");
  out.push("| What | Count |", "| --- | --- |");
  out.push(`| Capabilities in features | ${frac(c.in_feature, c.total)} |`);
  out.push(`| Capabilities with a case | ${frac(c.with_case, c.total)} |`);
  out.push(`| Capabilities exercised in the last report | ${frac(c.exercised, c.total)} |`);
  out.push(`| Capabilities passing in the last report | ${frac(c.passing, c.total)} |`);
  out.push(`| Capabilities not seen on the phone | ${c.not_seen} of ${c.total} |`);
  out.push(`| Requirements with a case | ${frac(q.requirements.with_case, q.requirements.total)} |`);
  out.push(`| Requirements tested deep enough | ${frac(q.requirements.at_depth, q.requirements.total)} |`);
  out.push(`| Failures with a case | ${frac(q.failures.with_case, q.failures.total)} |`);
  const m = q.cases.by_mode;
  out.push(`| Cases | ${q.cases.total} (${m.phone} phone, ${m.task} task, ${m.manual} manual) |`, "");

  out.push("## By feature", "");
  out.push("| Feature | Priority | Capabilities with a case | Exercised | Passing | Requirements with a case | Deep enough | Failures with a case | Cases (smoke/core/deep/edge) |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const f of q.by_feature) {
    const k = f.capabilities, r = f.requirements, t = f.tiers;
    out.push(`| ${f.id} · ${f.name} | ${f.priority} | ${pct(k.with_case, k.total)} | ${pct(k.exercised, k.total)} | ${pct(k.passing, k.total)} | ${pct(r.with_case, r.total)} | ${pct(r.at_depth, r.total)} | ${pct(f.failures.with_case, f.failures.total)} | ${t.smoke}/${t.core}/${t.deep}/${t.edge} |`);
  }
  out.push("", "## By journey", "");
  out.push("| CUJ | Title | Requirements | Cases | Capabilities with a case | Exercised | Passing |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const j of q.by_cuj) {
    const k = j.capabilities;
    out.push(`| ${j.id} | ${j.title} | ${j.requirements.join(", ")} | ${j.cases.length} | ${pct(k.with_case, k.total)} | ${pct(k.exercised, k.total)} | ${pct(k.passing, k.total)} |`);
  }
  out.push("", "## Not covered by a runnable case", "");
  if (!q.untested.length) out.push("Every capability has a case.");
  const byScreen = new Map();
  for (const u of q.untested) byScreen.set(u.screen, [...(byScreen.get(u.screen) ?? []), u]);
  for (const [screen, list] of byScreen) {
    out.push(`### ${screen}`, "");
    for (const u of list) out.push(`- ${u.id} · ${u.control}: ${u.why}`);
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

export function qualityJson(q, model, now = new Date()) {
  return JSON.stringify({ ...q, generated: now.toISOString(), sources: model.files }, null, 2) + "\n";
}
