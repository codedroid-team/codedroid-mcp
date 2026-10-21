# CodeDroid MCP

Gives Claude Code, Codex, Gemini CLI or any MCP client your Android phone, through the CodeDroid app on it:
read the screen as numbered elements, tap and type, wait for things to appear, hand CodeDroid's
own agent a whole task, and run adb. The app reads the screen through Android's accessibility
service, so what the agent gets back is what is really on screen, not a guess from a screenshot
or a `uiautomator` dump.

It ships as a Claude Code plugin and Gemini CLI extension: this MCP server plus two skills, `codedroid-phone` (how to drive
the phone) and `test-on-device` (build, install, drive, check logcat, report).

## What you need

- Node.js 20 or newer on this computer.
- CodeDroid installed from https://get.codedroid.com, signed in, with its accessibility service on.
  The phone only needs to be online: no cable, no USB debugging, no shared network.
- For the `adb` tool only: adb (Android platform-tools) on this computer, and the phone on it
  (USB debugging, or Wireless debugging: `adb pair <ip:port>`, then `adb connect <ip:port>`).

## Install

Claude Code, as a plugin:

```
/plugin marketplace add codedroid-team/codedroid-mcp
/plugin install codedroid@codedroid
```

Or the MCP server alone:

```bash
claude mcp add codedroid -- npx -y @codedroid/mcp
npx @codedroid/mcp skill install            # the two skills, into ~/.claude/skills
```

Codex:

```bash
codex mcp add codedroid -- npx -y @codedroid/mcp
npx @codedroid/mcp skill install --codex    # into ~/.codex/skills
```

Codex stops a tool call after 60 s by default; `run_task` waits, test runs and installs can take
longer. In `~/.codex/config.toml`:

```toml
[mcp_servers.codedroid]
command = "npx"
args = ["-y", "@codedroid/mcp"]
tool_timeout_sec = 300
```

Gemini CLI, as an extension (includes the MCP server and both skills):

```bash
gemini extensions install https://github.com/codedroid-team/codedroid-mcp
```

Or the MCP server alone:

```bash
gemini mcp add --scope user --timeout 300000 codedroid npx -y @codedroid/mcp
```

Use the extension or the standalone MCP configuration, so the tools are registered once.
Restart your client after installation, then pair this computer as described below.

Any other client: `{"mcpServers": {"codedroid": {"command": "npx", "args": ["-y", "@codedroid/mcp"]}}}`,
or, with the daemon running, the streamable HTTP URL `http://127.0.0.1:4826/mcp`.

## Pair this computer

On the phone, open CodeDroid > Settings > Computers > **Pair a computer**. It shows a code and the
command to run here, valid for 10 minutes:

```bash
npx -y @codedroid/mcp pair ABCD-EFGH     # then tap Allow on the phone
```

Development builds add `--server=<url>`; run the command as the phone shows it. It saves this
computer's key in `~/.codedroid/host.json` (readable by you only) and connects once, so the phone
asks whether to allow the computer while you are still there. `npx @codedroid/mcp connect`
connects again by hand.

Settings > Computers lists the paired computers; Remove revokes one's key, so it has to pair
again. While an agent acts on the phone, CodeDroid shows "<computer> is using this phone" with a
Stop button, which cuts the computer off for a minute. "Allow computers to connect" turns it all off.

## Tools

| Tool | What it does |
|---|---|
| `get_screen` | The screen as numbered elements, with the app in front; optionally a screenshot |
| `take_screenshot` | A JPEG of the screen |
| `tap`, `long_press` | An element by node, text, resource id or content description (found again on the live screen), or a point |
| `type_text` | Into the focused field, optionally clearing it first and pressing Enter after |
| `swipe` | Between two points; also how to scroll |
| `press_key` | back, home, enter, recents |
| `open_app`, `list_apps` | Launch an app by package; find its package |
| `wait_for` | Until text shows, text goes, or an app is in front |
| `clipboard` | Read or set it |
| `device_info` | Model, Android version and user, screen, locked, whether CodeDroid is ready |
| `run_task`, `get_task`, `cancel_task` | CodeDroid's own agent does a goal on the phone and replies (needs CodeDroid signed in) |
| `adb` | This computer's adb, for the phone when it is on USB or Wireless debugging (`CODEDROID_MCP_ADB=0` leaves it out) |
| `codedroid_status` | Whether the phone is connected, and if not, exactly why |

Every action answers with `after`: whether the screen changed, the app in front, the keyboard,
and the first things to tap now. Every failure is JSON with `error`, `message` and `hint`.

## Command line

```bash
npx @codedroid/mcp pair ABCD-EFGH                # pair with the phone showing the code
npx @codedroid/mcp connect                       # connect now; tap Allow the first time
npx @codedroid/mcp status                        # what the daemon sees
npx @codedroid/mcp call get_screen               # one tool call, for scripts and CI
npx @codedroid/mcp call tap '{"text": "Display"}'
npx @codedroid/mcp stop                          # stop the daemon
```

| Environment | |
|---|---|
| `CODEDROID_SERIAL` | The device the `adb` tool uses when several are on adb (`ANDROID_SERIAL` works too) |
| `CODEDROID_MCP_PORT` | The daemon's port (default 4826) |
| `CODEDROID_MCP_ADB=0` | Leave out the `adb` tool |
| `CODEDROID_MCP_CLIENT` | How the phone names your agent ("Claude Code on borna-mbp") |
| `ADB` | The adb binary, if not on PATH |
| `CODEDROID_DEBUG=1` | Stack traces on failure |

## How it works

```
 MCP client ── stdio ── codedroid-mcp ── HTTP ── daemon (one per computer, 127.0.0.1:4826)
                                                   ├── adb tool: this computer's adb
                                                   └── wss://<CodeDroid server>/v1/mcp/connect
                                                         └── relay ── CodeDroid on the phone (its own WebSocket)
```

- Each client's `codedroid-mcp` starts the shared daemon if it is not running and proxies to it,
  so every client on the computer shares one connection to the phone, and tool calls run one at
  a time. The daemon logs to `~/.codedroid/daemon.log`.
- The phone keeps a WebSocket open to the CodeDroid server and opens it again by itself after a
  reboot or a network change. The daemon opens one too, with this computer's key from pairing,
  and the server relays between them. Nothing listens on the phone or on this computer's network.
- The server tells the phone which computer is connecting; the phone answers (Allow, the first
  time), then each WebSocket message is one JSON-RPC message.
- A call whose link drops mid-way is not retried: a tap whose answer was lost still happened.
  The agent is told so, and reads the screen before trying again.

## When it does not connect

Call `codedroid_status` (or `npx @codedroid/mcp status`): it says which of these it is.

- "Not paired", or "pairing was removed": pair again from Settings > Computers > Pair a computer.
- "The phone is not connected to CodeDroid": open CodeDroid on the phone, and check it is online,
  signed in, and "Allow computers to connect" is on in Settings > Computers.
- "Not allowed on the phone" or "Stopped on the phone": the phone said no; wait a minute.
- `am force-stop com.codedroid.app`, or `am instrument` against it, switches its accessibility
  off; turn it on again in Settings > Accessibility. (`pm clear` also signs it out.)
- `uiautomator dump`, and tests that use UiAutomator, suspend CodeDroid's accessibility while they
  run; its tools work again once they finish.

## Developing

```bash
npm install
npm test                                         # no phone, server or adb needed
claude mcp add codedroid -- node "$PWD/src/index.js"
```

The app's JVM tests (`./gradlew :app:testDebugUnitTest --tests 'com.codedroid.app.mcp.*'` in
`CodeDroid-app/`) write `test/fixtures/phone-tools.json`, the phone's tool list the skill test
checks the skills against, and run `test/phone-contract.mjs`: the bridge against the app's real
MCP server code, through a stand-in relay. Run `npm install` here first or that test is skipped.

`src/daemon.js`, `stdio-shim.js`, `proxy-core.js`, `adb-tool.js` and `skill.js` are derived from
[aura-mcp-connect](https://github.com/Dinesh210805/aura-android-use/tree/main/aura-mcp-connect)
(MIT, Copyright (c) 2026 Dinesh Kumar C; `LICENSE.aura-mcp-connect`).
