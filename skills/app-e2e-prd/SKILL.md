---
name: app-e2e-prd
description: Write the test PRD for testing an Android app end to end with CodeDroid - the release question, journeys in scope, non-goals, constraints of driving a real phone, priorities, the app's features with every screen assigned to one, numbered requirements per feature and release criteria - into e2e/PRD.md. Use as step 2 of app-e2e, or when a test effort needs its scope and release criteria written down.
---

# Write the test PRD

Input: `e2e/EXPLORE.md`, `e2e/INVENTORY.md` and the app's docs. Output: `e2e/PRD.md`. It is a PRD
for the test effort, not for the app. Keep it short: names and numbers over adjectives.

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
6. **Features and requirements**: the app's features (below), each with its requirements, numbered
   across the file (R1, R2...), each a behavior a CUJ will prove.
7. **Release criteria**: e.g. every P0 CUJ passes, nothing new in the crash buffer, every finding
   triaged. A property of the whole run (no crash) goes here, not in a requirement: a requirement
   sits under a feature and names the capabilities it uses.
8. **Open questions** for the user.

## Features

A feature is what the app lets a user do, named after the surface or action they see ("Skills",
"Downloads", "Sign-in"), never an umbrella ("User experience", "Core functionality").

```markdown
### F3 · Skills · P0
What: save a prompt, fill its blanks, run it.
Screens: Skills tab, My skills, "New skill" sheet, Skill sheet, "Fill In" sheet.
Gates: sign-in ("Sign in to save skills"); "Use Skill" disabled until every blank is filled.
Harm: "Delete skill" on the skill sheet's menu.
- R7 · A saved skill appears under "My skills".
  Caps: C14
  Proof: kept
  Fails:
  - R7.f1 · signed out, "Save" shows "Sign in to save skills" and saves nothing
  - R7.f2 · a server error shows "Couldn't save skill" and keeps the sheet open
- R8 · "Use Skill" puts the filled prompt in the composer without sending it.
  Caps: C17, C18
  Proof: elsewhere
  Fails:
  - R8.f1 · "Use Skill" stays disabled until every blank is filled

## Non-goals
- Non-goal: C19 · needs a second account
```

Each requirement carries three lines, read from the handlers in the source, not from the labels:
- `Caps:` the `INVENTORY.md` capabilities it uses.
- `Proof:` how far its effect reaches: `screen` (only this screen changes), `elsewhere` (it shows
  somewhere else: another screen, a notification, a file, the server) or `kept` (stored, and must
  survive reopening the app). Code that writes to storage or the network is never `screen`.
- `Fails:` what the code does when it goes wrong (no connection, a server error, cancel, bad input,
  a limit), one `R<n>.f<m>` line each with its exact message; or `Fails: none in source` once you
  have read the handler and what it calls to the end and found none. A handler you only skimmed
  gets `Fails: not traced yet`; trace it before the cases are written. These become the edge
  cases; a suite without them tests only the happy path.

- Every screen in `EXPLORE.md` belongs to exactly one feature. Tabs, menus and other navigation
  are not features: a screen goes to the feature it serves. A screen that fits none goes under
  **Unassigned** with the reason; before handing the PRD over, make it a feature or a non-goal.
- Priority from the scale above: the worst a broken feature does to a user.
- Gates are what blocks the user (sign-in, a permission, a plan limit, a disabled button) and Harm
  is the controls one tap from harm, both from `EXPLORE.md` with their exact words. The test cases
  give each one a negative case. A gate the run cannot reach (mobile data on a Wi-Fi phone, a plan
  limit the account never hits) goes under Non-goals with why.
- Data the tests cannot name `e2e-...` (a public feed, a catalog, a server's own items): say in
  Constraints which items are the test's own, and how the cases make and remove them.
- A feature with no requirement is out of scope: say so under Non-goals.
- Every capability in `INVENTORY.md` is in some requirement's `Caps:`, or in a Non-goal line (the
  example above, under the Non-goals heading): `- Non-goal: C40, C41 · why`. A capability you will
  not test is named there with its reason; one in both places is a problem. The quality page lists
  the rest as "not in any feature" and counts percentages over the capabilities not set aside.
- Then run `npx -y @codedroid/mcp e2e report e2e`; it must print no problems before you go on.
  Fix each one it prints as `file:line: message`, and rerun.

## For a release

Add the checks a release adds, usually manual: a fresh install through first run and sign-in, an
upgrade over the previous release keeping data and sign-in, the release build's own sign-in and
update path. Say who runs each.

## Rules

- A requirement about a behavior `EXPLORE.md` only inferred (marked `?`, or written from a hunch
  rather than seen or read in the source) is checked in the source before it goes in, or marked `?`
  for the first run to confirm. A guessed behavior becomes a case that fails for the wrong reason.
- Every requirement must be observable on the phone. If nothing on screen can show it, say how it
  will be checked instead, or make it a non-goal.
- Never force-stop, clear or uninstall com.codedroid.agent.
