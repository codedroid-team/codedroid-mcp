# Evaluating the app-e2e skills

The harness scores the `e2e/TESTCASES.md` that the app-e2e skills write for the ownCloud Android
app against ownCloud's own human-written test suite (the key). The score is the share of on-phone
key rows that one of our runnable cases covers. Pins and areas are in `config.json`. Code reads only
`qaRepo`, `qaSha` and `keyFiles`; `appRepo`, `appTag` and `areas` are for people, and the areas in
`AUTHOR.md` must match `areas`.

Requirements: Node >= 20, git, Docker for the server, and the Android SDK and a JDK 17+ for the APK.

## Layout

- `eval/.cache/` is gitignored: the key, the app checkout and the runs. Runs live in `eval/.cache/runs/<name>/`.
- `node eval/key.mjs fetch` writes the key to `eval/.cache/key.json`.
- Scores committed to `eval/scores/` are summaries with no key text.

## The key

The key is `owncloud/QA` (AGPL-3.0). It is fetched at run time into `eval/.cache/QA` at the pinned
commit and never committed. The 16 files in `keyFiles` are every plan under Sync, Transfers and
Settings of its Android feature templates. Each row of a table with an Expected column is one key
row. Tables with no Expected column (the two retry tables in Upload) are not test-case tables and
are skipped. `eval/scores/` holds no key text. Do not open other files under `eval/.cache/QA/` in an
agent session.

After changing `qaSha` or `keyFiles`, run `node eval/key.mjs fetch` again: it fetches the new
commit into the existing cache. The scorer refuses a key fetched for another commit, other files or
another version of `key.mjs`.

## Procedure

1. Fetch the key: `node eval/key.mjs fetch`.
2. Server and app: bring up the ownCloud server and build the debug APK with the files in `eval/owncloud/` (`docker-compose.yml`, `.env.example`, `seed.sh`). Copy `.env.example` to `.env`. Set `ADMIN_PASSWORD` and `E2E_PASSWORD`, generating each with `openssl rand -hex 12`; compose refuses to start while either is empty. Set `OWNCLOUD_DOMAIN` to the laptop LAN IP and port, as the phone types it (for example 192.0.2.1:8080), and put the laptop LAN IP in `OWNCLOUD_TRUSTED_DOMAINS` (keep `localhost` in the trusted list too, because `seed.sh` uploads through `localhost:8080`). Run `docker compose -f eval/owncloud/docker-compose.yml up -d` and wait until `http://localhost:8080/status.php` reports `"installed":true`. Then run `eval/owncloud/seed.sh`, which creates user `e2e` and three `e2e-` sample files. The compose project is named `codedroid-eval-owncloud`; a server started before the project had that name keeps its old container and volume, under the old name. Clone `appRepo` at `appTag` into `eval/.cache/owncloud-android` and run `./gradlew assembleOriginalDebug` (the app has three flavours; `original` is the Play-style one), with `JAVA_HOME` set to Android Studio's JBR. The APK (applicationId `com.owncloud.android.debug`) lands in `owncloudApp/build/outputs/apk/original/debug/`.
3. Phone: the test phone is shared. Read the installed CodeDroid versionCode first, ask before installing the APK, and have the user add the server (`http://<laptop LAN IP>:8080`) and sign in as `e2e`.
4. Author: copy the app checkout to a fresh temporary folder outside this repository. Copy the skills at the commit under test into that folder with `mkdir <author folder>/skills-under-test && git archive <sha> skills | tar -x -C <author folder>/skills-under-test` (the result is `<author folder>/skills-under-test/skills/...`), and record `<sha>` as the skills version for the score. Start a fresh agent in that folder with no CodeDroid plugin enabled: an installed plugin carries `eval/`, which names the answer key's source. Give it the phone tools by registering the MCP server alone for that session, with the command in this repository's `.mcp.json` (`npx -y @codedroid/mcp@<version>`); the npm package holds no `eval/`. Paste `eval/AUTHOR.md` as the author's first message; the author does not read it from this repository. `eval/.cache/` holds the answer key, so the author never works inside it. When it stops, move its `e2e/` folder to `eval/.cache/runs/<name>/e2e`. Check that cases exist: `grep -c "^### TC-" eval/.cache/runs/<name>/e2e/TESTCASES.md`.
5. Judge: start a different fresh agent with `eval/JUDGE.md`, `eval/.cache/key.json` and that `e2e/` folder. It writes `eval/.cache/runs/<name>/judge.jsonl`.
6. Score: `node eval/score.mjs eval/.cache/runs/<name>`. This writes `summary.json` and `SCORE.md` in the run folder. `Cases read` in `SCORE.md` shows how many cases were read as phone, task, manual and retired, so a misread run mode shows. A scoring error names what is wrong, and a refused score leaves no `summary.json` or `SCORE.md` behind. An error in the judge output means: rerun the judge, never edit verdicts by hand. An error in `TESTCASES.md`, such as a repeated case id, is the author's output: record it as the run's result and do not fix the file.
7. Check by hand: compare 20 judge rows with the key and the cases, spread as evenly across the three verdicts as the verdicts allow. Below 17 of 20 in agreement, fix `JUDGE.md`, rejudge and check again.
8. Record: run `node eval/score.mjs compare eval/.cache/runs/baseline-1 eval/.cache/runs/baseline-2 eval/.cache/runs/<name>`, then write the skills sha, scores, spread, verdict, tables and hand-check result to `eval/scores/<name>.md`, without key text.

## Baseline and changes

Make two baseline runs (`baseline-1`, `baseline-2`), each from a clean app copy and a fresh agent that has not seen the other run. Their difference is the run-to-run spread. After a skill change, run and score again, then compare: `node eval/score.mjs compare eval/.cache/runs/baseline-1 eval/.cache/runs/baseline-2 eval/.cache/runs/<name>`. It compares the new score with the mean of the two baselines; a change no larger than the spread is reported as no change.

## Limits

- The judge is a model, so a sample of its verdicts is checked by hand.
- The authoring model may have seen this app's public test plans in training.
- One app is one data point.
- Only test cases are scored. Work the skills record as a gap or a manual journey earns nothing.
- The judge assigns `kind` and `off_phone` afresh each run, so the number of on-phone rows (the denominator) can move between runs. That movement is part of the measured spread.
