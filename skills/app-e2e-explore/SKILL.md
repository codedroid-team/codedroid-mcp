---
name: app-e2e-explore
description: Explore an Android app before testing it end to end with CodeDroid - read its UI source for every label, walk each screen on the real phone read-only, and write e2e/EXPLORE.md with exact selectors, traps and account state. Use as step 1 of app-e2e, or when test cases fail with not_found or ambiguous because a label or screen was guessed.
---

# Explore the app

Output: `e2e/EXPLORE.md` in the app's repo. Change nothing on the phone in this step beyond
navigating.

## Read before touching the phone

- The app's docs (README, AGENTS.md, docs/) for what it does and how it is built and installed.
- `AndroidManifest.xml` for the package and launcher activity; `build.gradle` for the
  applicationId, which can differ from the source package.
- The UI source: every visible string and content description a test will select by, including
  the ones only some states show (a running task, an error, an empty list, a dialog). Grep them;
  don't remember them. Icon-only buttons have no text, only a description. Compose apps often
  have no `strings.xml` entries: grep the Kotlin.

## Then the phone, read-only

1. `codedroid_status` and `device_info`: connected, unlocked, CodeDroid ready, signed in, no task
   running. If it is not ready, tell the user what is missing; don't fix sign-in yourself.
2. Read the installed build and record it.
3. `open_app`, then walk each screen with `get_screen`; `take_screenshot` only for what the list
   cannot show. Back out with `press_key` back, never by force-stopping.

## What to write down, per screen

- The way in (taps from the first screen) and the way back.
- Each control's exact selector: its `text` or its `content_description`, and which one it is.
- Where state shows. In Compose apps `disabled`, `checked` and `selected` sit on the clickable
  parent line, and the words on an indented child line.
- Traps: a selected tab is not clickable, so a tap on it is refused; the keyboard covers the tab
  bar once a field takes focus; `get_screen` cuts text at 120 characters; lists longer than the
  screen hide rows (search beats scrolling); content that loads a moment after a tab opens; one
  spot that is a different control in different states; a dialog that closes itself and leaves a
  different control under the next tap; times written with a narrow no-break space before
  "a.m." or "PM".
- Controls one tap from harm: delete, clear all, remove, sign out, purchase. Tests must never tap
  them on data the test did not make.
- One-time sheets and first-run screens a fresh account sees, and what dismisses them.
- The account the tests will meet: existing items, plan and credits, anything that differs on a
  new account (a first-run brief, a welcome sheet).

## Rules

- A label you did not see on screen or in the source is a guess: mark it `?`.
- Evidence you read must come from the state you are describing: a screen read after something
  else changed it (a tab switched, a dialog closed) proves nothing about the earlier state.
- Never force-stop, clear or uninstall com.codedroid.agent.
