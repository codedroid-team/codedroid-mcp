---
name: app-e2e-rerun
description: Run some of an app's existing e2e test cases on the real phone through CodeDroid - by case id, by CUJ, by feature, by priority (a smoke run), the ones that failed last time, a flaky check, the ones a code change touches, or the same cases on two builds - and report what passed. Use when asked to run, rerun or retry specific test cases or CUJs, run a smoke or regression test, check whether a test is flaky, or check whether a change broke anything.
---

# Rerun test cases

Input: `e2e/TESTCASES.md` (and `e2e/CUJs.md`, the latest `e2e/reports/<date>/REPORT.md`) in the
app's repo. Each case is run exactly as the app-e2e-run skill runs one: read its "Before the run",
"Each case", "Each failure" and "Never" sections first, and follow them, creating this run's own
report folder (below) where it says to create `e2e/reports/<date>/`. Only the choice of cases and
the report differ.

No `e2e/` yet? Say so and offer the app-e2e skill, which writes the cases first.

## Pick the cases

| The user asks | Run |
| --- | --- |
| "Run TC-12a" / "TC-12a and TC-14" | Those ids |
| "Run CUJ-05" / "the history journey" | Every case numbered for that CUJ (TC-05a, TC-05b...) |
| "Test the skills feature" / "F3" | Every case whose `Feature:` is that feature |
| "Smoke test" / "run the P0s" | Every P0 case |
| "Rerun what failed" | The cases the latest report lists as failed |
| "Is TC-07 flaky?" | That case three times in a row |
| "Did my change break anything?" | Below: the cases a change touches |
| "Old build vs new build" | Below: the same cases on two builds |

Add each case's `Needs:` cases first, in order, or it fails for the wrong reason. Cases that run a
CodeDroid task only with the user's OK for this run. Say the list before you start.

## The cases a change touches

1. Read the change: `git diff` against the base branch (or the commits the user names).
2. Map each changed file to the screens it draws or the behavior it changes (`e2e/EXPLORE.md` names
   the screens and their sources; grep the labels the change touches in `TESTCASES.md`).
3. Run the cases on those screens, plus every P0 case: a change can break the main journey from a
   file that looks unrelated.

## Two builds

Run the picked cases on the first build and save the report, then install the second (ask before
installing; a different signing key means uninstalling, which deletes the app's data), run them
again and compare: a case that passes on one build and fails on the other is the finding.

## The report

`e2e/reports/<date>-<what>/REPORT.md` (e.g. `2026-11-05-smoke`): which cases and why they were
picked, the build, then each case's result with its screenshot, as app-e2e-run writes it. For a
flaky check, all three results side by side and a verdict: flaky (find which kind before calling
it a finding), consistently failing, or fine. Lead your reply with the failures.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Edit a case to make it pass without saying so: a changed case is the app-e2e-maintain skill's
  job, with the user's OK.
