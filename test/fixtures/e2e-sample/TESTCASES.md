# Notes test cases

### TC-1a · P0 · A saved note is still there after the app is reopened
Feature: F1 · Type: happy
Covers: R1 (C4)
Tier: deep · Depth: kept
Run mode: phone
Start: a fresh install.
Steps:
1. Tap "New note", type a title, tap "Save".
Expected: the title is in the list.
Cleanup: delete the note.

### TC-1b · P1 · Saving with no connection keeps the text
Feature: F1 · Type: negative
Covers: R1.f1 (C4), R1.f2
Tier: core · Depth: screen
Run mode: phone

### TC-1c · P1 · Opening a note shows its text
Feature: F1 · Type: happy
Covers: R2 (C1, C3)
Tier: core · Depth: screen
Run mode: task

### TC-2a · P1 · Deleting a note asks first
Feature: F1 · Type: happy
Covers: R3 (C5)
Tier: edge · Depth: elsewhere
Run mode: manual

### TC-3a · P1 · Search narrows the list
Feature: F2 · Type: happy
Covers: R4 (C2)
Tier: smoke · Depth: screen
Run mode: phone

### TC-3b · P2 · Search with no match says so
Feature: F2 · Type: negative
Covers: R4
Tier: edge · Depth: screen
Run mode: phone
