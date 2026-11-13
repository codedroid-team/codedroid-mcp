---
name: app-e2e-maintain
description: Keep an app's e2e test cases and CUJs current after the app changes - update labels and steps from the source and the phone, retire cases for removed features, add cases for new screens, and list the CUJs and requirements nothing tests. Use when test cases fail because the UI changed, when asked to update, fix or clean up test cases, after a feature is added or removed, or to find gaps in test coverage.
---

# Maintain the test cases

Input and output: `e2e/EXPLORE.md`, `e2e/INVENTORY.md`, `e2e/PRD.md`, `e2e/CUJs.md` and
`e2e/TESTCASES.md` in the app's repo. Read the app-e2e-explore and app-e2e-testcases skills' rules
first: a label you did not see on screen or in the source is a guess. After any edit to them, run
`npx -y @codedroid/mcp e2e report e2e` and fix every problem it prints as `file:line: message`;
never edit the pages it writes.

## A case failed because the UI changed

1. Confirm it is the UI, not a bug: the old label or screen is gone from the source (`git log -p`
   on the file shows it renamed or moved), and the journey still works when you walk it on the
   phone with `get_screen` and `tap`.
2. Behavior changed, not just wording? That may be a bug or a product decision: ask the user before
   rewriting the Expected lines to match what the app does now.
3. Update the steps and Expected lines with the labels you saw, and `EXPLORE.md` and
   `INVENTORY.md` with them.
4. Run the case twice, as app-e2e-run does (its "Before the run" too), with its screenshots in a
   folder of its own, `e2e/reports/<date>-maintain/`, so a full run's report of the same day stays
   as it was; it must pass both times.

## A feature was added or removed

- Removed: mark its cases `Retired: <date> - <why>` instead of deleting them, and its CUJ in
  `CUJs.md`; leave them out of runs.
- Added: explore its screens and add their controls to `INVENTORY.md` (as app-e2e-explore does),
  add it to the PRD's features (as app-e2e-prd does), add its CUJ (as app-e2e-cujs does, with the
  user's review), then its cases (as app-e2e-testcases does, with the user's approval).

## A CUJ or feature changed in the files

An edit to a CUJ's outcomes, or to a feature's Gate or Harm lines, makes the cases built on it
suspect. List every case numbered for that CUJ, or whose `Feature:` is that feature, and check each
against the new text: rewrite it, add the missing negative case, or retire it if its CUJ was
removed. Run the changed cases twice, as above.

## Coverage

Start from `e2e/QUALITY.html`: its "Left open" list (P0 features with no deep case, requirements with no case,
requirements too shallow for their Proof, Fails lines with no case; none with a Gap line) is what
remains to write; then capabilities no
runnable case covers and requirements tested shallower than their Proof. Then list, from the files: screens in `EXPLORE.md` no
feature claims, features in scope with no CUJ, Gate and Harm lines with no negative case, CUJs with
no case, PRD requirements with no CUJ, cases that have not passed in the latest report, and cases
whose `Needs:` names a missing case. Say which matter most (P0 first) and offer to write the
missing cases.

## Documents from before these formats

The command then lists many problems of the same few kinds. Bring the documents up in their order,
rerunning `npx -y @codedroid/mcp e2e report e2e` after each until it prints no problems:
1. `INVENTORY.md` from the UI source, as app-e2e-explore writes it; Seen from what `EXPLORE.md` and
   earlier reports show, `?` for the rest.
2. Each requirement's Caps, Proof and Fails, from the source.
3. Each CUJ's `Proves:` line.
4. Each case's `Covers:`, `Tier:`, `Depth:` and `Run mode:`, from what its Steps and Expected lines
   actually do. Don't change the steps. A setup case needs only its `Run mode:` line: drop the
   `Covers:`, `Tier:` and `Depth:` an older file gave it.
5. A reason an older file gave for a missing case or a shallow one, in free prose, becomes a
   `- Gap: <ref> · reason` line (`R4`, `R1.f2`, `F1 deep` or `R3 depth`, as app-e2e-testcases writes
   it); a capability the PRD left out on purpose becomes a
   `- Non-goal: C<n> · reason` line. The quality page's "Left open" list is then what remains to write.

Existing approvals stay. Tell the user the documents were brought up to date and show them
`e2e/QUALITY.html`.

## Changing an approved file

`CUJs.md` and `TESTCASES.md` carry an `Approved:` line. Show the user what you changed (the diff),
and update the line only when they approve; until then say the file has unapproved changes.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Loosen an Expected line just to make a failing case pass.
