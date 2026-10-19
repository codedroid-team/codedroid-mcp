# CodeDroid MCP

Gives Claude Code, Codex or any MCP client the Android phone attached to your computer, through
the CodeDroid app on it: read the screen as numbered elements, tap and type, wait for things to
appear, hand CodeDroid's own agent a whole task, and run adb. The app reads the screen through
Android's accessibility service, so what the agent gets back is what is really on screen, not a
guess from a screenshot or a `uiautomator` dump.

It ships as a Claude Code plugin: this MCP server plus two skills, `codedroid-phone` (how to drive
the phone) and `test-on-device` (build, install, drive, check logcat, report).

## What you need

- Node.js 18 or newer, and adb (Android platform-tools) on this computer.
- The phone on adb: USB debugging on and this computer allowed, or Wireless debugging
  (`adb pair <ip:port>`, then `adb connect <ip:port>`).
- CodeDroid installed from https://get.codedroid.com, with its accessibility service on.

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

Any other client: `{"mcpServers": {"codedroid": {"command": "npx", "args": ["-y", "@codedroid/mcp"]}}}`,
or, with the daemon running, the streamable HTTP URL `http://127.0.0.1:4826/mcp`.

## The first connection

The first time a computer connects, CodeDroid asks on the phone whether to allow it. Do that once
before starting your agent, so its MCP client is not left waiting:

```bash
npx @codedroid/mcp connect     # tap Allow on the phone
```

The phone remembers the computer (Settings > Computers lists and removes them). While an agent
acts on the phone, CodeDroid shows "<computer> is using this phone" with a Stop button; Stop cuts
the computer off for a minute. "Allow computers to connect" in the same place turns it all off.

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
| `adb` | This computer's adb against the same phone (`CODEDROID_MCP_ADB=0` leaves it out) |
| `codedroid_status` | Whether the phone is connected, and if not, exactly why |

Every action answers with `after`: whether the screen changed, the app in front, the keyboard,
and the first things to tap now. Every failure is JSON with `error`, `message` and `hint`.

## Command line

```bash
npx @codedroid/mcp status                        # what the daemon sees
npx @codedroid/mcp call get_screen               # one tool call, for scripts and CI
npx @codedroid/mcp call tap '{"text": "Display"}'
npx @codedroid/mcp stop                          # stop the daemon
```

| Environment | |
|---|---|
| `CODEDROID_SERIAL` | The phone to use when several devices are on adb (`ANDROID_SERIAL` works too) |
| `CODEDROID_MCP_PORT` | The daemon's port (default 4826) |
| `CODEDROID_MCP_ADB=0` | Leave out the `adb` tool |
| `CODEDROID_MCP_CLIENT` | How the phone names your agent ("Claude Code on borna-mbp") |
| `ADB` | The adb binary, if not on PATH |
| `CODEDROID_DEBUG=1` | Stack traces on failure |

## How it works

```
 MCP client ── stdio ── codedroid-mcp ── HTTP ── daemon (one per computer, 127.0.0.1:4826)
                                                   ├── adb tool: this computer's adb
                                                   └── adb forward tcp:N localabstract:codedroid-mcp-<user>
                                                         └── CodeDroid on the phone (MCP over the socket)
```

- Each client's `codedroid-mcp` starts the shared daemon if it is not running and proxies to it,
  so every client on the computer shares one connection to the phone, and tool calls run one at
  a time. The daemon logs to `~/.codedroid/daemon.log`.
- The daemon reaches the app through `adb forward` to an abstract socket in the app, named for
  the Android user in front (a Googlebook runs as user 10). Nothing listens on the network: only
  adb reaches the socket, and the app accepts only adb's shell user and refuses other apps.
- It sends a hello line with this computer's id (`~/.codedroid/host.json`) and name, waits for
  the phone's answer (Allow, the first time), then speaks newline-delimited JSON-RPC.
- A call whose link drops mid-way is not retried: a tap whose answer was lost still happened.
  The agent is told so, and reads the screen before trying again.

## When it does not connect

Call `codedroid_status` (or `npx @codedroid/mcp status`): it says which of these it is.

- No device, or `unauthorized`: plug in and tap Allow on "Allow USB debugging?", or reconnect
  Wireless debugging (it switches itself off when the Wi-Fi network changes).
- CodeDroid not installed, or its accessibility service off: it prints the commands that fix it.
- "Not allowed on the phone" or "Stopped on the phone": the phone said no; wait a minute.
- `am force-stop com.codedroid.app`, or `am instrument` against it, switches its accessibility
  off; turn it on again in Settings > Accessibility. (`pm clear` also signs it out.)
- `uiautomator dump`, and tests that use UiAutomator, suspend CodeDroid's accessibility while they
  run; its tools work again once they finish.

## Developing

```bash
npm install
npm test                                         # no phone or adb needed
claude mcp add codedroid -- node "$PWD/src/index.js"
```

The app's JVM tests (`./gradlew :app:testDebugUnitTest --tests 'com.codedroid.app.mcp.*'` in
`CodeDroid-app/`) write `test/fixtures/phone-tools.json`, the phone's tool list the skill test
checks the skills against, and run `test/phone-contract.mjs`: the bridge against the app's real
MCP server code over TCP. Run `npm install` here first or that test is skipped.

`src/daemon.js`, `stdio-shim.js`, `proxy-core.js`, `adb-tool.js` and `skill.js` are derived from
[aura-mcp-connect](https://github.com/Dinesh210805/aura-android-use/tree/main/aura-mcp-connect)
(MIT, Copyright (c) 2026 Dinesh Kumar C; `LICENSE.aura-mcp-connect`).
