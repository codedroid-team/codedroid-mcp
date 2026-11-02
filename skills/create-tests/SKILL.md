---
name: create-tests
description: Write test cases for an Android app's critical user journeys (CUJs) into the CUJ markdown files in the app's repo (cujs/) - steps as you would ask a person and the expected result, from the app's code, PRDs and the real app on the phone. Use when asked to write, generate or plan test cases or a test plan for an app or one of its journeys.
---

# Writing test cases for a CUJ

Tests live in the CUJ's file in the app's repo, under its `## Tests` heading (the create-cujs skill
writes those files). test-on-device runs them on the phone: CodeDroid follows the steps, then
checks each expected line on the screen. Nothing is saved on the phone.

## 1. Know the journey

1. Find the CUJ files: `cujs/` in the repo, or where the user says. No file for the journey the
   user means? Write it first, as the create-cujs skill does.
2. Read the file, its tests and its Source files, so tests name screens and buttons as the app
   does and don't repeat one already there.
3. If the phone is connected and the app installed, walk the journey once: `open_app`, then
   `get_screen` and `tap` (the codedroid-phone skill covers driving). Back out of anything that
   sends, buys, posts or deletes.

## 2. Pick the tests

The happy path first, then the edges that matter for this journey: empty or long input, an empty
or long list, offline, signed out, back or rotation in the middle, a PRD rule (a limit, an error
message). One goal per test.

## 3. Write them

Append each under `## Tests`:

```markdown
### Follow a podcast from search

Steps:
1. Tap Search and type "Daily".
2. Open The Daily from the results.
3. Tap Follow.

Expected:
- The Follow button reads Following.
- The Daily is listed in the Following tab.
```

- Title: what it checks, a few words.
- Steps: what to do, as you would ask a person, from the CUJ's Starts state. Name the things to
  tap as the app shows them. No coordinates, no node numbers.
- Expected: what must be true after, one outcome per line, each something visible on the screen or
  in the app. Not how it got there. It must hold on any phone: no exact coordinates, distances,
  times or other values that change with the screen or the clock; say what must be there instead
  ("Tap: shows a coordinate pair").

A test that would send, buy, post or delete something for real: keep it reversible (a draft, a
cart left unpaid) and say so in its steps, or ask the user before writing it.

## 4. Report

List the tests added, by CUJ file. Offer to run them with test-on-device.

## Never

- Force-stop, clear or uninstall com.codedroid.app: it switches CodeDroid off.
- Write passwords, card numbers or other secrets into a test; say which test account to use instead.
