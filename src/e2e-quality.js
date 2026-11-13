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
  const real = model.cases.filter((c) => c.type !== "setup"); // a setup case proves nothing: counted on its own
  const runnable = real.filter((c) => RUNNABLE.includes(c.mode));

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
  const manualOnly = new Set(real.filter((c) => c.mode === "manual").flatMap((c) => [...reach(c)]));
  const seenYes = new Set(model.capabilities.filter((c) => c.seen.startsWith("yes")).map((c) => c.id));
  const counts = (ids) => capCounts(ids, inFeature, withCase, exercised, passing, seenYes);
  // Capabilities a Non-goal line sets aside leave every counter and the untested list.
  const reasons = new Map();
  for (const g of model.nonGoals) for (const id of g.caps) if (caps.has(id) && !reasons.has(id)) reasons.set(id, g.reason);

  const coverRefs = new Set(runnable.flatMap((c) => c.covers.map((e) => e.ref)));
  // A Gap line acknowledges a requirement or failure line no runnable case covers; it never counts as covered.
  const gapped = new Set(model.gaps.filter((g) => g.kind !== "deep").map((g) => g.ref));
  const acked = (id) => gapped.has(id) && !coverRefs.has(id);
  const deepCases = (f) => real.filter((c) => c.feature === f.id && c.tier === "deep").length;
  const deepGap = (f) => model.gaps.find((g) => g.kind === "deep" && g.ref === f.id)?.reason ?? null;
  const reqCounts = (list) => ({
    total: list.length,
    with_case: list.filter((r) => coverRefs.has(r.id)).length,
    acknowledged: list.filter((r) => acked(r.id)).length,
    at_depth: list.filter((r) => runnable.some((c) => c.covers.some((e) => e.ref === r.id)
      && DEPTH.indexOf(c.depth) >= DEPTH.indexOf(r.proof))).length,
  });
  const failCounts = (list) => {
    const f = list.flatMap((r) => r.fails);
    return { total: f.length, with_case: f.filter((x) => coverRefs.has(x.id)).length, acknowledged: f.filter((x) => acked(x.id)).length };
  };
  const tally = (list, key, values) => Object.fromEntries(values.map((v) => [v, list.filter((c) => c[key] === v).length]));

  const capsOf = (list) => new Set(list.flatMap((r) => r.caps).filter((id) => caps.has(id)));
  const screens = new Map(model.screens.map((s) => [s.id, s]));
  const screenOf = (c) => { const s = screens.get(c.screen); return s ? `"${s.title}" (${s.source})` : c.screen; };

  return {
    ok: model.problems.length === 0,
    problems: model.problems,
    capabilities: { ...counts([...caps.keys()].filter((id) => !reasons.has(id))), total: caps.size, set_aside: reasons.size },
    requirements: reqCounts(model.requirements),
    failures: failCounts(model.requirements),
    cases: {
      total: model.cases.length,
      setup: model.cases.length - real.length,
      by_mode: tally(model.cases, "mode", ["phone", "task", "manual"]),
      by_tier: tally(real, "tier", ["smoke", "core", "deep", "edge"]),
    },
    by_feature: model.features.map((f) => {
      const rs = model.requirements.filter((r) => r.feature === f.id);
      return {
        id: f.id, name: f.name, priority: f.priority,
        capabilities: counts(capsOf(rs)),
        requirements: reqCounts(rs),
        failures: failCounts(rs),
        tiers: tally(real.filter((c) => c.feature === f.id), "tier", ["smoke", "core", "deep", "edge"]),
        deep_cases: deepCases(f),
        deep_gap: deepGap(f),
      };
    }),
    by_cuj: model.cujs.map((j) => {
      const n = Number(j.id.replace("CUJ-", ""));
      return {
        id: j.id, title: j.title, requirements: j.proves,
        cases: real.filter((c) => /^TC-(\d+)[A-Za-z]+$/.test(c.id) && Number(c.id.match(/^TC-(\d+)/)[1]) === n).map((c) => c.id),
        capabilities: counts(capsOf(j.proves.map((id) => reqs.get(id)).filter(Boolean))),
      };
    }),
    open: [
      ...model.features.filter((f) => f.priority === "P0" && !deepCases(f) && deepGap(f) === null)
        .map((f) => ({ ref: f.id, kind: "deep", what: `${f.id} · ${f.name} is P0 and has no deep case` })),
      ...model.requirements.filter((r) => !coverRefs.has(r.id) && !acked(r.id))
        .map((r) => ({ ref: r.id, kind: "requirement", what: `${r.id} · ${r.text}: no runnable case` })),
      ...model.requirements.filter((r) => ["P0", "P1"].includes(model.features.find((f) => f.id === r.feature)?.priority))
        .flatMap((r) => r.fails).filter((x) => !coverRefs.has(x.id) && !acked(x.id))
        .map((x) => ({ ref: x.id, kind: "failure", what: `${x.id} · ${x.text}: no runnable case` })),
    ],
    gaps: model.gaps.filter((g) => (g.kind === "deep" ? model.features.some((f) => f.id === g.ref && !deepCases(f)) : (g.kind === "failure" ? failIds.has(g.ref) : reqs.has(g.ref)) && acked(g.ref)))
      .map((g) => ({ ref: g.ref, kind: g.kind, reason: g.reason })),
    set_aside: model.capabilities.filter((c) => reasons.has(c.id)).map((c) => ({ id: c.id, screen: screenOf(c), control: c.control, reason: reasons.get(c.id) })),
    untested: model.capabilities.filter((c) => !withCase.has(c.id) && !reasons.has(c.id)).map((c) => {
      return {
        id: c.id, screen: screenOf(c), control: c.control,
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
  const scope = c.total - c.set_aside;
  out.push("| What | Count |", "| --- | --- |");
  if (c.set_aside) out.push(`| Capabilities in scope | ${scope} (${c.set_aside} set aside as non-goals) |`);
  out.push(`| Capabilities in features | ${frac(c.in_feature, scope)} |`);
  out.push(`| Capabilities with a case | ${frac(c.with_case, scope)} |`);
  out.push(`| Capabilities exercised in the last report | ${frac(c.exercised, scope)} |`);
  out.push(`| Capabilities passing in the last report | ${frac(c.passing, scope)} |`);
  out.push(`| Capabilities not seen on the phone | ${c.not_seen} of ${scope} |`);
  out.push(`| Requirements with a case | ${frac(q.requirements.with_case, q.requirements.total)} |`);
  out.push(`| Requirements tested deep enough | ${frac(q.requirements.at_depth, q.requirements.total)} |`);
  out.push(`| Failures with a case | ${frac(q.failures.with_case, q.failures.total)} |`);
  out.push(`| Requirements acknowledged as gaps | ${q.requirements.acknowledged} of ${q.requirements.total} |`);
  out.push(`| Failures acknowledged as gaps | ${q.failures.acknowledged} of ${q.failures.total} |`);
  out.push(`| Left open | ${q.open.length} |`);
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
  out.push("", "## Left open", "");
  if (!q.open.length) out.push("Nothing is left open.", "");
  for (const o of q.open) out.push(`- ${o.what}`);
  if (q.gaps.length) {
    out.push("", "## Acknowledged gaps", "");
    for (const g of q.gaps) out.push(`- ${g.kind === "deep" ? `${g.ref} deep` : g.ref}: ${g.reason}`);
  }
  out.push("", "## Not covered by a runnable case", "");
  if (!q.untested.length) out.push("Every capability has a case.");
  const byScreen = (list) => {
    const g = new Map();
    for (const u of list) g.set(u.screen, [...(g.get(u.screen) ?? []), u]);
    return g;
  };
  for (const [screen, list] of byScreen(q.untested)) {
    out.push(`### ${screen}`, "");
    for (const u of list) out.push(`- ${u.id} · ${u.control}: ${u.why}`);
    out.push("");
  }
  if (q.set_aside.length) {
    out.push("## Set aside as non-goals", "");
    for (const [screen, list] of byScreen(q.set_aside)) {
      out.push(`### ${screen}`, "");
      for (const u of list) out.push(`- ${u.id} · ${u.control}: ${u.reason}`);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

export function qualityJson(q, model, now = new Date()) {
  return JSON.stringify({ ...q, generated: now.toISOString(), sources: model.files }, null, 2) + "\n";
}
