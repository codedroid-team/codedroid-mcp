---
name: app-e2e-verify
description: Have a fresh agent judge each e2e test case's design before the user approves it - for every requirement a case covers, name the most plausible broken app that would still pass every Expected line - then repair the cases it sends back and record each verdict in e2e/VERIFY.md with the e2e verdicts command. Use after test cases are written or changed (step 4b of app-e2e, app-e2e-maintain, app-e2e-bug), or when asked whether the test cases would catch a broken app.
---

# Verify the test cases

A case can pass on a broken app, and its author reads past it. A fresh agent with only the
documents and the source hunts for that app; its verdicts go into `<dir>/VERIFY.md`, which only the
`e2e verdicts` command writes (never edit it). Run this before gate 2, and for every case
app-e2e-maintain or app-e2e-bug adds or edits.
Use `<dir>` for the selected document folder (`e2e` unless the user chose another), relative to the
app's repository root or absolute. Use that same folder in every command, brief and page path below.

## Who judges

One fresh agent per feature with cases due, given the brief below verbatim with `<dir>`, `<feature>`, `<ids>`
(that feature's line from `e2e verdicts --due`, after the colon) and `<file>` (a new file in a temp
folder, outside `<dir>`) filled in, and nothing else: not your notes, not why you wrote a case as you
did. Where the host cannot start another agent, judge in a separate pass: reread the documents and
the source from the top, follow the brief to the letter, and write `by` as `same`: the pages show who judged.

```text
=== VERIFIER BRIEF ===
You judge the design of an Android app's end-to-end test cases before anyone runs them, as if
someone else wrote them. Find the broken app that would still pass them. Judge exactly these cases,
<ids>, which belong to feature <feature>; do not judge any other case. Each comes as `TC-1a@<code>`:
the code ties your verdict to the text you judged.

Work in the app's repository root: the documents are in its `<dir>` folder, the source is the rest of
the repository. INVENTORY.md: each screen's controls (C<n>), each with its handler's source file and
line. PRD.md: features (F<n>) and requirements (R<n>), each with Caps (its controls), Fails (its
failure lines, R<n>.f<m>) and Proof, how deep its check must go: `screen` where the user acted,
`elsewhere` (another screen, a notification, a file, the server), `kept` (still true after leaving
and reopening the app). TESTCASES.md: the cases. A case's Covers line names the requirements and
failures it checks, with the controls it exercises in brackets; an entry with no brackets means
every control in that requirement's Caps. A control in the Caps that a bracketed entry does not name
is not the case's to exercise. Tier is smoke, core, deep or edge; Depth is the deepest place its
Expected lines check. EXPLORE.md: labels seen on the phone. Read the source at each covered
control's line, and what it calls. Do not read earlier verdicts: `VERIFY.md`, `QUALITY.md`,
`quality.json` or the `.html` pages. Do not edit any file under `<dir>`. Run nothing on the phone.

Judge a case against what it claims: the requirements and failures in its Covers, to the depth its
Depth line says. It need not reach a requirement's Proof alone: an honest Depth shallower than the
Proof is no reason for `repair` (the report lists that requirement as left open), nor is a broken
app only a deeper check would catch (lost on restart, against a case that claims `screen`). A case
that claims a depth it does not reach is `repair`.

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
5. The steps run as written: the start is reachable, every label is in INVENTORY.md or EXPLORE.md,
   the steps use each control its Covers entries name (all of a requirement's Caps where an entry
   has no brackets), the cleanup removes what the case made.
6. The tier is honest: a `deep` case is an extended scenario (several items, awkward data, a long
   sequence, state carried across reopening).

Run all six checks on a case before its verdict. Its reason leads with each defect and its fix, then
the evidence with file and line:
- `repair`: every check that fails, most serious first, each with its requirement, the broken app
  that passes or the step that fails, and the Expected line or step that would catch it.
- `approved`: nothing fails. Name, per covered requirement and failure, the broken behaviour you
  tried and the Expected line that rejects it. "Looks thorough" is not a reason.
- `question`: only the app's owner can say which behaviour is intended. The reason is the question.
No other word: `reopen` is the user's.

Write to <file> only this: one JSON object per line, one line per case, with exactly the five string
fields `id` (the case id), `verdict`, `by` (`independent`; `same` if you wrote the cases), `reason`
(one line) and `text` (the code after the `@` for that case, copied exactly). For example:
{"id": "TC-05a", "verdict": "approved", "by": "independent", "reason": "R5, which this case checks at kept: an app that lists the note but never stores it (app/src/main/java/notes/NoteRepository.kt:44 inserts it) is rejected by Expected \"e2e-note\" is listed after the app is reopened. R5.f1: an app that shows any error is rejected by Expected \"Couldn't save\", the string at app/src/main/java/notes/EditorFragment.kt:88, and by the title still in the editor.", "text": "3f9a1c0e7b2d4a68"}
{"id": "TC-12a", "verdict": "repair", "by": "independent", "reason": "R8.f1: e2e-timer has one blank, so the case cannot show that \"Use Skill\" waits for every blank; use a skill with two blanks, fill one, and check \"Use Skill\" is still disabled. An app that enables it once any blank is filled passes now (app/src/main/java/skills/FillInSheet.kt:96 checks every blank).", "text": "b04e6d2a91c7f358"}
=== END OF VERIFIER BRIEF ===
```

## The loop

1. `npx -y @codedroid/mcp e2e report "<dir>"` lists no problems in `TESTCASES.md` or `PRD.md`. Run
   `npx -y @codedroid/mcp e2e verdicts --due "<dir>"`: one line per feature, `F2: TC-2a@<code> ...`.
   Start one verifier per line, each its own `<file>`, with that line's cases as `<ids>`.
2. Record each file: `npx -y @codedroid/mcp e2e verdicts <file> "<dir>"`, then `e2e report "<dir>"`. A refused
   file (exit 2) records nothing. Faults come as `<file>:<line>: <message>`: have the verifier
   correct its output and record again; a "changed since it was judged" fault means the case goes
   to a verifier again, never that you edit the code. The one line "the documents have problems":
   fix them with `e2e report "<dir>"`, then record again.
   If the ledger is locked, retry after the other writer finishes; follow the command's recovery advice
   after a crash. Do not change the verifier output.
3. Each `repair`: change the case to answer every finding in its reason, without weakening another
   check. Add to `Covers:` a control the repaired steps now use; never remove one to escape a
   finding. If the answer is a new case or a Gap line, say so and write that. It shows as `stale`.
4. Run `npx -y @codedroid/mcp e2e verdicts --due "<dir>"` again and send each line to a new verifier,
   never the one that judged before (or, with no agents, a new pass from the top). A case that used
   its three attempts is not listed: it waits for the user. Every verdict, `question` included,
   uses an attempt; a `reopen` does not. Record its file.
5. Stop when the command prints `No case is due for judging.`

A `question` waits for the user. Write their answer into the PRD requirement it concerns (it is a
decision about the app): that makes the case stale, and `--due` lists it. If the question was the
case's third attempt, also record the `reopen` line below for it with the user's answer as the
reason; then `--due` lists it. A case you still believe is right after a `repair` stays as it
is: it is the user's call at gate 2. Never argue with the
verifier in the documents. Only when the user says to give a case more attempts, record this line:
`{"id": "TC-3a", "verdict": "reopen", "by": "user", "reason": "<what the user said>"}`

## Gate 2

Run `npx -y @codedroid/mcp e2e report "<dir>"` after the final repair, even if no case is due.
Fix any reported document problems and rerun before presenting the pages.
Give the user `<dir>/TESTCASES.html` and `<dir>/QUALITY.html`. From the Verifier section of
`<dir>/QUALITY.md`, say how many cases were approved on the first attempt, after a repair, and not at
all. For each unapproved case, take its last reason from the case's verifier history in
`<dir>/TESTCASES.html` (a case not judged yet has none: say so); ask each `question`; say whether an
independent agent or the same agent judged. An approved case has a sound design, not a passing run.

## Never

- Force-stop, clear, uninstall or `am instrument` com.codedroid.agent: it switches CodeDroid off.
- Edit `VERIFY.md`, or record `reopen` without the user's word.
