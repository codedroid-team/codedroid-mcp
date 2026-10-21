# CodeDroid MCP

Connect Claude Code, Codex, Gemini CLI, and other MCP clients to your Android phone.

CodeDroid MCP provides tools for reading the screen, interacting with apps, taking screenshots,
and running tasks through the [CodeDroid Android app](https://get.codedroid.com). The phone and
computer can be on different networks. The optional `adb` tool requires a separate USB or
wireless debugging connection.

## Requirements

- Node.js 20 or later on your computer.
- CodeDroid installed on your phone, signed in, with its accessibility service enabled.
- An internet connection on both devices.

To use the optional `adb` tool, install [Android platform-tools](https://developer.android.com/tools/releases/platform-tools)
on your computer and connect the phone over USB or wireless debugging.

## Installation

Choose your coding client below. Each plugin or extension includes the MCP server and two
skills: `codedroid-phone` for interacting with the phone, and `test-on-device` for building,
installing, and testing Android apps.

### Claude Code

Run these commands in Claude Code:

```text
/plugin marketplace add codedroid-team/codedroid-mcp
/plugin install codedroid@codedroid
```

### Codex

Run these commands in your terminal with a current version of the Codex CLI:

```bash
codex plugin marketplace add codedroid-team/codedroid-mcp
codex plugin add codedroid@codedroid
```

### Gemini CLI

```bash
gemini extensions install https://github.com/codedroid-team/codedroid-mcp
```

Restart your coding client after installation, then pair your phone.

For a standalone MCP server or another client, see [MCP configuration](#mcp-configuration).

## Pair your phone

1. On the phone, open **CodeDroid → Settings → Computers → Pair a computer**.
2. Run the command shown on the phone in your computer's terminal. For example:

   ```bash
   npx -y @codedroid/mcp pair ABCD-EFGH
   ```

3. Tap **Allow** on the phone when prompted.

Pairing codes expire after 10 minutes and can only be used once. Development builds include
`--server=<url>` in the pairing command; use the command exactly as displayed.

To verify the connection, ask your coding agent:

> Read the screen on my phone and describe what is open.

Or check from your terminal:

```bash
npx -y @codedroid/mcp status
npx -y @codedroid/mcp call get_screen
```

## Usage

Ask your coding agent to work with the paired phone. For example:

- "Open Android Settings and check the Android version."
- "Open my app, navigate to the sign-in screen, and take a screenshot."
- "Install this APK, launch the app, and check logcat for crashes." (Requires `adb`.)

The agent can interact with the phone one step at a time or use `run_task` to delegate a goal
to CodeDroid's agent. `run_task` returns a task ID. Use `get_task` to wait for completion and
read progress, or `cancel_task` to stop the task.

### Tools

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
| `adb` | Run local adb commands against the connected phone. Off by default; enable with `--adb` or `CODEDROID_MCP_ADB=1`. |
| `codedroid_status` | Check the phone connection and get instructions for resolving connection problems. |

Screen interaction tools return an `after` observation with the current app, keyboard state,
screen changes, and visible elements. Phone tool errors include an error code, message, and
hint for recovery.

## Manage access

Paired computers appear in **Settings → Computers** on the phone.

- **Remove** revokes a computer's access. Pair again to reconnect it.
- **Stop** disconnects the active computer and blocks it for one minute.
- **Allow computers to connect** turns computer access on or off.

CodeDroid displays the computer's name and a Stop button while it acts on the phone.

## MCP configuration

Use these options when you want the MCP server without a plugin or extension. Configure one
installation method per client to avoid registering the tools twice.

### Standalone Claude Code server

```bash
claude mcp add codedroid -- npx -y @codedroid/mcp
npx -y @codedroid/mcp skill install
```

The optional second command installs the two skills in `~/.claude/skills`.

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

### Standalone Gemini CLI server

```bash
gemini mcp add --scope user --timeout 300000 codedroid npx -y @codedroid/mcp
```

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

Clients that support Streamable HTTP can also connect to `http://127.0.0.1:4826/mcp` while the
CodeDroid MCP daemon is running, sending the daemon's bearer token from `~/.codedroid/daemon-token`
as `Authorization: Bearer <token>`.

### Environment variables

| Variable | Description |
| --- | --- |
| `CODEDROID_SERIAL` | Select an adb device when several are connected. `ANDROID_SERIAL` is also supported. |
| `CODEDROID_MCP_PORT` | Set the local daemon port. Default: `4826`. |
| `CODEDROID_MCP_ADB=1` | Add the host-side `adb` tool (off by default; `--adb` does the same, `--no-adb` forces it off). |
| `CODEDROID_MCP_CLIENT` | Set the client name shown on the phone. |
| `ADB` | Set the path to the adb executable. |
| `CODEDROID_DEBUG=1` | Include stack traces in diagnostic output. |

## CLI reference

```bash
npx -y @codedroid/mcp pair ABCD-EFGH
npx -y @codedroid/mcp connect
npx -y @codedroid/mcp status
npx -y @codedroid/mcp call get_screen
npx -y @codedroid/mcp call tap '{"text": "Display"}'
npx -y @codedroid/mcp stop
```

`connect` reconnects a paired computer. `stop` shuts down the local daemon.

## Troubleshooting

Run `npx -y @codedroid/mcp status` or call `codedroid_status` from your agent to diagnose a
connection problem.

| Problem | Action |
| --- | --- |
| Computer is not paired, or pairing was removed | Create a new code in **Settings → Computers → Pair a computer** and run the displayed command. |
| Phone is not connected | Open CodeDroid, check its internet connection and sign-in, and enable **Allow computers to connect**. |
| Connection is awaiting approval | Tap **Allow** on the phone. |
| Connection was denied | Wait one minute, run `npx -y @codedroid/mcp connect`, then tap **Allow**. |
| Connection was stopped on the phone | Wait one minute before reconnecting. |
| adb cannot find the phone | Connect it over USB, or run `adb pair <ip:port>` followed by `adb connect <ip:port>` for wireless debugging. |

Force-stopping or running instrumentation against `com.codedroid.app` disables its accessibility
service. Re-enable it in Android Accessibility settings afterward. Clearing the app's data also
signs it out. UiAutomator tests and `uiautomator dump` temporarily suspend CodeDroid's
accessibility access while they run.

## Architecture

```text
MCP client → stdio bridge → local daemon → CodeDroid relay → Android app
                              └── local adb
```

All clients on a computer share a local daemon and its connection to the paired phone. The
phone and daemon each open an outbound WebSocket to the CodeDroid server. The phone reconnects
after a restart or network change. MCP screen interactions are serialized on the phone.

Calls interrupted by a connection loss are not automatically replayed: an action may have
completed before its response was lost. Read the screen before deciding whether to retry.

Pairing credentials are stored in `~/.codedroid/host.json`, readable only by your user account. The
daemon serves MCP on loopback only and requires a per-daemon bearer token, written to
`~/.codedroid/daemon-token` (0600) at startup and read by clients on this computer; a process that
cannot read your home directory cannot drive the phone or the `adb` tool. The host-side `adb` tool,
which runs commands on this computer, is off unless you enable it with `--adb` or
`CODEDROID_MCP_ADB=1`. Daemon logs are written to `~/.codedroid/daemon.log`.

## Development

From the package directory:

```bash
npm install
npm test
claude mcp add codedroid -- node "$PWD/src/index.js"
```

The npm tests run without a phone, relay server, or adb. In the monorepo, the Android app's MCP
JVM tests also verify the bridge against the app's server implementation and export the tool
fixture used by the skill tests. Install the package's npm dependencies before running those
contract tests from `CodeDroid-app/`:

```bash
./gradlew :app:testDebugUnitTest --tests 'com.codedroid.app.mcp.*'
```

These tests export `test/fixtures/phone-tools.json` and run `test/phone-contract.mjs` against
the app's MCP server through a test relay.

## Attribution

Parts of the bridge are derived from
[aura-mcp-connect](https://github.com/Dinesh210805/aura-android-use/tree/main/aura-mcp-connect)
(MIT, Copyright (c) 2026 Dinesh Kumar C). See [LICENSE.aura-mcp-connect](LICENSE.aura-mcp-connect).
