---
name: test-on-device
description: Verify an Android app change on the user's real Android phone - build, install, open, drive the changed screens with CodeDroid, check logcat for crashes, run instrumentation tests, run the app's CUJ test cases from cujs/, and report what was seen. Use after changing Android app code, when asked to test, reproduce or verify something on a device, to run an app's CUJs or test cases, or before saying an Android change works.
---

# Testing an Android change on the phone

You have two kinds of tools: CodeDroid's (`get_screen`, `tap`, `type_text`, `wait_for`,
`take_screenshot`, ...), which see and drive the screen exactly as it is, and `adb`, which runs
this computer's adb. Use `install_apk` to install; use adb to start and inspect; use CodeDroid to look and act.
The codedroid-phone skill covers driving the screen.

If `adb` is not in your tool list, the user turned it off (`--no-adb` or `CODEDROID_MCP_ADB=0`): ask
them to turn it back on, or to run the adb commands themselves.

## 1. Know the phone

CodeDroid reaches the phone through the CodeDroid server; adb needs it on this computer, over USB
or Wireless debugging. Call `codedroid_status` and `device_info` for the phone's model and
Android `user`, and `adb` `devices -l` to find the same model there. If adb lists none, go on
without it, or ask the user to connect it for logs and instrumentation tests; if it lists several, pass `-s <serial>` to each adb command. On a phone with
several users (a Googlebook runs as user 10), adb's `settings`, `content`, `pm grant` and
`appops` default to user 0: add `--user <user>` to them. `adb install` covers every user.

## 2. Build and install

1. Build with the project's own task, e.g. `./gradlew :app:assembleDebug` (check the module and
   variant names in the project first).
2. Install with `install_apk`: `app/build/outputs/apk/debug/app-debug.apk`. It needs no cable, keeps
   the app's data, and says what went in. A signature mismatch means the phone has another build:
   ask the user before removing it, which deletes the app's data. On a phone attached to adb,
   `install -r -g <apk>` also grants the runtime permissions.
3. If the phone is on adb, `adb` `logcat -c` to clear the logs, so what you read later is from this run.

## 3. Open it and drive the change

1. `open_app` with the package, or `adb` `shell am start -W -n <package>/<activity>`. For a deep
   link: `shell am start -W -a android.intent.action.VIEW -d "<uri>" <package>`.
2. `wait_for` text on the first screen, rather than sleeping.
3. Walk to the changed screen with `get_screen` and `tap` / `type_text` / `swipe`, reading
   `after` each time.
4. Check what the change should show: the text and state in `get_screen` (a switch is `checked`
   or `unchecked`, a field shows its text), and `take_screenshot` for anything visual.
5. Try the edges the change touches: empty input, rotation (`adb` `shell settings put system
   user_rotation 1` after `shell settings put system accelerometer_rotation 0`), dark theme
   (`shell cmd uimode night yes`), back navigation. Put settings back afterwards.

## 4. Check the logs

- Crashes: `adb` `logcat -d -b crash`. A crash kills the process, so read the crash buffer
  rather than filtering by process id.
- Errors: `logcat -d -t 300 *:E`; one app's lines: `shell pidof <package>`, then
  `logcat -d --pid=<pid>`.
- ANRs: `shell logcat -d -b system | grep -A5 "ANR in"` (after `shell`, the pipe runs on the phone).

## 5. Instrumentation tests

`adb` `shell am instrument -w -r -e class <fully.qualified.TestClass> <test-package>/androidx.test.runner.AndroidJUnitRunner`
with `timeout_s` set for the run (install the test APK first:
`./gradlew :app:installDebugAndroidTest`). Each `INSTRUMENTATION_STATUS_CODE` line closes a test:
`0` passed, `-2` failed, `-1` error, `-3` ignored (`1` marks a start). The failing test's
`stack=` comes before its code. Tests that use UiAutomator suspend CodeDroid's accessibility
while they run: call `codedroid_status` before using its tools again.

## 6. CUJ test cases

The app's journeys and their tests are markdown files in its repo, `cujs/` unless the user says
otherwise (the create-cujs and create-tests skills write them). To run them, all or the ones the
user names:

1. Read the CUJ file: its Starts line is where every test begins, and each `###` under
   `## Tests` is one test, with its Steps and Expected lines.
2. `adb` `logcat -c` before the first test, so the crashes you read later are from this run.
3. Put the app in the Starts state before each test: `open_app`, then back to its first screen
   or sign in as Starts says (Back out of the app and `open_app` again is fine too). `open_app`
   resumes the app where it was, and some screens keep Back for themselves: if Back does not get
   there, `adb` `shell am force-stop <package>` (the app under test, never com.codedroid.app)
   and `open_app` again. That keeps its data; don't clear the data to get there without asking.
   If Starts needs an account you have not been given, ask the user.
4. Follow the Steps one at a time with `get_screen`, `tap`, `type_text`, `swipe`, `press_key` and
   `wait_for`, as section 3 does. A step you cannot do as written (the button is not there, the
   screen differs) fails the test: stop it there and say which step. Before a step that would
   send, buy, post or delete for real, ask the user, every time, even though the test says to; if
   they say no, report the test as not run.
5. Check each Expected line against `get_screen`, or `take_screenshot` for anything visual. Each
   line passes or fails on what you saw, not on what the steps should have done.
6. Read the crash buffer after the run, as in section 4.

Report each test as passed or failed, with the failing step or Expected line and what the screen
showed. Leave the files as they are unless the user asks you to update a test that is out of date.

## 7. Report

Say what you checked and what you saw, step by step, and whether the change works. Include a
screenshot when the change is visual, and the crash's stack trace (from `logcat -d -b crash`)
when there was one. If something could not be checked (the phone was locked, a screen could not
be reached), say so rather than guessing.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.app: it switches CodeDroid off.
- Uninstall an app, clear its data, reboot or delete files without asking the user first.
- Stream: `logcat` without `-d` and `screenrecord` without `--time-limit` run until the call
  times out.
