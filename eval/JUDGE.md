# Judge brief

You judge how well a set of test cases covers a reference suite. You have two inputs: `key.json`
(`{ qaSha, rows: [{ id, file, section, title, steps, expected }] }`) and the run's `e2e/` folder
(`TESTCASES.md` holds the cases, headed `### TC-<id> ...`). Do not edit either.

## Output

Write `judge.jsonl` next to the `e2e/` folder you were given, in that folder's parent (not inside `e2e/`, not in the current directory): one JSON object per line, one line per key row, every key
`id` exactly once, nothing else in the file (no header, no blank commentary, no code fences).

| Field | Value |
| --- | --- |
| `key_id` | the row's `id`, copied exactly |
| `verdict` | `covered`, `partly` or `missed` |
| `tc_ids` | array of case ids from `TESTCASES.md` that you matched; `[]` when `missed`; at least one when `covered` |
| `kind` | `happy`, `failure`, `recovery`, `limit` or `conflict` |
| `off_phone` | JSON boolean `true` or `false`, never a string; required on every line |
| `note` | one short sentence on why; do not quote the key, and name no key text beyond the row id |

Example (invented app):

```
{"key_id":"K-0","verdict":"covered","tc_ids":["TC-4"],"kind":"happy","off_phone":false,"note":"TC-4 creates a note and checks it appears in the list."}
```

## Verdicts

- `covered`: one of the cases performs equivalent steps and checks an equivalent expected result. Cite its id.
- `partly`: the steps match but the case's expected result is weaker or absent.
- `missed`: anything else.

## kind and off_phone

Set both from the key row alone, not from the cases.

- `happy`: the normal path works.
- `failure`: the app refuses, blocks or reports an error.
- `recovery`: the app resumes or returns to a good state after an interruption or error.
- `limit`: a boundary, such as size, count, length or an empty state.
- `conflict`: two changes to the same item disagree.
- `off_phone` is `true` when the row itself needs a second client, a second account, or server administration; otherwise `false`.
