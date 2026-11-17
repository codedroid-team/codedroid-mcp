# Notes PRD

## Goal
Keep short notes on the phone.

## Features

### F1 · Notes · P0
- R1 · A saved note appears in the list with its title.
  Caps: C4
  Proof: kept
  Fails:
  - R1.f1 · saving with no connection shows "Couldn't save" and keeps the text
  - R1.f2 · an empty title leaves "Save" disabled
- R2 · A tap on a note opens it with its text.
  Caps: C1, C3
  Proof: screen
  Fails:
  - R2.f1 · a note deleted elsewhere shows "Note not found"
- R3 · Deleting a note asks first and removes it from the list.
  Caps: C5
  Proof: elsewhere
  Fails: none in source

### F2 · Search · P1
- R4 · Typing in search narrows the list to matching titles.
  Caps: C2
  Proof: elsewhere
  Fails: none in source

## Non-goals
- Sync between phones.
