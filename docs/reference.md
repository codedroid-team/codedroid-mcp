# CodeDroid MCP reference

[Back to setup](../README.md)

## Tools

The agent can interact with the phone one step at a time or use `run_task` to delegate a goal
to CodeDroid's agent. `run_task` returns a task ID. Use `get_task` to wait for completion and
read progress, or `cancel_task` to stop the task.

| Tool | Description |
| --- | --- |
| `get_screen` | Read the current app and screen as numbered accessibility elements; optionally include a screenshot. |
| `take_screenshot` | Capture a JPEG screenshot. |
| `tap`, `long_press` | Interact with an element by node, text, resource ID, content description, or screen coordinates. |
| `type_text` | Enter text in the focused field; optionally clear it first or press Enter afterward. |
| `swipe` | Swipe or scroll between screen coordinates. |
| `press_key` | Press Back, Home, Enter, or Recents. |
| `open_app`, `list_apps` | Launch an app by package name or list installed apps. |
| `wait_for` | Wait for text to appear or disappear, or for an app to open. |
| `clipboard` | Read or update the clipboard. |
| `device_info` | Inspect the device model, Android version, user, screen, lock state, and CodeDroid readiness. |
| `run_task`, `get_task`, `cancel_task` | Start, monitor, or cancel a task run by CodeDroid's agent. |
| `install_apk` | Install an APK from this computer through CodeDroid's connection, with no cable or shared network. |
| `adb` | Run local adb commands against the phone attached to this computer. Turn off with `--no-adb` or `CODEDROID_MCP_ADB=0`. |
| `codedroid_devices` | List the paired phones (id, model, server) and whether each is connected, without connecting. |
| `codedroid_status` | Connect to the paired phones, report each connection, and get instructions for resolving problems. |
| `batch` | Run up to 20 screen tool calls in one round trip with the phone held; stops at the first failure. |
| `record_start`, `record_stop` | Record the session's phone actions as a Maestro flow and write the YAML. See [Flows](#flows-record-and-replay). |
| `run_flow` | Replay a Maestro flow (a file or inline YAML) on the phone with no model in the loop. |
| `codedroid_setup_phone` | Set up the phone on this computer's adb: install CodeDroid (only with `install` set, after the user agrees), turn on its accessibility service, and pair with no code to type. `serial` picks the phone when several are on adb. A long setup answers "still working": call it again. Offered with the `adb` tool. |

`get_screen` takes three options the local bridge applies on your computer: `interactive_only`
(only the elements a person could act on, with the labels inside them), `max_depth` (cut deep
nesting) and `diff` (only what changed since the session's last read, one line when nothing did). Node numbers stay the phone's,
so a tap by node after a filtered read still lands. `batch`, the recording tools and `run_flow`
are the local bridge's; the remote server has the phone tools alone.

The local bridge marks the tools of the look-act-check loop (`get_screen`, `tap`, `type_text`,
`swipe`, `press_key`, `open_app`, `wait_for`, `batch`, `codedroid_status`, `codedroid_devices`) with
`_meta: {"anthropic/alwaysLoad": true}`, so Claude Code keeps them loaded when it defers MCP tools
and finds the rest by search.

Screen interaction tools return an `after` observation with the current app, keyboard state,
screen changes, and visible elements. Phone tool errors include an error code, message, and
hint for recovery.

## Flows: record and replay

A flow is a file in [Maestro's](https://docs.maestro.dev) YAML format holding the steps of a
sequence on the phone. The agent records one while it drives (`record_start`, drive,
`record_stop` with `save_to`), and anyone replays it with no model in the loop:

```bash
npx -y @codedroid/mcp flow run e2e/flows/TC-12a.yaml
npx -y @codedroid/mcp flow run login.yaml --env=USER=ada,PASSWORD=secret --screenshots=e2e/reports/shots
```

Run it from the project: the file, nested `runFlow` files and `--screenshots` must be in the
project directory or the temp directory. It prints each step's result and exits 1 when a step
fails, with the screen's first lines at that point. A run longer than 50 s keeps waiting in the
background; the command polls until it ends.

Call `record_start` before `open_app`, so the flow starts by launching the app; a flow with no
`launchApp` starts wherever the phone is. Recording turns each successful `open_app`, `tap`, `long_press`, `type_text`, `swipe`,
`press_key`, `wait_for`, `take_screenshot` and `run_task` into a step; reads are not steps, and a
step that failed is not recorded. A tap by node is written as a tap by the text, resource id or
content description that node showed, and by its point only when it had none. What Maestro cannot
express (a wait for an app, the clipboard) stays in the file as a comment.

Replay supports `launchApp`, `tapOn`, `longPressOn` (by text, `id`, or `point: "x,y"` in pixels),
`inputText`, `eraseText`, `pressKey` (Enter, Home, Back, Recents), `back`, `swipe` (points or a
direction), `scroll`, `scrollUntilVisible`, `assertVisible`, `assertNotVisible` (both wait up to 7 s
like Maestro), `extendedWaitUntil`, `waitForAnimationToEnd`, `takeScreenshot`, `runFlow` (a file),
`repeat` (with `times`), `optional: true`, `${VAR}` from the flow's `env:` and `--env`, and
`codedroidTask`, a CodeDroid extension that hands CodeDroid's agent a goal. Any other command
fails the run at that step, so a pass means every step ran: a flow that skipped a command it did not
know would say "passed" about what it never checked. A flow with no `codedroidTask` runs in Maestro
on an emulator too (`maestro test <file>`).

The phone is held for the whole run or batch: another client's call waits, it does not interleave.

## Live view: the viewer

```bash
npx -y @codedroid/mcp viewer
npx -y @codedroid/mcp viewer "Pixel 9" --interval=5
```

It prints a localhost URL. The page shows the phone's screen every few seconds while the tab is
visible (pause it any time), and lets you take over: click the picture to tap there, press Back,
Home or Recents, type into the focused field, or cancel a task by id. It is a client of the
daemon like the agent, so its screenshots queue with the agent's calls and never interleave with
them. The URL holds a random path, the server listens on loopback only, and a page from another
origin cannot reach it.

## Sign in: the account

```bash
npx -y @codedroid/mcp login
npx -y @codedroid/mcp logout
```

`login` signs this computer in with the Google account you use in CodeDroid: it prints a link and a
code, opens the link in your browser (`--no-browser` to only print it), and waits while you check
the code and sign in. From then on every phone signed in to CodeDroid with that account is reached,
with nothing to pair, including phones signed in later: the daemon reads the account's phones when
it starts and every five minutes, and `codedroid_devices` and `codedroid_status` read them again
when called. `setup` runs `login` first unless `--no-login` is passed or there is no terminal to
sign in from.

The server keeps one login per computer, named after it, and the phone shows it in **Settings →
Computers** like a paired computer: tap **Allow** once when the computer first connects, and
**Remove** to end the login. `logout` ends it from the computer. Pairings made with a code stay
either way. A login unused for 30 days lapses; run `login` again.

The account is kept in `~/.codedroid/host.json` beside the pairings, readable only by your user. In
CI, set `CODEDROID_TOKEN` instead (see [CI](#ci-replay-flows-from-github-actions)).

## Manage access

Computers appear in **Settings → Computers** on the phone: those paired with a code and those
signed in with the account.

- **Remove** revokes a computer's access. Pair again to reconnect it.
- **Stop** disconnects the active computer and blocks it for one minute.
- **Allow computers to connect** turns computer access on or off.

CodeDroid displays the computer's name and a Stop button while it acts on the phone.

## Installing builds

`install_apk` sends an APK through the same connection as the other phone tools, and installs it
with Android's package installer. It resumes if the connection drops.

- The first time, turn on **Allow from this source** for CodeDroid under **Install unknown apps**.
  The phone opens that page when it is needed.
- The phone has to be unlocked. CodeDroid confirms Android's install prompt.
- When Google Play Protect offers to scan a build it has not seen, CodeDroid chooses **Install
  without scanning**, so the build is not sent to Google. Any other Play Protect message, such as a
  harmful app warning, is left for you. Answer it, then call `install_apk` again.
- It takes one `.apk`, not an App Bundle or split APKs. Make one from a bundle with
  `bundletool build-apks --mode=universal`.
- It needs a version of the CodeDroid app that has this tool.

## adb setup

The `adb` tool requires [Android platform-tools](https://developer.android.com/tools/releases/platform-tools)
on your computer and a USB or wireless debugging connection to your phone.

For USB, enable **USB debugging** in the phone's Developer options, connect the cable, and
accept the debugging prompt on the phone. Run `adb devices` to check the connection.
For wireless debugging, see [troubleshooting](#troubleshooting).

Because it runs commands on your computer:

- It is marked destructive, so clients that honor that ask before running it.
- Relative paths start from the client's working directory. A client started in your home directory
  or above it has no project directory, and must use absolute paths.
- `push`, `pull`, `bugreport`, `backup`, `restore`, and `save_to` only use local files in the project
  or temp directory. `install` takes any path.
- `-H`, `-P`, `-L`, `-a`, `keygen`, `ppp`, `server`, `nodaemon`, `fork-server`, `start-server`,
  `kill-server`, `attach`, `detach`, and `sync` are refused.

What it adds to plain adb:

- `device` runs the command on a paired phone, found by its model in `adb devices -l`. With two of
  one model, pass `-s <serial>`.
- `save_to` writes a command's raw output to a file in the project or temp directory, such as
  `exec-out screencap -p` or a full `logcat -d`, up to 100 MB. Without it, binary output is refused
  rather than returned damaged.
- `logcat` output over the 20,000-character limit keeps its newest lines. Other output keeps its start.
- `shell am instrument -r` returns a summary: counts, and each failure's stack. A crash, a timeout,
  or a run with no tests is an error, even though `am` exits 0.

To turn it off for a client, add `CODEDROID_MCP_ADB=0` to the CodeDroid MCP server's environment in
the client's MCP settings (or `--no-adb` to its arguments). To turn it off for every client, run
`npx -y @codedroid/mcp stop`, then start the daemon yourself with `npx -y @codedroid/mcp daemon --no-adb`.

## MCP configuration

Use these options when you want the MCP server without a plugin or extension. Configure one
installation method per client to avoid registering the tools twice.

### Remote server (Claude.ai, Claude Desktop, Cowork, Claude Code)

CodeDroid's server is also an MCP server, at `https://orchestrator.codedroid.com/mcp`
(Streamable HTTP, OAuth). It is what Claude's directory lists, as the **CodeDroid** plugin
(`claude-plugin/` in this repository: the skills and that URL) and as a connector. Any client
that speaks Streamable HTTP with OAuth can add it by URL; in Claude Code:

```bash
claude mcp add --transport http codedroid https://orchestrator.codedroid.com/mcp
```

Signing in with the Google account you use in the CodeDroid app replaces pairing: the server
reaches every phone on the account, and the phone asks you to **Allow** the client the first
time. The phone tools and `codedroid_devices` are there; `adb`, `install_apk`, `codedroid_status`
and `codedroid_setup_phone` run on your computer and are not. Revoke a client from
**CodeDroid > Settings > Computers** on the phone.

### Setup command

```bash
npx -y @codedroid/mcp setup
npx -y @codedroid/mcp setup --client=cursor,vscode --yes
npx -y @codedroid/mcp setup ABCD-EFGH
```

`setup` adds CodeDroid to every supported client it finds, after one confirmation:

| Client | `--client` | What `setup` does |
| --- | --- | --- |
| Claude Code | `claude-code` | Installs the plugin with `claude plugin install` |
| Codex | `codex` | Installs the plugin with `codex plugin add` |
| Antigravity | `antigravity` | Copies the plugin to `~/.gemini/config/plugins/codedroid`, and removes the `codedroid` server earlier releases added to `~/.gemini/config/mcp_config.json` |
| Cursor | `cursor` | Adds the server to `~/.cursor/mcp.json` |
| VS Code | `vscode` | Adds the server to the user `mcp.json` |
| Claude Desktop | `claude-desktop` | Adds the server to `claude_desktop_config.json` |
| Windsurf | `windsurf` | Adds the server to `~/.codeium/windsurf/mcp_config.json` |
| Zed | `zed` | Adds the server under `context_servers` in Zed's `settings.json` |

Config files get `npx -y @codedroid/mcp@<version>`, pinned like the plugins. Running a newer
`setup` updates that pin and keeps the entry's other settings, such as `env`. `setup` leaves a
client alone when it already has a `codedroid` server from somewhere else. It keeps a config's
comments and formatting, and never rewrites a config file it can't parse. `--client` sets up only the listed clients,
even ones it didn't detect. `--yes` skips the confirmation. With a pairing code, `setup` also pairs,
like `pair`.

Without a code, `setup` first signs this computer in ([the account](#sign-in-the-account)), unless
it already is, `--no-login` is passed, or there is no terminal. Then, with a phone on adb (USB or
Wireless debugging), it sets the phone up:

1. Installs CodeDroid from get.codedroid.com if it is missing, and checks the download against the
   published SHA-256. It asks first. Outside a terminal it installs only with `--yes`.
2. Turns on CodeDroid's accessibility service, keyboard and permissions over adb, as the USB
   install on get.codedroid.com does. Android's restricted settings don't apply to this.
3. Signs the phone in. Signed in on the computer, it asks the server for a one-time code and hands
   it to CodeDroid over adb, readable only by adb and the app itself, so the phone is signed in as
   your account with no Google sign-in on it: an emulator or a CI phone needs no account of its
   own. A phone signed in by this computer allows the account's computers without asking (a switch
   in **Settings → Computers**, off again at sign-out). Otherwise it waits up to five minutes for you
   to sign in on the phone.
4. Reaches the phone. On your account, there is nothing to pair: `setup` waits for the phone to
   register and connects. A phone signed in as another account, or an older CodeDroid, is paired
   instead: CodeDroid hands adb a pairing code, so you don't type one. Then it connects, and you
   tap **Allow** on the phone.

With several devices on adb, set `CODEDROID_SERIAL` to the one to set up. With no phone on adb, or
no adb, `setup` connects to the account's phones, or says how to pair by hand. If the phone removed
this computer, `setup` pairs it again. Signing in and pairing over USB need a CodeDroid version that
has them; older ones are told to update or pair.
`setup` exits with 1 when the phone isn't set up (signed out, declined outside a terminal, failed).

### Quality report for an app's e2e folder

```bash
npx -y @codedroid/mcp e2e report [dir] [--check]
```

Run it in an app's repo after writing the `app-e2e` documents. It reads `dir` (default `./e2e`:
`INVENTORY.md`, `PRD.md`, `CUJs.md`, `TESTCASES.md` and one report, below) and
writes `QUALITY.md`, `quality.json` and the HTML pages (`PRD.html`, `CUJs.html`, `TESTCASES.html`,
`QUALITY.html`, and a `REPORT.html` beside the report in use) into that folder, overwriting earlier
copies on every run and deleting nothing. Commit them with the Markdown. It writes each file under a
temp name beside it, then renames it into place, and never changes a file outside the folder. It
prints the counts, then, when there is a report, its results (`Last report reports/<date>/REPORT.md:
52 passed, 6 failed, 3 not run; 38 of 45 requirements passing.`), each problem it found in the
documents as `file:line: message`, and the path of `QUALITY.html`. It needs Node 20 or later, and no phone, daemon or network.
`REPORT.html` embeds each screenshot beside the report, so it is about one and a third times the
size of those screenshots together.

The report in use is the newest folder named exactly `YYYY-MM-DD` (zero-padded, compared as dates)
under `reports/`: the full run. The partial runs the skills write beside it (`<date>-bug-<case>`,
`<date>-maintain`, `<date>-smoke`) are not used, so "exercised" and "passing" come from the full
run. A control is exercised when a runnable case covering it has a `pass` or `fail` row in that
report, and passing when at least one such case passed and none failed; a `not run` row neither
helps nor hurts. In a feature's or journey's row only its own cases (those on the feature's
requirements; the journey's numbered cases) can fail a control, so a failure in another journey does
not mark a journey whose cases all passed. A requirement passes when a runnable case on it or on one
of its failure lines passed and none failed. Only when no folder has that exact name does the last folder by name stand in. A
folder shaped like a date but not zero-padded (`2026-11-9`) or not a calendar date (`2026-13-45`)
is a problem and is not used, and so is a newer dated folder with no `REPORT.md`. Only the first table whose columns
start with `Case` and `Result` is read; a second one is a problem. `QUALITY.md` and
`QUALITY.html` say which report their numbers come from.

It never reads through a link: a source file, a `reports` folder, a report folder or a report that
is a symbolic link, or leads outside the folder, is a problem and is not read, and so is a source
that is not a regular file. `quality.json` lists
its sources as the name under the folder and a sha256, with no path, so the same folder gives the
same file wherever it is run from.

The four documents are written in that order. One that is missing while no later one exists is not
written yet, not a problem: the command names it (`Not written yet: PRD.md, CUJs.md, TESTCASES.md.
Next: PRD.md.`) and its page says so. One missing before a document that exists is a problem.

With `--check` it writes nothing and prints `stale: <file>` for every page that is missing, is a
link or not a regular file, or was built from older documents (and for a missing `QUALITY.md` or
`quality.json`).

It also reads two lines the skills teach. In `PRD.md`, `- Non-goal: C40, C41 · reason` sets
capabilities aside: they leave "not in any feature", the percentages count the capabilities in
scope, and the quality pages list them with the reason. A requirement with no control in the
inventory writes `Caps: none`; `Fails:` is either failure items (`- R<n>.f<m> · text`, each starting with its own
requirement's id) below it or `none in source`; any other list item under `Fails:` is a problem. A
`Gap:` or `Non-goal:` line starts at the beginning of the line, with `-` or `*`. In `INVENTORY.md` a
`Source` written `path:line` or `path:from-to` is checked against the repo holding the folder (its
parent) when the path's first folder is there: a file that is not there, or a line past its end, is a
problem. A heading of any
level ends a block, and a feature, journey, case or screen heading at the wrong level is a problem.

In `TESTCASES.md`, `- Gap: <ref> · reason` acknowledges something no case covers. `<ref>` is a
requirement (`R4`), a failure line (`R1.f2`), a feature with no deep case (`F1 deep`) or a
requirement with a case but none deep enough for its Proof (`R3 depth`). A `Covers:` entry with no
brackets counts every control in that requirement's `Caps:`, also when the entry is a failure id
(`R1.f2`); write the controls in brackets (`R1.f2 (C4)`) to count fewer. A gap is never counted as
covered; the quality pages list it under "Acknowledged gaps". A case with `Type: setup` needs only
its `Run mode:` line and is counted apart. Every case has a `Feature:` line (`Feature: all` for a
setup case), and every case but a setup case an `Expected:` line. A numbered case (`TC-12a`) is for
the journey of that number, which must be in `CUJs.md`, and its `Feature:` is that journey's feature;
a bug case `TC-B<n>` is for none. A manual case or journey has a `Why manual:` line with a reason. A
line right under `Covers:` that is indented or starts with `R<n>` is a wrapped `Covers:` line: a
problem, since only the first line is read. Tier counts on the quality pages count runnable cases
only; a journey's row says how many of its cases are manual. A line `Retired: <date> - <why>` in a case or journey retires it: it keeps its id, may
point at what no longer exists, and counts for nothing (it appears on its page under "Retired", and
quality gains `cases.retired` and `cujs.retired`). Only a runnable case (phone or task) counts as covering
something or as a deep case.

"Left open" is what has no runnable case that settles it and no Gap line: P0 features with no deep case, requirements
with no runnable case, requirements too shallow for their Proof, and failure lines under a P0 or P1
feature. When there are any, the command prints `N left open: see
<dir>/QUALITY.md`; the full "Left open" and "Acknowledged gaps" lists are in that Markdown file
(and in `QUALITY.html`), and so is the full problem list that the line `and M more: see
<dir>/QUALITY.md` points to. Open items are not problems and do not change the exit code.

After the headline the command prints `N of M cases not approved by the verifier (K not judged yet): see
<dir>/QUALITY.md` when any judged case is not approved (N counts every case that is not approved, K those the
verifier has not judged; the bracket is left out when K is 0), or `No case has been judged by the verifier yet.`
when no case has any verdict. These lines do not change the exit code. `QUALITY.md`'s Verifier
section ends with `Approved on the first attempt: A. After a repair: B. Not approved: C.`, where "first
attempt" is counted per cycle (an approval after a `reopen` on the first new attempt counts), followed by
`Unreadable rows superseded by a later verdict: N.` when there are any.

Exit codes: 0 when all is well, 1 when the documents have problems, 2 for a usage error (an
unknown flag too), a folder that does not exist or holds none of the four documents, a source it
cannot read, or a file it cannot write. With `--check`: 0 when every page is current, 1 when a page
is stale or missing, 2 as above. It refuses to write through a link, into a folder that leads
outside, or over anything that is not a regular file (a folder, a named pipe), with exit 2, and
writes nothing then. Outputs are written to temporary names first and then renamed one after
another, so a failure during the renames can leave some outputs new: the message names the file. With more than 20 problems it prints a count per kind and the first 20; the pages list all.

### Record the verifier's verdicts

```bash
npx -y @codedroid/mcp e2e verdicts --due [dir]
npx -y @codedroid/mcp e2e verdicts <file> [dir]
```

The `app-e2e-verify` skill has a fresh agent judge each case and runs these commands around it.

`--due` writes nothing. It prints one line per feature that has cases due for judging, the feature id
and then each due case as `<id>@<code>` in document order (`F2: TC-02a@184125525faa839e
TC-02b@8629b9ce8edaa8a4`), or `No case is due for judging.`, and exits 0. A case is due when it is
`unverified`, `stale`, `invalid` or `repair` and its current cycle has attempts left, or when its
latest row is a `reopen`; never when it is `approved`, a `question` or `unresolved`, and never a
setup or retired case. A case whose cycle used three attempts waits for the user whatever its status.
A `question` is answered by writing the user's answer into the PRD requirement it concerns, which
makes the case stale and `--due` lists it; if the question was the case's third attempt, the answer
is also the user's word to give it another go: record a `reopen` for it with the answer as the
reason, and then `--due` lists it.
The code is the first 16 hex characters of the sha256 of the judged text: the case's block, the PRD
blocks of the requirements it covers, and the INVENTORY row of each control it covers (the bracketed
controls, or the requirement's `Caps:` for a `Covers:` entry without brackets). Line ends and
trailing spaces do not count.

`<file>` is the verifier's output: UTF-8 JSON Lines (a byte order mark is skipped), one object per
judged case, each with exactly the string fields `id`, `verdict` (`approved`, `repair`, `question`
or `reopen`), `by`, `reason` and `text`, the code `--due` gave for that case. The code ties the
verdict to the text that was judged. For a verdict, `by` is `independent` (a fresh agent) or `same`
(the agent that wrote the cases). `reopen` is the user's: written only when the user says to give a
case more attempts, as `{"id": "TC-3a", "verdict": "reopen", "by": "user", "reason": "<what the user
said>"}`; it judges nothing, so it needs no `text` and one given is ignored. Blank lines are
skipped; the file may live anywhere and is only read. The command checks every line against one
read of `dir` (default `./e2e`) and, only if all are valid, appends one row per line to `VERIFY.md`,
creating it with its header if needed. It stamps the attempt (the next in the case's current cycle;
a `reopen` row is `0`), the case's code and today's local date. A reason's line breaks become one
space and `|` is written `\|`. Existing lines are never rewritten, and nothing is written through a
link, outside `dir`, or over a `VERIFY.md` that is not a regular file (a folder, a named pipe).

Recording holds a per-folder `.VERIFY.lock` directory from the initial read through readback or
rollback. Another writer exits 2 without recording anything; retry after the active writer finishes.
A crashed writer may leave the lock: remove it only after confirming no writer is running.

A row the reader cannot trust marks its case `invalid` and is a problem in `e2e report`: one it
cannot parse, one whose attempt does not follow its cycle, or one whose date is not a calendar date.
Such a row still takes one attempt of the case's cycle. A new verdict recorded for the case
supersedes the row: it is then no longer a problem, the case's verdict history shows it as `row at
VERIFY.md line N could not be read (superseded)`, and `QUALITY.md` counts it. A case id defined
twice in `TESTCASES.md` makes every case with that id `invalid`. A row that names no current judged
case stays a problem.

On success it prints one line per verdict (`TC-12a: repair (attempt 1 of 3)`, `TC-12a: reopened`)
and a reminder to run `e2e report`, and exits 0. Exit 2 means nothing was recorded; there are two
kinds of refusal. Faults in the verdicts, one `<file>:<line>: <message>` each: invalid JSON, a
missing, extra or non-string field, an id that is not a current judged case, a verdict outside the
list, `by` other than `user` on a `reopen` or other than `independent` or `same` on a verdict, an
empty reason or one that is not well-formed Unicode, a `text` that is not 16 hex characters, a
`text` that is not the case's current code (`TC-1a changed since it was judged (or the text code is
wrong): judge it again`: the case goes to a verifier again), a verdict that repeats the case's
latest row (`TC-1a: this verdict is already recorded`), an id twice, a fourth verdict in a cycle
(only `reopen`, on the user's word, allows more), or `reopen` for a case whose current cycle does
not yet hold three attempts (`reopen` is allowed once it does, even if the case text has changed
since). One line otherwise: `the documents have problems: run "e2e report" and fix them first` for
problems in `TESTCASES.md` or `PRD.md` (fix them, then record again; `--due` refuses the same way),
a usage error (an unknown flag too), a missing file or folder, a file or folder in it that cannot be read (`Cannot read reports/2026-01-01: EACCES`; `--due` too), a file with no verdicts, a `VERIFY.md` with no table or one that ends
inside an unclosed code fence, or a write failure. If the rows it appended do not read back, it
restores `VERIFY.md` to its previous bytes (or removes it if this run created it) and says `nothing
was recorded`. It needs no phone, daemon or network.

`VERIFY.md` is bookkeeping for honest agents, not an access-control boundary: anyone who edits it by hand can forge a
row, so review it like any other file in a pull request.

### Standalone Claude Code server

```bash
claude mcp add codedroid -- npx -y @codedroid/mcp
npx -y @codedroid/mcp skill install
```

The optional second command installs the skills in `~/.claude/skills`.

### Standalone Codex server

```bash
codex mcp add codedroid -- npx -y @codedroid/mcp
npx -y @codedroid/mcp skill install --codex
```

The optional second command installs the skills in `~/.codex/skills`. For calls longer than Codex's
60-second default timeout, such as APK installation, set `tool_timeout_sec` in
`~/.codex/config.toml`:

```toml
[mcp_servers.codedroid]
command = "npx"
args = ["-y", "@codedroid/mcp"]
tool_timeout_sec = 300
```

### Standalone Antigravity server

In the Antigravity app, open **Customizations** > **MCP Servers** and click **Copy Config File Path**.
Add the server under `mcpServers` in that file (usually `~/.gemini/config/mcp_config.json`), as in
[Other MCP clients](#other-mcp-clients), then install the skills:

```bash
npx -y @codedroid/mcp skill install --dir=$HOME/.gemini/config/skills
```

Use this or the plugin from `setup`, not both: both register the tools.

### Other MCP clients

Add this server configuration to your client's MCP settings:

```json
{
  "mcpServers": {
    "codedroid": {
      "command": "npx",
      "args": ["-y", "@codedroid/mcp"]
    }
  }
}
```

Clients that support Streamable HTTP can also connect to `http://127.0.0.1:4826/mcp`, sending the
token in `~/.codedroid/daemon-token` as `Authorization: Bearer <token>`. The daemon creates the
token the first time it starts and reuses it across restarts and ports, so a stored header keeps
working. To change it, stop **all** of this user's daemons before deleting the file. Invalid or
unreadable credentials cause an error and are never silently replaced. If `~/.codedroid` is read-only,
provision a valid token there first: a regular file owned by your user, containing a cryptographically
random 32-byte value as 64 lowercase hexadecimal characters, with permissions `0600`. The daemon does not search temporary directories for credentials.

After upgrading from an unauthenticated daemon, run `npx -y @codedroid/mcp stop` and reconnect.
For a custom port, pass the same `--port=<n>` to `stop`. New clients refuse legacy daemons until they
are restarted. If the token was deleted while a daemon was running, end the daemon process (its pid
is available at `/health`), then reconnect; discovery does not recreate credentials.

After pairing, run `npx -y @codedroid/mcp connect` to start the shared daemon before connecting
an HTTP client.

### Environment variables

| Variable | Description |
| --- | --- |
| `CODEDROID_SERIAL` | Select an adb device when several are connected. `ANDROID_SERIAL` is also supported. |
| `CODEDROID_MCP_PORT` | Set the local daemon port. Default: `4826`. |
| `CODEDROID_MCP_ADB=0` | Leave out the host-side `adb` tool for this client (`--no-adb` does the same); with the `daemon` command, for every client. |
| `CODEDROID_MCP_CLIENT` | Set the client name shown on the phone. Usage records also use it for a call that names no client. |
| `CODEDROID_TOKEN` | The account token `login --ci` printed: the daemon and CLI are signed in with it, and `~/.codedroid/host.json` is not read for an account or written. For CI. |
| `CODEDROID_SERVER` | The CodeDroid server `CODEDROID_TOKEN` is for. Default: `https://orchestrator.codedroid.com`. |
| `ADB` | Set the path to the adb executable. Otherwise it is looked for on `PATH`, in `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and the usual install locations. |
| `CODEDROID_DEBUG=1` | Include stack traces in diagnostic output. |

## CLI reference

```bash
npx -y @codedroid/mcp setup
npx -y @codedroid/mcp login
npx -y @codedroid/mcp logout
npx -y @codedroid/mcp pair ABCD-EFGH
npx -y @codedroid/mcp connect
npx -y @codedroid/mcp status
npx -y @codedroid/mcp doctor
npx -y @codedroid/mcp call get_screen
npx -y @codedroid/mcp call tap '{"text": "Display"}'
npx -y @codedroid/mcp flow run e2e/flows/TC-12a.yaml
npx -y @codedroid/mcp viewer
npx -y @codedroid/mcp unpair "Pixel 9"
npx -y @codedroid/mcp stop
```

`setup` adds CodeDroid to your coding clients and signs in ([details](#setup-command)). `login` and
`logout` are [the account](#sign-in-the-account). `connect` connects to the phones. `stop` shuts down the local daemon.
`doctor` checks Node, adb, this computer's pairing and token, the daemon, each phone's link and
which coding clients have CodeDroid, one line each with what to fix, and exits 1 when something
needs fixing. `flow run` replays a [flow](#flows-record-and-replay); `viewer` opens the
[live view](#live-view-the-viewer).

### Several phones

Every phone signed in to CodeDroid with your account is there once you `login`. For a phone that is
not, run `pair` on it. Pairing another phone keeps the earlier ones. Pairing the same phone again
replaces its old pairing. Reinstalling CodeDroid or clearing its data gives the phone a new id, so
its old pairing stays until you `unpair` it; a phone on the account is reached by its new id by
itself. The running daemon picks up `login`, `pair` and `unpair` on its next request, so clients
stay connected.

Every phone tool takes a `device` argument. It can be a phone's id, the start of its id, or its
model or part of the model ("Pixel" for "Google Pixel 5"), as long as it names only one paired
phone. The `codedroid_devices` tool lists the paired phones and the state of each link, without
connecting. With one phone paired, `device` is optional. With several, a
call without it fails and lists the paired phones. Each phone has its own link and its own queue,
so calls to different phones run side by side, and one phone going offline doesn't affect the
others. With several phones, resource URIs end in `?device=<id>`.

`status`, `connect` and the `codedroid_status` tool report every paired phone, or only the phone
you name (`npx -y @codedroid/mcp status "Pixel 9"`, or `{"device": "Pixel 9"}`). The CLI's `call`
takes `device` the same way: `npx -y @codedroid/mcp call get_screen '{"device": "Pixel 9"}'`.

## CI: replay flows from GitHub Actions

A [flow](#flows-record-and-replay) replays on your own phone from any runner, with no emulator and
no cable: the phone stays wherever it is, online, with CodeDroid open. Once, on your computer:

```bash
npx -y @codedroid/mcp login --ci
```

It prints a token and saves nothing. Keep it as the repository secret `CODEDROID_TOKEN`. It is a
login like any other: the phone shows it in **Settings → Computers**, and it stays valid while used
at least every 30 days. Then, in a workflow:

```yaml
- uses: codedroid-team/codedroid-mcp/action@main
  with:
    token: ${{ secrets.CODEDROID_TOKEN }}
    flow: e2e/flows/TC-01.yaml
    device: Pixel 9          # optional with one phone on the account
```

The action runs `npx -y @codedroid/mcp flow run` with `CODEDROID_TOKEN` set; its `version` input
pins the package (this release by default), `env` passes `KEY=VALUE,...` to the flow, and
`screenshots` names a directory for `takeScreenshot` to upload afterwards. The step fails when a
step of the flow fails, with the screen at that point in the log. Anything else runs the same way:
`CODEDROID_TOKEN=... npx -y @codedroid/mcp call get_screen`.

The phone must be signed in to CodeDroid with the account, online, and must have allowed the login
once (tap **Allow** the first time, or set the phone up with `setup` from a signed-in computer, which
allows the account's computers without asking).

## Troubleshooting

Run `npx -y @codedroid/mcp doctor` for every check at once, `npx -y @codedroid/mcp status` for the
phones, or call `codedroid_status` from your agent to diagnose a connection problem.

| Problem | Action |
| --- | --- |
| Computer is not signed in or paired, or the login or pairing was removed | Run `npx -y @codedroid/mcp login`, or plug the phone in with USB debugging on and run `npx -y @codedroid/mcp setup`, or create a new code in **Settings → Computers → Pair a computer** and run the displayed command. |
| Signed in, but no phone is listed | On the phone, open CodeDroid signed in with the same Google account, online. The daemon lists the account's phones again within five minutes; `codedroid_devices` and `status` list them at once. |
| `setup` waits for sign-in | On the phone, tap send in CodeDroid and sign in with Google. |
| `setup` says the phone blocked installing over USB | Turn on **Install via USB** in Developer options (some Xiaomi and Oppo phones), then run it again. |
| Phone is not connected | Open CodeDroid, check its internet connection and sign-in, and enable **Allow computers to connect**. |
| A phone is listed twice, and one never connects | CodeDroid was reinstalled, so that pairing is old. Run `npx -y @codedroid/mcp unpair <id>` with the id from `status`. |
| Connection is awaiting approval | Tap **Allow** on the phone. |
| Connection was denied | Wait one minute, run `npx -y @codedroid/mcp connect`, then tap **Allow**. |
| Connection was stopped on the phone | Wait one minute before reconnecting. |
| adb cannot find the phone | Connect it over USB, or run `adb pair <ip:port>` followed by `adb connect <ip:port>` for wireless debugging. |
| The agent has no `adb` tool | Check that `--no-adb` or `CODEDROID_MCP_ADB=0` is not set for the client or the daemon: see [adb setup](#adb-setup). |
| Daemon needs an authentication upgrade | Run `npx -y @codedroid/mcp stop` (with `--port=<n>` for a custom port), then reconnect. |
| `Unauthorized: send this user's daemon token` | Update the client (`npx -y @codedroid/mcp@latest`). An HTTP client must send the token in `~/.codedroid/daemon-token`. |

Force-stopping or running instrumentation against `com.codedroid.agent` disables its accessibility
service. Re-enable it in Android Accessibility settings afterward. Clearing the app's data also
signs it out. UiAutomator tests and `uiautomator dump` temporarily suspend CodeDroid's
accessibility access while they run.

## Architecture

```text
MCP client → stdio bridge → local daemon → CodeDroid relay → Android app
                              └── local adb
```

All clients on a computer share a local daemon and its connection to each paired phone. The
phone and daemon each open an outbound WebSocket to the CodeDroid server. The phone reconnects
after a restart or network change. MCP screen interactions are serialized on each phone. If the
daemon restarts, the stdio bridge opens a new session on its next request, so the MCP client
doesn't need to reconnect. A client newer than the running daemon replaces it, keeping `--no-adb`,
so an upgrade reaches every client on the computer. A call in flight at that moment gets an error.

Calls interrupted by a connection loss are not automatically replayed: an action may have
completed before its response was lost. Read the screen before deciding whether to retry.

The account's login and the pairing credentials, one per paired phone, are stored in
`~/.codedroid/host.json`, readable only by your user account. The account connects to each of its
phones with a short-lived access token renewed from the login as needed. The
daemon serves MCP on loopback only and requires your daemon token, kept in
`~/.codedroid/daemon-token` (0600): the daemon creates it the first time it starts, and clients on
this computer read it. A process that cannot read your home directory cannot drive the phone or the
`adb` tool. The host-side `adb` tool runs commands on this computer, within the limits in
[adb setup](#adb-setup). Daemon logs are written to `~/.codedroid/daemon.log`.

## Development

From the package directory:

```bash
npm install
npm test
claude mcp add -s local codedroid -- node "$PWD/src/index.js"
```

Run a client from this repository with that local server. `.mcp.json` here is the plugin's, and
`npx @codedroid/mcp` can't start inside this package: npm finds the package in the project itself
and looks for a `codedroid-mcp` bin that was never linked, so the server exits with
`command not found`. The plugin needs the file at the root, so it stays.

The npm tests run without a phone, relay server, or adb. In the monorepo, the Android app's MCP
JVM tests also verify the bridge against the app's server implementation and export the tool
fixture used by the skill tests. Install the package's npm dependencies before running those
contract tests from `CodeDroid-app/`:

```bash
./gradlew :app:testDebugUnitTest --tests 'com.codedroid.agent.mcp.*'
```

These tests export `test/fixtures/phone-tools.json` and run `test/phone-contract.mjs` against
the app's MCP server through a test relay.

### Release

`npm test` fails until every manifest names the same version.

1. Set the new version in `package.json` (`npm version <x.y.z> --no-git-tag-version`),
   `src/version.js`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
   `.antigravity-plugin/plugin.json`, `.mcp.json`, `mcp_config.json`, and both versions in `server.json`.
   Then `node scripts/sync-claude-plugin.mjs`, which sets it in `claude-plugin/` and copies the
   skills there (do this after any change to `skills/` too).
2. Run `npm test`, `claude plugin validate .claude-plugin/plugin.json` and
   `claude plugin validate claude-plugin --profile directory --strict`.
3. Run `npm publish --access public` **before** merging to `main`: the plugins launch
   `@codedroid/mcp@<version>`, so installs fail until that version is on npm.
4. Merge to `main`, then create the GitHub release. The Claude plugin directory follows `main`
   for `claude-plugin/` and checks each new commit itself:
   `gh release create v<x.y.z> --target main --title "CodeDroid MCP <x.y.z>" --latest`.
5. Run the **Publish to MCP Registry** workflow (`gh workflow run publish-mcp-registry.yml`) to
   update the [MCP Registry](https://registry.modelcontextprotocol.io). Publishing from a laptop
   with `mcp-publisher login github` works only for an Owner of the `codedroid-team` org.

