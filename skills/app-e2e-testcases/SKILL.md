---
name: app-e2e-testcases
description: Turn an app's approved CUJs into test cases an agent can run on the real phone through CodeDroid - start state, steps by exact label, expected outcomes, cleanup, with negative cases for each feature's gates and harmful controls - into e2e/TESTCASES.md. Use as step 4 of app-e2e, when asked to write or plan test cases, or when e2e cases are flaky, pass by accident, or leave data behind.
---

# Write the test cases

Input: approved `e2e/CUJs.md`, `e2e/EXPLORE.md`. Output: `e2e/TESTCASES.md`. The app-e2e-run skill
runs them with CodeDroid's tools.

## A case

```markdown
### TC-12a · P0 · Use a skill with a blank: the prompt lands in the composer, not sent
Feature: F3 · Type: happy
Covers: R8 (C17, C18), R8.f1 (C18)
Tier: core · Depth: elsewhere
Run mode: phone
Needs: TC-10 (makes e2e-timer)
Start: Chat, a new empty session.
Steps:
1. Tap the Skills tab (`content_description` "Skills"), then "My skills".
2. Tap "Search my skills", type "e2e-tim", tap "e2e-timer".
3. Check "Use Skill" is disabled; tap "Minutes", type "1"; tap "Use Skill".
Expected:
- The composer shows "Open Clock and set a timer for 1 minutes".
- No "Working" row: nothing was sent.
Cleanup: clear the composer.
```

- Number by CUJ (TC-12a for CUJ-12). `Run mode:` is `phone`, `task` when the case makes CodeDroid's
  own agent run something, or `manual` (the PRD's scale).
- `Covers:` the requirement and failure ids it checks, each with the capabilities it taps in
  brackets, taken from that requirement's `Caps:`.
- `Tier:` the kind of scenario. `smoke`: the screen or control is there and opens. `core`: the
  main action on the plain path. `deep`: an extended scenario of the main action: several items,
  large or awkward data, a long sequence of steps, or state carried across leaving and reopening
  the app. `edge`: failure, recovery, interruption (app killed, backgrounded, connection lost
  midway), limits.
- `Depth:` the deepest place its Expected lines check, on the PRD's Proof scale. The two are
  independent: a core case can check `kept`, a deep case only `screen`. A requirement whose
  cases all look shallower than its Proof is not tested deep enough: a `kept` one needs a case
  that reopens the app (`adb` `shell am force-stop <package>` of the app under test, `open_app`)
  and checks again.
- Every Fails line of a P0 or P1 requirement is in some case's `Covers:`, usually an `edge` case
  (cut the network, cancel, bad input, reach the limit), or has a reason under the file's gaps.
- Every P0 feature has at least one `deep` case, or a reason under the file's gaps.
- `Feature:` is the PRD feature of its CUJ. `Type:` is `happy` (the journey works), `negative`
  (the app refuses or protects, and says so) or `setup` (a case that only prepares or cleans up,
  with `Feature: all`).
- Every Gate and Harm line in the PRD gets a negative case: the gate blocks with its words; the
  harmful control asks before acting, and Cancel leaves the test's own item there. Never confirm
  harm on data the cases did not make. A control that acts at once (no confirm, no undo) has
  nothing to cancel: note it under gaps, and ask the user whether it should ask first.
- A harmful control that acts on everything at once (clear all, delete played, remove all) puts
  the user's data one mis-tap away. Its case reads the list first and, if anything there is not the
  test's own, stops as not run (environment). Tap the dialog's cancel by its label, never by
  position.
- A Gate or Harm line with no case says why under the file's gaps (needs a drag, a second
  account, a non-goal).
- Expected lines are outcomes on the screen or in the app, exact words in quotes. Not how it got
  there, and nothing that changes with the screen or the clock.

## Rules that came from cases failing for the wrong reason

| Do | Because |
| --- | --- |
| Select by the exact label from `EXPLORE.md`; by `content_description` for icons | Guessed labels fail as not_found |
| Read disabled/checked from the clickable parent line | The flag is not on the label's own line |
| Skip a tap on a tab that is already selected; hide the keyboard before tapping a tab | A selected tab is not clickable; the keyboard covers the tab bar |
| Find list items by searching a prefix, then tap the full name | Long lists hide rows; the search box holds the full name too, so the tap is ambiguous |
| Tap a row's menu by the row it belongs to, never "the first More" | Shared phones have rows the test did not make |
| `wait_for` content that loads after a screen opens | A tap right away misses it |
| `wait_for` text no other state shows ("In the inbox" is inside "No episodes in the inbox") | It matches substrings, so it passes on the empty state |
| Wait for the end state ("Delete"), not `gone_text` of the busy one ("Cancel download") | `gone_text` passes before the busy text has appeared |
| Match times loosely ("9:00" then "a.m.") | Android puts a narrow no-break space before "a.m." |
| Ask the agent to put the checked fact first in its reply | `get_screen` cuts text at 120 characters |
| Assert on a result row, not on the text you just typed | The search box shows your own query |
| A first case that removes every `e2e-...` item an interrupted run left | Leftovers make the next run ambiguous |
| Make a case that needs another case's result say so (Needs:) | Run alone, it fails for the wrong reason |
| Pick a result by its title plus a second field (uploader, length) | Search results repeat titles |
| End playback in the cleanup of any case that starts it | A paused player keeps its notification and the next case starts on it |
| Expect upper-case dialog buttons where EXPLORE saw them | The screen can upper-case a source string |

## Rules that keep it safe

- Everything a case creates is named `e2e-...` and removed by the case that ends with it. Data the
  app gets from elsewhere (a feed, a catalog) cannot be named: use the items the PRD's Constraints
  call the test's own, found by an exact second field (feed title, uploader).
- `task` cases: read-only instructions (the battery level, wait N seconds), or reversible ones.
- Nothing that sends, buys, posts, publishes or deletes data the cases did not make.
- Never force-stop, clear or uninstall com.codedroid.agent.

## Before handing to the user

Run `npx -y @codedroid/mcp e2e report e2e`; it must print no problems before you go on (fix each
`file:line: message` and rerun).
Give the user `e2e/TESTCASES.html` to review and `e2e/QUALITY.html` for what no runnable case
covers. List the cases by feature, with priority, type and which run a CodeDroid task; the CUJs left
without a case and the Gate and Harm lines left without a negative case, and why. Ask for
approval before running.
