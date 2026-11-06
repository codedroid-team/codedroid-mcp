---
name: app-e2e-prd
description: Write the test PRD for testing an Android app end to end with CodeDroid - the release question, journeys in scope, non-goals, constraints of driving a real phone, priorities, numbered requirements and release criteria - into e2e/PRD.md. Use as step 2 of app-e2e, or when a test effort needs its scope and release criteria written down.
---

# Write the test PRD

Input: `e2e/EXPLORE.md` and the app's docs. Output: `e2e/PRD.md`. It is a PRD for the test effort,
not for the app. Keep it under two pages: names and numbers over adjectives.

## Sections, in this order

1. **Goal**: the release question this run answers, in one sentence.
2. **Users and journeys in scope**: who uses the app and the areas they touch.
3. **Non-goals**: what this run will not test, and why (real payments, a second account, load).
4. **Constraints**: the build, server and account; what a task costs if the app's own work costs
   anything; and what driving the phone through CodeDroid cannot do:
   - While CodeDroid's own agent runs a task (`run_task`), acting tools answer `busy`; read with
     `get_screen` and `get_task`, answer its questions with `answer_task`.
   - Signing out, removing this computer in CodeDroid's Settings, force-stopping CodeDroid or
     `am instrument` on it cut the link; turning the phone's network off does too.
   - Toasts are gone before you can read them; `get_screen` cuts text at 120 characters.
   - The phone may be shared.
5. **Priorities**: P0 = a new user is blocked or loses data; P1 = a main journey is degraded;
   P2 = the rest. Run modes: `phone` (drivable over CodeDroid), `task` (needs CodeDroid's agent to
   run something), `manual` (needs a wipe, a second account, a real payment or a store build).
6. **Requirements**: numbered (R1, R2...), each a behavior a CUJ will prove.
7. **Release criteria**: e.g. every P0 CUJ passes, nothing new in the crash buffer, every finding
   triaged.
8. **Open questions** for the user.

## For a release

Add the checks a release adds, usually manual: a fresh install through first run and sign-in, an
upgrade over the previous release keeping data and sign-in, the release build's own sign-in and
update path. Say who runs each.

## Rules

- Every requirement must be observable on the phone. If nothing on screen can show it, say how it
  will be checked instead, or make it a non-goal.
- Never force-stop, clear or uninstall com.codedroid.agent.
