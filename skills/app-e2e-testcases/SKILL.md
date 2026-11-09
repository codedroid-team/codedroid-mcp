---
name: app-e2e-testcases
description: Turn an app's approved CUJs into test cases an agent can run on the real phone through CodeDroid - start state, steps by exact label, expected outcomes, cleanup - into e2e/TESTCASES.md. Use as step 4 of app-e2e, when asked to write or plan test cases, or when e2e cases are flaky, pass by accident, or leave data behind.
---

# Write the test cases

Input: approved `e2e/CUJs.md`, `e2e/EXPLORE.md`. Output: `e2e/TESTCASES.md`. The app-e2e-run skill
runs them with CodeDroid's tools.

## A case

```markdown
### TC-12a · P0 · Use a skill with a blank: the prompt lands in the composer, not sent
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

- Number by CUJ (TC-12a for CUJ-12). Mark a case `task` when it makes CodeDroid's own agent run
  something.
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
| Match times loosely ("9:00" then "a.m.") | Android puts a narrow no-break space before "a.m." |
| Ask the agent to put the checked fact first in its reply | `get_screen` cuts text at 120 characters |
| Assert on a result row, not on the text you just typed | The search box shows your own query |
| A first case that removes every `e2e-...` item an interrupted run left | Leftovers make the next run ambiguous |
| Make a case that needs another case's result say so (Needs:) | Run alone, it fails for the wrong reason |

## Rules that keep it safe

- Everything a case creates is named `e2e-...` and removed by the case that ends with it.
- `task` cases: read-only instructions (the battery level, wait N seconds), or reversible ones.
- Nothing that sends, buys, posts, publishes or deletes data the cases did not make.
- Never force-stop, clear or uninstall com.codedroid.agent.

## Before handing to the user

List the cases with priority and which run a CodeDroid task, and the CUJs left without a case and
why. Ask for approval before running.
