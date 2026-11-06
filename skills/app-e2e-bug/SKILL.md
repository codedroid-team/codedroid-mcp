---
name: app-e2e-bug
description: Turn a reported Android app bug into an e2e test case that reproduces it on the real phone through CodeDroid - fails on the current build, passes once fixed, and stays in e2e/TESTCASES.md as a regression test - with the root cause found in the source. Use when the user reports a bug in an app, asks to reproduce one, or wants a regression test for a bug or a fix.
---

# A test case for a bug

Output: a new case in `e2e/TESTCASES.md` that fails on the current build for the reason the bug
says, and the bug's root cause. Read the app-e2e-testcases skill's rules for writing a case and
the app-e2e-run skill's for running one first.

## 1. Pin the bug down

From the report (the user, an issue, a crash log), write down: the build, the start state, the
steps, what happened and what should have. Ask for what is missing rather than guessing. If there
is no `e2e/` yet, create it with just `TESTCASES.md`.

## 2. Reproduce it by hand

Walk the steps on the phone with `get_screen`, `tap`, `type_text` and `wait_for`, reading each
screen; `adb` `logcat -c -b crash` before and `logcat -d -b crash` after, for a crash. Record the
exact labels you saw. No repro after two careful tries: say so, with what you saw, and stop. A bug
you cannot show is not a test yet.

## 3. Write the case

Number it after the CUJ it belongs to (or `TC-B<n>` when none fits), title it with the behavior
that should hold, not the bug ("Delete a skill from search leaves the list correct"), and add a
line `Bug: <link or one line>`. The Expected lines state the correct behavior, so the case fails
now and passes once fixed. Everything it creates is named `e2e-...` and removed in its cleanup.

## 4. Prove it red

Run the case twice, as app-e2e-run does (its "Before the run" too), with its screenshots and notes
in a folder of its own, `e2e/reports/<date>-bug-<case>/`, so a full run's report of the same day
stays as it was. It must fail both times, at the Expected line the bug
breaks, with the evidence (screen text, screenshot, crash line). Failing elsewhere means the case
is wrong: fix it and run again.

## 5. Root cause

Find where the source does it, and say file and line. Ask the user before fixing. A fix goes on its
own branch, and this case is its test: it must pass twice on the fixed build, and the cases on the
same screens (the app-e2e-rerun skill) must still pass.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Reproduce a bug by sending, buying, posting or deleting real data without asking the user.
