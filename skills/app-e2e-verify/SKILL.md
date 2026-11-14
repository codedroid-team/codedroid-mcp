---
name: app-e2e-verify
description: Have a fresh agent judge each e2e test case's design before the user approves it - for every requirement a case covers, name the most plausible broken app that would still pass every Expected line - then repair the cases it sends back and record each verdict in e2e/VERIFY.md with the e2e verdicts command. Use after test cases are written or changed (step 4b of app-e2e, app-e2e-maintain, app-e2e-bug), or when asked whether the test cases would catch a broken app.
---

# Verify the test cases

A case can pass on a broken app (it checks that a screen appeared, not that the action took
effect), and its author reads past that. A fresh agent with only the documents and the source hunts
for the broken app; its verdicts go into `e2e/VERIFY.md`, which only the `e2e verdicts` command
writes. Run this before gate 2, and for every case app-e2e-maintain or app-e2e-bug adds or edits.

## Who judges

One fresh agent per feature that has cases, given the brief below verbatim with `<feature>` and
`<file>` (a new file in a temp folder, outside `e2e/`) filled in, and nothing else: not your notes,
not why you wrote a case as you did. Setup and retired cases are never judged. Where the host cannot
start another agent, judge in a separate pass: reread the documents and the source from the top,
follow the brief to the letter, and write `by` as `same`: the pages show who judged.

```text
=== VERIFIER BRIEF ===
You judge the design of an Android app's end-to-end test cases for feature <feature>, before anyone
runs them, as if someone else wrote them. Find the broken app that would still pass them.

The documents are in the app repo's `e2e/` folder. INVENTORY.md: each screen's controls (C<n>),
each with its handler's source file and line. PRD.md: features (F<n>) and requirements (R<n>), each
with Caps (its controls), Fails (its failure lines, R<n>.f<m>) and Proof, how deep its check must
go: `screen` where the user acted, `elsewhere` (another screen, a notification, a file, the server),
`kept` (still true after leaving and reopening the app). TESTCASES.md: judge each case whose Feature
line is <feature> and that has no Retired line. Its Covers line names the requirements and failures
it checks, controls in brackets; Tier is smoke, core, deep or edge; Depth is the deepest place its
Expected lines check. EXPLORE.md: labels seen on the phone. Read the source at each covered
control's line, and what it calls. Do not read VERIFY.md or any earlier verdict. Do not edit any
file under `e2e/`. Run nothing on the phone.

For each case, in this order:
1. Counterexample hunt. For each requirement and failure in Covers, name the most plausible broken
   app that would still pass every Expected line: the action does nothing lasting, acts on the
   wrong item, shows the right text from the wrong state, succeeds on screen but fails to save,
   shows the wrong failure message. Where the source shows the app handles them (cite file and
   line), try: effect beyond the screen acted on; persistence across reopening; limits and counts;
   failure with its exact message; recovery and retry; cancel; interruption; more than one item;
   conflict between two changes.
2. The claimed depth is real: a `kept` case leaves and reopens the app before its check; an
   `elsewhere` case checks somewhere other than where it acted.
3. The oracle is independent: no Expected line asserts on text the case typed, on a toast that is
   gone by then, or on something every state shows.
4. A failure case asserts the exact message the source shows, and that the user's data survived.
5. The steps run as written: the start state is reachable, every label is in INVENTORY.md or
   EXPLORE.md, the steps touch every control in Covers, the cleanup removes what the case made.
6. The tier is honest: a `deep` case is an extended scenario (several items, awkward data, a long
   sequence, state carried across reopening).

One verdict per case, its reason naming the evidence with file and line:
- `repair`: a check fails. Name the requirement, the broken app that passes or the check that
  fails, and the Expected line or step that would catch it.
- `approved`: nothing fails. Name, per covered requirement and failure, the broken behaviour you
  tried and the Expected line that rejects it. "Looks thorough" is not a reason.
- `question`: only the app's owner can say which behaviour is intended. The reason is the question.
No other word: `reopen` is the user's.

Write to <file> only this: one JSON object per line, one line per case, with exactly the string
fields `id` (the case id), `verdict`, `by` (`independent`; `same` if you wrote the cases) and
`reason` (one line):
{"id": "TC-3a", "verdict": "repair", "by": "independent", "reason": "R4: ..."}
=== END OF VERIFIER BRIEF ===
```

```json
{"id": "TC-12a", "verdict": "repair", "by": "independent", "reason": "R8.f1: an app that enables \"Use Skill\" once any blank is filled passes, since e2e-timer has one blank (app/src/main/java/skills/FillInSheet.kt:96 checks every blank). Use a skill with two blanks, fill one, and check \"Use Skill\" is still disabled."}
```

## The loop

1. `npx -y @codedroid/mcp e2e report e2e` lists no problems in `TESTCASES.md` or `PRD.md` (until
   then `e2e verdicts` refuses every verdict). Start one verifier per feature, each its own `<file>`.
2. Record each file: `npx -y @codedroid/mcp e2e verdicts <file> e2e`, then `e2e report`. A refused
   file (exit 2, `<file>:<line>: <message>` per fault) records nothing: have its verifier correct
   the output, and record again. A case shown `invalid` has a damaged row in `VERIFY.md`: send it to
   a fresh verifier and record the new verdict, which supersedes that row.
3. Each `repair`: change the case to answer its reason, without weakening another check or changing
   its `Covers:` to dodge the finding. If the answer is a new case or a Gap line, say so and write
   that. The edited case shows as `stale`.
4. Send only the changed and new cases to a new verifier, never the one that judged them (or, with
   no agents, a new pass from the top); record its file.
5. Stop when every case is `approved`, a `question`, or `unresolved` (its three attempts used).

A case you still believe is right after a `repair` stays as it is: it is the user's call at gate 2.
Never argue with the verifier in the documents. Only when the user says to give a case more
attempts, record this line for it:
`{"id": "TC-3a", "verdict": "reopen", "by": "user", "reason": "<what the user said>"}`

## Gate 2

Give the user `e2e/TESTCASES.html` and `e2e/QUALITY.html`. From the Verifier section of
`e2e/QUALITY.md`, say how many cases were approved on the first attempt, after a repair, and not at
all, each unapproved one with its last reason; ask each `question`; say whether an independent agent
or the same agent judged. An approved case has a sound design, not a passing run.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Edit `VERIFY.md`, or record `reopen` without the user's word.
