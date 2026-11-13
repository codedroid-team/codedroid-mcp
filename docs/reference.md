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
| `codedroid_setup_phone` | Set up the phone on this computer's adb: install CodeDroid (only with `install` set, after the user agrees), turn on its accessibility service, and pair with no code to type. `serial` picks the phone when several are on adb. A long setup answers "still working": call it again. Offered with the `adb` tool. |

Screen interaction tools return an `after` observation with the current app, keyboard state,
screen changes, and visible elements. Phone tool errors include an error code, message, and
hint for recovery.

## Manage access

Paired computers appear in **Settings → Computers** on the phone.

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

Without a code, and with a phone on adb (USB or Wireless debugging), `setup` then sets the phone up:

1. Installs CodeDroid from get.codedroid.com if it is missing, and checks the download against the
   published SHA-256. It asks first. Outside a terminal it installs only with `--yes`.
2. Turns on CodeDroid's accessibility service, keyboard and permissions over adb, as the USB
   install on get.codedroid.com does. Android's restricted settings don't apply to this.
3. Waits up to five minutes for you to sign in on the phone.
4. Pairs: CodeDroid hands adb a pairing code, readable only by adb and the app itself, so you
   don't type one. Then it connects, and you tap **Allow** on the phone.

With several devices on adb, set `CODEDROID_SERIAL` to the one to set up. With no phone on adb, or
no adb, `setup` says how to pair by hand. If the phone removed this computer, `setup` pairs it
again. Pairing over USB needs a CodeDroid version that has it; older ones are told to update.
`setup` exits with 1 when the phone isn't set up (signed out, declined outside a terminal, failed).

### Quality report for an app's e2e folder

```bash
npx -y @codedroid/mcp e2e report [dir] [--check]
```

Run it in an app's repo after writing the `app-e2e` documents. It reads `dir` (default `./e2e`:
`INVENTORY.md`, `PRD.md`, `CUJs.md`, `TESTCASES.md` and the newest `reports/<date>/REPORT.md`) and
writes `QUALITY.md`, `quality.json` and the HTML pages (`PRD.html`, `CUJs.html`, `TESTCASES.html`,
`QUALITY.html`, and a `REPORT.html` beside the newest report) into that folder, overwriting earlier
copies and deleting nothing. It prints the counts, each problem it found in the documents as
`file:line: message`, and the path of `QUALITY.html`. It needs no phone, daemon or network.

The four documents are written in that order. One that is missing while no later one exists is not
written yet, not a problem: the command names it (`Not written yet: PRD.md, CUJs.md, TESTCASES.md.
Next: PRD.md.`) and its page says so. One missing before a document that exists is a problem.

With `--check` it writes nothing and prints `stale: <file>` for every page that is missing or was
built from older documents (and for a missing `QUALITY.md` or `quality.json`).

It also reads two lines the skills teach. In `PRD.md`, `- Non-goal: C40, C41 · reason` sets
capabilities aside: they leave "not in any feature", the percentages count the capabilities in
scope, and `QUALITY.html` lists them with the reason. In `TESTCASES.md`, `- Gap: <ref> · reason`
acknowledges something with no case; `<ref>` is a requirement (`R4`), a failure (`R1.f2`) or a feature
with no deep case (`F1 deep`). A gap is never counted as covered. A case with `Type: setup` needs
only its `Run mode:` line and is counted apart. Requirements and failure lines with no runnable case
and no Gap line, and P0 features with no deep case and no Gap line, are listed under "Left open";
when there are any, the command prints `N left open (no case and no Gap line): see <dir>/QUALITY.md` (the Markdown has the full lists; so
does the overflow line `and M more: see <dir>/QUALITY.md`). A requirement with no control in the
inventory writes `Caps: none`. Failure lines count as open only under a P0 or P1 feature.
They are not problems and do not change the exit code.

Exit codes: 0 when all is well (`--check`: every page is current), 1 when the documents have
problems (`--check`: a page is stale), 2 for a usage error, a folder that does not exist, or a file
it cannot write. It refuses to write through a link that leads outside the folder, and writes nothing
then. With more than 20 problems it prints a count per kind and the first 20; the pages list all.

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
| `ADB` | Set the path to the adb executable. Otherwise it is looked for on `PATH`, in `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and the usual install locations. |
| `CODEDROID_DEBUG=1` | Include stack traces in diagnostic output. |

## CLI reference

```bash
npx -y @codedroid/mcp setup
npx -y @codedroid/mcp pair ABCD-EFGH
npx -y @codedroid/mcp connect
npx -y @codedroid/mcp status
npx -y @codedroid/mcp call get_screen
npx -y @codedroid/mcp call tap '{"text": "Display"}'
npx -y @codedroid/mcp unpair "Pixel 9"
npx -y @codedroid/mcp stop
```

`setup` adds CodeDroid to your coding clients ([details](#setup-command)). `connect` reconnects a paired computer. `stop` shuts down the local daemon.

### Several phones

Run `pair` on each phone to add it. Pairing another phone keeps the earlier ones. Pairing the same
phone again replaces its old pairing. Reinstalling CodeDroid or clearing its data gives the phone a
new id, so its old pairing stays until you `unpair` it. The running daemon picks up `pair` and
`unpair` on its next request, so clients stay connected.

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

## Troubleshooting

Run `npx -y @codedroid/mcp status` or call `codedroid_status` from your agent to diagnose a
connection problem.

| Problem | Action |
| --- | --- |
| Computer is not paired, or pairing was removed | Plug the phone in with USB debugging on and run `npx -y @codedroid/mcp setup`, or create a new code in **Settings → Computers → Pair a computer** and run the displayed command. |
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

Pairing credentials, one per phone, are stored in `~/.codedroid/host.json`, readable only by your user account. The
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
2. Run `npm test` and `claude plugin validate .claude-plugin/plugin.json`.
3. Run `npm publish --access public` **before** merging to `main`: the plugins launch
   `@codedroid/mcp@<version>`, so installs fail until that version is on npm.
4. Merge to `main`, then create the GitHub release:
   `gh release create v<x.y.z> --target main --title "CodeDroid MCP <x.y.z>" --latest`.
5. Run the **Publish to MCP Registry** workflow (`gh workflow run publish-mcp-registry.yml`) to
   update the [MCP Registry](https://registry.modelcontextprotocol.io). Publishing from a laptop
   with `mcp-publisher login github` works only for an Owner of the `codedroid-team` org.

