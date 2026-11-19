---
name: app-e2e-run
description: Run an app's approved e2e test cases on the real phone through CodeDroid, judge each failure as an app bug, a test bug or the environment, and write a test report with screenshots of every case into e2e/reports/<date>/. Use as step 5 of app-e2e, or when asked to run e2e test cases or CUJs on the phone and report what passed and failed.
---

# Run the cases and report

Input: approved `e2e/TESTCASES.md`. Output: `e2e/reports/<date>/REPORT.md` with a screenshot per
case beside it. A case the verifier has not approved may still be run; passing does not approve it.

## Before the run

Every `adb` below is the local bridge's tool. Without it (the remote connector, or adb turned
off), run the same adb commands with your own shell tool when the phone is on this computer's
adb; otherwise do without: read the build from `device_info` and `list_apps`, save screenshots
from `take_screenshot` with your file tools, force-stop by Back and Recents, and say in the
report which checks adb would have made.

1. `codedroid_status` (local bridge) or `codedroid_devices` (remote connector), then
   `device_info`: connected, unlocked, CodeDroid ready, signed in, no task
   running. Not ready: tell the user; pairing and sign-in are theirs. Locked behind a PIN, pattern or
   password: ask the user to unlock it, and never type it yourself. With more than one device on
   adb (`adb devices`), pass `-s <serial>` on every `adb` command: without it adb answers from any
   of them, and an app "missing" on the wrong device is not missing.
2. Read the installed build (`adb` `shell dumpsys package <package>`). Different from the one the
   user approved: ask first. Read it again after every pause.
3. `adb` `logcat -c -b crash`, so crashes read later are from this run.
4. Cases that run a CodeDroid task only with the user's OK for this run.
5. Create `e2e/reports/<date>/` in the repo you are working in, with your own file tools: `adb`
   pull cannot create a folder, so every screenshot would fail without it. A full run's folder is the
   zero-padded date alone; the quality numbers read the newest such folder.

## Each case

A `manual` case is never run: give it a `not run` row with its `Why manual:` reason, and never
follow its steps. Run the setup cases and each case's `Needs:` before the cases that need them,
wherever they sit in the file.
1. Put the app in the case's start state: `open_app`, then Back to its first screen. If Back does
   not get there, `adb` `shell am force-stop <package>` (the app under test, never
   com.codedroid.agent) and `open_app` again.
2. A case that has `e2e/flows/<case>.yaml` from an earlier run: `run_flow` it first; when it
   passes, check the Expected lines on the screen it leaves and move on; when it fails, drive the
   rest by hand from the step it names, then record the case again from its start state.
   Otherwise, with the local bridge, `record_start` with the case id as `name`, then `open_app`
   once more, so the flow starts by launching the app. Follow the steps with `get_screen`, `tap`,
   `type_text`, `swipe`, `press_key` and `wait_for`, reading `after` each time. A step you cannot
   do as written fails the case: stop there.
3. While a step runs CodeDroid's own agent (`run_task`), poll `get_task`; when it shows a
   `question`, answer with `answer_task` as the case says, or ask the user if the case does not.
   A task started from the composer keeps acting tools `busy`, so its steps tap with `adb` `shell
   input tap`: check in the same command that CodeDroid is in front, e.g. `shell dumpsys window |
   grep "mCurrentFocus=.*<package>" >/dev/null && input tap <x> <y>` (`grep -q` makes dumpsys
   print a harmless "Broken pipe"), with the position from a `get_screen`
   read just before. The agent can switch apps between your read and your tap, and a tap that lands
   in another app does something real there.
4. Hide the keyboard (`press_key` back) only when `after` says it is up: Back with no keyboard
   leaves the screen. It covers the tab bar, so hide it before tapping a tab.
5. Check each Expected line on `get_screen`, or `take_screenshot` for anything visual. A message
   that shows for a moment (a snackbar, a toast) is read with `get_screen` right after the step
   that shows it: `wait_for` can miss it.
6. When the case passed by hand, `record_stop` with `save_to` `e2e/flows/<case>.yaml` (the
   remote connector has no recording: skip this). A flow with a `codedroidTask` step runs only in
   CodeDroid; the others run in Maestro too. Commit the flows with the report.
7. Save the end state, pass or fail: `adb` `shell screencap -p /sdcard/e2e-shot.png`, then `adb`
   `pull /sdcard/e2e-shot.png <absolute path of the report folder>/<case>.png`. Use the absolute path
   of the folder you write REPORT.md in: `adb` resolves a relative one from the folder its server was
   started in, which can be another checkout (a git worktree's main repo). The bridge pulls only into
   the session's folder or the temp directory: when the report folder is elsewhere, or `adb` refuses
   the path, pull into the temp directory and move the file with your file tools.
   Without adb, describe the screen.
   A case with two states to show (before and after) saves one each: `<case>-<state>.png`.
8. Run the cleanup even after a failure, then `adb` `logcat -d -b crash`: a new line for the app
   fails the case. For apps that play media, check nothing is left: `adb` `shell dumpsys
   media_session`, and `shell dumpsys notification | grep "NotificationRecord(.*pkg=<package>"`
   (a bare grep also matches the notification archive).

## Each failure: read before you judge

| What you see | It is | Then |
| --- | --- | --- |
| A label, flag or screen the case assumed is not there, though the app works when you look | Test bug | Fix the case; rerun |
| The check ran too early or matched the wrong thing (your own typed text, cut text) | Test bug | Fix the step; rerun |
| Data you did not make, another build, a dropped link, a server error | Environment | Restore, rerun, note it |
| The app shows the wrong thing, again on a rerun | App finding | Root cause in the source; ask before fixing |

In an approved `TESTCASES.md` a test bug is not fixed mid-run: report the case `fail` with its
class, test bug, and fix it afterwards through the app-e2e-maintain skill's "Changing an approved
file" (the user approves the change), then rerun it.

A case that fails once and passes on a rerun is flaky: find which of the first three it is before
calling the run green. Evidence must come from the moment of the failure, not from after a
cleanup changed the screen.

A run that pauses (the session stops, the phone locks): read the build again, look at the app's
state, put back what a half-done case changed, and rerun that case from its start. It stays one run
with one report; say in Notes which cases ran after the pause.

## The report

`e2e/reports/<date>/REPORT.md`. A run that stops early still writes it, with `not run` for the
cases it did not reach: a dated report folder with no `REPORT.md` is a problem.

- A header: build, device, account, date; passed / failed / not run. Without adb, say what the run
  could not check: the installed build, the crash buffer, the screenshot files.
- A table by priority, and one by feature (from each case's `Feature:` line): passed / failed /
  not run per feature, so a feature with nothing run shows.
- Each failure: the case, the step that failed, what the screen showed, its class, and its
  screenshot as a thumbnail linked to the full image:
  `<a href="TC-12a.png"><img src="TC-12a.png" alt="TC-12a" width="300"></a>` (width 120 inside
  a table row). A plain `![TC-12a](TC-12a.png)` shows a phone screenshot at full size.
- Every case in one table, with exactly these columns; it must be the report's only table that
  starts with Case and Result (a failure's own section is prose, or a table with other first
  columns). Result is `pass`, `fail` or `not run`; "passed after N tries" goes in
  Notes, earlier failed attempts are listed under the table with their cause.

```markdown
| Case | Result | Priority | Title | Notes |
| --- | --- | --- | --- | --- |
| TC-00 | pass | P1 | Remove every e2e-... skill an earlier run left | |
| TC-12 | pass | P1 | Save a skill: it appears under "My skills" | |
| TC-12a | pass | P0 | Use a skill with a blank: the prompt lands in the composer, not sent | passed after 2 tries |
```

- Findings with their status, what is not covered, and the release answer.

After fixing a case, rerun it and every case that `Needs:` it, and report the last result with
"passed after N tries". Rerun the whole suite only when a fix changed a shared step (the start
state, a common cleanup) or before a release verdict. A bug you find mid-run that no case covers:
add a case for it to `TESTCASES.md` (if it is approved, the app-e2e-maintain skill's "Changing an
approved file" applies), run it twice, and say in the report that it was added. Anything the run left that
only "clear all" would remove: list it under cleanup, don't clear it.

Then run `npx -y @codedroid/mcp e2e report e2e` (documents in another folder: pass that folder in
place of `e2e`; `Unknown command: e2e` means the release is older than these skills: tell the user
and go on without it). Exit 1 means the documents have problems, printed as `file:line: message`:
fix them and rerun until it prints none. If the documents were written
before these formats, stop: with the user's OK, follow the app-e2e-maintain skill's "Documents
from before these formats" first. Never rewrite approved documents at the end of a run on your own.
It writes `REPORT.html` beside the report and refreshes `QUALITY.html`; never edit those, and
commit them with the report. Give the user the path of `REPORT.html`.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Tap delete, clear, remove, sign out or purchase on anything the cases did not make.
