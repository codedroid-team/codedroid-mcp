---
name: app-e2e
description: End-to-end test an Android app on the user's real phone through CodeDroid, from exploring the app to a release verdict - explore, write a test PRD, critical user journeys (CUJs) and test cases into the app's repo, run them on the phone and report with screenshots. Use when asked to test an app end to end, prepare it for a release, write or run its CUJs or test cases, or for /app-e2e.
---

# App e2e

The run is five steps, each its own skill. Run them in order and stop at the two gates:

| Step | Skill | Writes (in the app's repo) | Then |
| --- | --- | --- | --- |
| 1 | app-e2e-explore | `e2e/EXPLORE.md` | go on |
| 2 | app-e2e-prd | `e2e/PRD.md` | go on |
| 3 | app-e2e-cujs | `e2e/CUJs.md` | **Gate 1: the user reviews the CUJs.** Stop until they approve or edit. |
| 4 | app-e2e-testcases | `e2e/TESTCASES.md` | **Gate 2: the user approves the cases, and any that run a CodeDroid task.** |
| 5 | app-e2e-run | `e2e/reports/<date>/REPORT.md` and screenshots | report (below) |

Load each step's skill when you reach it; this table is not the step.

Once `e2e/` exists, the everyday jobs have their own skills: app-e2e-rerun (run some cases: by id,
CUJ, priority, last failures, a change; a flaky check; two builds), app-e2e-bug (a case that
reproduces a bug) and app-e2e-maintain (update cases after the app changes; coverage gaps). The codedroid-phone skill
covers driving the phone; read it first if you have not.

## Where everything lives

`e2e/` at the root of the app's repo (or the folder the user names), committed and reviewed like
code. On start, read what is already there. Test documents somewhere else (a gitignored folder,
another format, an older run's own runner)? Say where they are and ask: move them into `e2e/`
(their approvals carry over) or keep working where they are. Don't silently write a second set. A document is approved when its first line reads
`Approved: <date> by the user`; write that line only after the user says so. An approved step is
done: say so and go on from the first step that is not. A document without the line is a draft:
show it and ask whether it still holds before building on it.

Also on start, ask which build is the release candidate and which server or account it uses,
unless the user said. Check that the installed build is that one (`adb` `shell dumpsys package
<package>`: versionCode and lastUpdateTime), and that the package name in the code is the one
installed: a renamed package installs as a second app, with its own sign-in and setup.

## The phone

- It may be shared with other people or agents. Before phone work and after any pause, read the
  installed build again; if it changed, someone else is using the phone: stop and tell the user.
  The build can stay the same while another agent drives the phone: before each action, check
  the app in front, as the codedroid-phone skill says under "A shared phone".
- Expect data you did not make (other sessions, files, schedules). Never act on it: find your own
  items by the name you gave them.
- Ask before installing, uninstalling (it deletes the app's data) or rebooting.
- Never sign in, type passwords or pay. The user picks the account; you tap through what follows.
- Name everything a test creates `e2e-...`, remove it in the same test, and leave the phone as you
  found it.

## Findings

A finding is something the app does wrong, shown by a case that fails the same way twice, whose
evidence (screen text, screenshot, log) you have read. A case that failed because of how it was
written or run is not a finding: fix the case, rerun, and say what was wrong with it. For each
finding, find the root cause in the source, then ask the user before fixing it. A fix goes on its
own branch, with the failing case as its test.

## Report

End with: the build tested; counts (passed / failed / not run, with why); each finding with its
evidence and status (fixed, or open); what the cases got wrong and how it was fixed; what is not
covered (manual CUJs); the report's path. Then the release question the results answer.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Write passwords, card numbers or other secrets into any file.
