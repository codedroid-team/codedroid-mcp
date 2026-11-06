---
name: app-e2e-maintain
description: Keep an app's e2e test cases and CUJs current after the app changes - update labels and steps from the source and the phone, retire cases for removed features, add cases for new screens, and list the CUJs and requirements nothing tests. Use when test cases fail because the UI changed, when asked to update, fix or clean up test cases, after a feature is added or removed, or to find gaps in test coverage.
---

# Maintain the test cases

Input and output: `e2e/EXPLORE.md`, `e2e/CUJs.md` and `e2e/TESTCASES.md` in the app's repo. Read
the app-e2e-explore and app-e2e-testcases skills' rules first: a label you did not see on screen
or in the source is a guess.

## A case failed because the UI changed

1. Confirm it is the UI, not a bug: the old label or screen is gone from the source (`git log -p`
   on the file shows it renamed or moved), and the journey still works when you walk it on the
   phone with `get_screen` and `tap`.
2. Behavior changed, not just wording? That may be a bug or a product decision: ask the user before
   rewriting the Expected lines to match what the app does now.
3. Update the steps and Expected lines with the labels you saw, and `EXPLORE.md` with them.
4. Run the case twice, as app-e2e-run does; it must pass both times.

## A feature was added or removed

- Removed: mark its cases `Retired: <date> - <why>` instead of deleting them, and its CUJ in
  `CUJs.md`; leave them out of runs.
- Added: explore its screens (as app-e2e-explore does), add its CUJ (as app-e2e-cujs does, with the
  user's review), then its cases (as app-e2e-testcases does, with the user's approval).

## Coverage

List, from the files: CUJs with no case, PRD requirements with no CUJ, cases that have not passed
in the latest report, and cases whose `Needs:` names a missing case. Say which matter most (P0
first) and offer to write the missing cases.

## Changing an approved file

`CUJs.md` and `TESTCASES.md` carry an `Approved:` line. Show the user what you changed (the diff),
and update the line only when they approve; until then say the file has unapproved changes.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Loosen an Expected line just to make a failing case pass.
