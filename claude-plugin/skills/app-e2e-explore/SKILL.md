---
name: app-e2e-explore
description: Explore an Android app before testing it end to end with CodeDroid - read its UI source for every label, walk each screen on the real phone read-only, and write e2e/EXPLORE.md with exact selectors, traps and account state, and e2e/INVENTORY.md listing every screen and control with what its handler does. Use as step 1 of app-e2e, or when test cases fail with not_found or ambiguous because a label or screen was guessed.
---

# Explore the app

Output: `e2e/EXPLORE.md` and `e2e/INVENTORY.md` in the app's repo.
Change nothing on the phone in this step beyond
navigating, with one exception: a screen that needs data to exist (a subscription, a deck, a
queue) may get one item named `e2e-...`, removed before the walk ends. Opening content to look at
it (a video, a feed preview) counts as navigating; stop any playback after. A screen you could not
reach is marked `?` and confirmed in the first run.

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
- One-time sheets and first-run screens a fresh account sees, and what dismisses them,
  including system permission screens that block the app until granted (all files access,
  notifications).
- Screens restored from the back stack: go to a tab, change its data elsewhere, come back.
  A stale list there is a finding, and a case needs to know which state it starts in.
- What a fresh install leaves that only "clear all" removes (search history), so cases can say so.
- The account the tests will meet: existing items, plan and credits, anything that differs on a
  new account (a first-run brief, a welcome sheet).

## The capability list: `e2e/INVENTORY.md`

Coverage is counted against this list: a control left out is never tested, and nothing shows it
missing. Write it from the UI source before the walk: one heading per screen, one row per control a
user can act on, including those only some states show (an error, an empty list, a menu, a dialog).

```markdown
## S6 · SkillComposerSheet · "New skill"
| Id | Control | Does | Source | States | Seen |
| --- | --- | --- | --- | --- | --- |
| C14 | text "Save" | uploads the skill, then lists it under "My skills" | app/src/main/java/skills/SkillComposerSheet.kt:141 | disabled while the name is empty; signed out: "Sign in to save skills"; error "Couldn't save skill" | yes |

## S7 · FillInSheet · "Fill In"
| Id | Control | Does | Source | States | Seen |
| --- | --- | --- | --- | --- | --- |
| C17 | text field per blank ("Minutes") | holds that blank's value | app/src/main/java/skills/FillInSheet.kt:58 | | yes |
| C18 | text "Use Skill" | puts the filled prompt in the composer, unsent | app/src/main/java/skills/FillInSheet.kt:96 | disabled until every blank is filled | yes |
| C19 | description "Share" | sends the skill to another account | app/src/main/java/skills/FillInSheet.kt:120 | | no: needs a second account |
```

- Ids `S<n>` and `C<n>`, each unique in the file; the heading names the screen's class, then
  its title on screen in double quotes, and nothing after the closing quote. A screen whose title
  is data (an episode page, a mini player) takes a string that stays on it, or a placeholder such
  as `<episode title>`; notes go in the table, not the heading.
- One row per control: a menu's items are one row each, never one row for the menu.
- Does and Source come from the handler (the click listener and what it calls), with file:line,
  never from the label: a "Save" may upload, store locally or only close the sheet. A control the
  framework supplies (Navigate up, a tab bar) cites the file that declares it (the menu or layout
  XML, the activity), not a nearby line.
- States: when it is disabled or hidden, and every message its handler can show, in exact words.
  The PRD turns these into failure lines.
- Seen: `yes` once a walk on the phone shows it (this one, or an earlier recorded one), `no: <why>`
  when it cannot (needs data, an account, a state), `?` until then.

Then run `npx -y @codedroid/mcp e2e report e2e`; it must print no problems before you go on. Fix
each one it prints as `file:line: message`, and rerun.

## Rules

- A label you did not see on screen or in the source is a guess: mark it `?`.
- Evidence you read must come from the state you are describing: a screen read after something
  else changed it (a tab switched, a dialog closed) proves nothing about the earlier state.
- Two places in `EXPLORE.md` that disagree: the one a walk on the phone confirmed wins; correct
  the other and say so.
- Never force-stop, clear or uninstall com.codedroid.agent.
