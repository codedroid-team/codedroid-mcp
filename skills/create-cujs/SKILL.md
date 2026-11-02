---
name: create-cujs
description: Write an Android app's critical user journeys (CUJs) as markdown files in the app's repo - read its code, PRDs and docs, optionally look at the real app on the phone with CodeDroid, then save one file per journey under cujs/. Use when asked to create, list, find or plan CUJs, user journeys or what to test for an app.
---

# Writing an app's CUJs

A CUJ (critical user journey) is something a user comes to the app to get done, start to finish:
"Subscribe to a podcast", "Check out a cart". Each one is a markdown file in the app's repo, next
to its code, so it is reviewed and versioned like code. The create-tests skill adds test cases to
these files, and test-on-device runs them on the phone. Nothing is saved on the phone.

## 1. Find where they go

If the repo already has a `cujs/` folder (or the user named another), use it: read every file
there, so you don't write a journey twice and you match how they are written. Otherwise create
`cujs/` at the root of the app's module or repo.

## 2. Read the app

- What it promises: PRDs, specs, README and docs in the repo, and any the user points you to. A
  journey a PRD names comes first.
- What it does: `AndroidManifest.xml` (package, launcher and deep-link activities), the navigation
  graph or Compose `NavHost` routes, the screens' code, and `res/values/strings.xml` for the names
  the user sees on buttons and titles.
- If the phone is connected and the app installed, look at it: `open_app`, then `get_screen` and
  `tap` through its main screens (the codedroid-phone skill covers driving). Back out of anything
  that sends, buys, posts or deletes. Skip this if the phone is not there; the code is enough.

## 3. Pick the journeys

A handful per app, each named as the user's goal in a few words. Skip settings screens and
one-tap details unless they are what the user asked about. Say the list to the user, with a line
on each, before writing files.

## 4. Write one file per journey

`cujs/<journey-in-kebab-case>.md`, e.g. `cujs/subscribe-to-a-podcast.md`:

```markdown
# Subscribe to a podcast

- App: com.example.podcasts
- Why: The reason most users install the app; the PRD's first goal.
- Starts: The app opened from the launcher, signed in.
- Source: docs/prd.md, ui/search/SearchScreen.kt

The user searches for a show, opens it, and follows it, so new episodes reach their Following tab.

## Tests
```

- Why: what it is worth to the user or the business, so a reader can rank journeys.
- Starts: the state a run begins from (signed in or out, which screen, what data must exist).
- Source: the files you read it from, so the next reader can check.
- Leave `## Tests` empty: create-tests fills it.

## 5. Report

List the files written, one line each. Say what you could not tell from the code (a screen you
could not reach, a PRD goal with no code yet).

## Never

- Force-stop, clear or uninstall com.codedroid.app: it switches CodeDroid off.
- Write passwords, card numbers or other secrets into a file.
