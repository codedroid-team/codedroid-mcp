---
name: app-e2e-cujs
description: Write an Android app's critical user journeys (CUJs) for end-to-end testing with CodeDroid into e2e/CUJs.md - each the user's goal, its priority and run mode, and the outcomes visible on the phone that prove it - grouped by the PRD's features, each naming the PRD requirements it proves. Use as step 3 of app-e2e, or when asked to create, list or plan an app's CUJs or user journeys.
---

# Write the CUJs

Input: `e2e/PRD.md`, `e2e/EXPLORE.md`. Output: `e2e/CUJs.md`. Then stop for the user's review:
they approve or edit before any test case is written.

## One CUJ

```markdown
### CUJ-12 · Use a skill with blanks · P0 · phone
Proves: R8
User action: tap own skill → fill "Fill In" → "Use Skill".
- "Use Skill" is disabled until every blank is filled.
- The prompt lands in the composer, not sent.
```

- The title is the user's goal, not the screen.
- Priority and run mode from the PRD's scale: `phone` (drivable over CodeDroid), `task` (needs
  CodeDroid's agent to run something), `manual` (needs a wipe, a second account, a payment).
- `Proves:` the PRD requirements whose behavior its outcomes show, by id.
- Each bullet is an outcome someone can see on the phone, with its exact words in quotes, taken
  from `EXPLORE.md` or the source. Not "works correctly".

## The file

- Group by the PRD's features, in its order, under a heading per feature (`## F3 · Skills`).
  Number continuously. A feature that needs more than five CUJs is two features: say so.
- A common start state at the top (unlocked, app in front, signed in, nothing running).
- Manual CUJs stay in, marked `manual` with the reason (needs a wipe, a second account, a real
  payment). Include what a brand-new account meets first: first run, a welcome or first-task
  screen.
- Every PRD requirement is in some CUJ's `Proves:`. A requirement with none is a gap: add a CUJ or
  move it to non-goals. A feature in scope with no CUJ is a gap too. Write no coverage table: the
  quality page shows it.
- Robustness checks (rotation, dark theme, Back, crash buffer) as a short list folded into cases,
  not CUJs of their own.

## Handing to the user

Run `npx -y @codedroid/mcp e2e report e2e`; it must print no problems before you go on (fix each
`file:line: message` and rerun). Give the user `e2e/CUJs.html` to review and `e2e/QUALITY.html`
for what nothing covers yet, with the counts by feature, priority and run mode, the gaps, and the
open questions. Ask for approval. Do not write test cases in the same turn.

## Never

- Force-stop, clear or uninstall com.codedroid.agent.
- Write passwords, card numbers or other secrets into the file.
