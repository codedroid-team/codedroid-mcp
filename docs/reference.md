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

## adb setup

The optional `adb` tool requires [Android platform-tools](https://developer.android.com/tools/releases/platform-tools)
on your computer and a USB or wireless debugging connection to your phone.

For USB, enable **USB debugging** in the phone's Developer options, connect the cable, and
accept the debugging prompt on the phone. Run `adb devices` to check the connection.
For wireless debugging, see [troubleshooting](#troubleshooting).

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

Clients that support Streamable HTTP can also connect to `http://127.0.0.1:4826/mcp`, sending the
daemon's bearer token from `~/.codedroid/daemon-token` as `Authorization: Bearer <token>`.
After pairing, run `npx -y @codedroid/mcp connect` to start the shared daemon before connecting
an HTTP client.

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

