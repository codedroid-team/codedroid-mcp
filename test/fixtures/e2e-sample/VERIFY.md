# Verifier verdicts

Written by `e2e verdicts`. Do not edit by hand.

| Item | Attempt | Verdict | By | Text | Date | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| TC-1a | 1 | approved | independent | 6d245c1f6645e197 | 2026-11-14 | R1: an app that saves the note but drops it after a restart is rejected by the title check on the reopened list. |
| TC-1b | 1 | repair | independent | c59257db2048de17 | 2026-11-14 | R1.f1: an app that shows no error and discards the text passes: Expected is missing. |
| TC-1b | 2 | approved | same | c59257db2048de17 | 2026-11-15 | R1.f1, R1.f2: the new Expected checks the error and the kept text, so a silent discard fails. |
| TC-1c | 1 | repair | independent | a278d51cee207692 | 2026-11-14 | R2: an app that opens an empty note passes; Expected only checks the screen title. |
| TC-2a | 1 | question | independent | e75d076708de94f4 | 2026-11-14 | Is a confirmation dialog on delete required, or is undo enough? Only the user can say. |
| TC-3a | 1 | repair | independent | fa01e4a128b39967 | 2026-11-14 | R4: a search that ignores the query passes; Steps never type a query. |
| TC-3a | 2 | repair | same | fa01e4a128b39967 | 2026-11-15 | R4: the query is typed now but Expected still accepts the full list. |
| TC-3a | 3 | repair | independent | fa01e4a128b39967 | 2026-11-16 | R4: Expected names no title that must be absent, so an unfiltered list passes. |
