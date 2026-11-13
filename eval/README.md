# Evaluating the app-e2e skills

The harness scores the `e2e/TESTCASES.md` that the app-e2e skills write for the ownCloud Android
app against ownCloud's own human-written test suite (the key). The score is the share of on-phone
key rows that one of our runnable cases covers. Pins and areas are in `config.json`.

## Layout

- `eval/.cache/` is gitignored: the key, the app checkout and the runs. Runs live in `eval/.cache/runs/<name>/`.
- The key's text is never committed. `node eval/key.mjs fetch` writes it to `eval/.cache/key.json`.
- Scores committed to `eval/scores/` are summaries with no key text.

## Procedure

1. Fetch the key: `node eval/key.mjs fetch`.
2. Server and app: bring up the ownCloud server and build the debug APK with the files in `eval/owncloud/` (`docker-compose.yml`, `.env.example`, `seed.sh`). Copy `.env.example` to `.env` and set a generated password. `seed.sh` creates user `e2e` and three sample files. Clone `appRepo` at `appTag` into `eval/.cache/owncloud-android` and run `./gradlew assembleDebug`.
3. Phone: the test phone is shared. Read the installed CodeDroid versionCode first, ask before installing the APK, and have the user add the server (`http://<laptop LAN IP>:8080`) and sign in as `e2e`.
4. Author: copy the app checkout to a fresh temporary folder outside this repository and start a fresh agent there with `eval/AUTHOR.md` and the skills at `origin/main`. `eval/.cache/` holds the answer key, so the author never works inside it. When it stops, move its `e2e/` folder to `eval/.cache/runs/<name>/e2e`. Check that cases exist: `grep -c "^### TC-" eval/.cache/runs/<name>/e2e/TESTCASES.md`.
5. Judge: start a different fresh agent with `eval/JUDGE.md`, `eval/.cache/key.json` and that `e2e/` folder. It writes `eval/.cache/runs/<name>/judge.jsonl`.
6. Score: `node eval/score.mjs eval/.cache/runs/<name>`. This writes `summary.json` and `SCORE.md` in the run folder. A scoring error means the judge output is malformed: rerun the judge, never edit verdicts by hand.
7. Check by hand: compare 20 judge rows, spread across verdicts, with the key and the cases. Below 17 of 20 in agreement, fix `JUDGE.md`, rejudge and check again.
8. Record: write the skills sha, scores, spread, tables and hand-check result to `eval/scores/<name>.md`, without key text.

## Baseline and changes

Make two baseline runs (`baseline-1`, `baseline-2`), each from a clean app copy and a fresh agent that has not seen the other run. Their difference is the run-to-run spread. After a skill change, run and score again; a change smaller than the spread is reported as no change.

## Limits

- The judge is a model, so a sample of its verdicts is checked by hand.
- The authoring model may have seen this app's public test plans in training.
- One app is one data point.
