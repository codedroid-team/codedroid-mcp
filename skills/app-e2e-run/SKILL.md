---
name: app-e2e-run
description: Run an app's approved e2e test cases on the real phone through CodeDroid, judge each failure as an app bug, a test bug or the environment, and write a test report with screenshots of every case into e2e/reports/<date>/. Use as step 5 of app-e2e, or when asked to run e2e test cases or CUJs on the phone and report what passed and failed.
---

# Run the cases and report

Input: approved `e2e/TESTCASES.md`. Output: `e2e/reports/<date>/REPORT.md` with a screenshot per
case beside it.

## Before the run

1. `codedroid_status`, `device_info`: connected, unlocked, CodeDroid ready, signed in, no task
   running. Not ready: tell the user; pairing and sign-in are theirs.
2. Read the installed build (`adb` `shell dumpsys package <package>`). Different from the one the
   user approved: ask first. Read it again after every pause.
3. `adb` `logcat -c -b crash`, so crashes read later are from this run.
4. Cases that run a CodeDroid task only with the user's OK for this run.
5. Create `e2e/reports/<date>/` with your own file tools: `adb` pull cannot create a folder, so
   every screenshot would fail without it.

## Each case

1. Put the app in the case's start state: `open_app`, then Back to its first screen. If Back does
   not get there, `adb` `shell am force-stop <package>` (the app under test, never
   com.codedroid.agent) and `open_app` again.
2. Follow the steps with `get_screen`, `tap`, `type_text`, `swipe`, `press_key` and `wait_for`,
   reading `after` each time. A step you cannot do as written fails the case: stop there.
3. While a step runs CodeDroid's own agent (`run_task`), poll `get_task`; when it shows a
   `question`, answer with `answer_task` as the case says, or ask the user if the case does not.
4. Check each Expected line on `get_screen`, or `take_screenshot` for anything visual.
5. Save the end state, pass or fail: `adb` `shell screencap -p /sdcard/e2e-shot.png`, then `adb`
   `pull /sdcard/e2e-shot.png e2e/reports/<date>/<case>.png`. Without adb, describe the screen.
6. Run the cleanup even after a failure, then `adb` `logcat -d -b crash`: a new line for the app
   fails the case.

## Each failure: read before you judge

| What you see | It is | Then |
| --- | --- | --- |
| A label, flag or screen the case assumed is not there, though the app works when you look | Test bug | Fix the case; rerun |
| The check ran too early or matched the wrong thing (your own typed text, cut text) | Test bug | Fix the step; rerun |
| Data you did not make, another build, a dropped link, a server error | Environment | Restore, rerun, note it |
| The app shows the wrong thing, again on a rerun | App finding | Root cause in the source; ask before fixing |

A case that fails once and passes on a rerun is flaky: find which of the first three it is before
calling the run green. Evidence must come from the moment of the failure, not from after a
cleanup changed the screen.

## The report

`e2e/reports/<date>/REPORT.md`:

- A header: build, device, account, date; passed / failed / not run.
- A table by priority.
- Each failure: the case, the step that failed, what the screen showed, its class, and its
  screenshot (`![TC-12a](TC-12a.png)`).
- Every case in one table: result, priority, title, and "passed after N tries" where it took
  reruns; earlier failed attempts listed under it with their cause.
- Findings with their status, what is not covered, and the release answer.

Rerun every case that does not run a CodeDroid task once more after any fix to a case, and report
the last result. Give the user the report's path.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Tap delete, clear, remove, sign out or purchase on anything the cases did not make.
