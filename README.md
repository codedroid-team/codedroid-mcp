# CodeDroid MCP

Let Claude Code, Codex, Antigravity, or any MCP client use your Android phone.
Read the screen, interact with apps, take screenshots, and test what you build
through [CodeDroid](https://get.codedroid.com). Your phone and computer can be on different networks.

## Get started

You'll need **Node.js 20+** and an Android phone. Both devices need internet access.

### Fastest: one command

```bash
npx -y @codedroid/mcp setup
```

It adds CodeDroid to every coding client it finds (Claude Code, Codex, Antigravity, Cursor, VS Code,
Claude Desktop, Windsurf, Zed) and signs this computer in with the Google account you use in
CodeDroid, in your browser: check that the page shows the code the terminal prints on its own
line. Every phone signed in to CodeDroid with that account is reached, with nothing to pair. `setup`
then connects to your phones, and each asks once whether to allow this computer: tap **Allow**. Then
restart your coding client.

With a phone plugged in (**USB debugging** on), `setup` also installs the CodeDroid app on it if
needed, turns on its accessibility service, and signs it in with your account, so an emulator or a
phone with no Google account on it needs no sign-in of its own. Setting up over USB needs
[adb](https://developer.android.com/tools/releases/platform-tools).

That is the last command you need: every client launches `@codedroid/mcp@latest`, so a new
release is with you the next time the client starts, and the running server brings the skills and
plugin copies on your computer along with it ([details](docs/reference.md#updates)).

Already have the plugin? Ask your agent to "set up my phone" instead: it does the same, and asks
you before installing anything.

### Or step by step

#### 1. Install for your coding client

**Every client at once**: run `npx -y @codedroid/mcp setup` in your terminal. Or for one client:

**Claude.ai, Claude Desktop, Cowork, or Claude Code without installing anything**: add
CodeDroid from Claude's directory (the **CodeDroid** plugin, or the connector), then sign in
with the Google account you use in the CodeDroid app. Nothing runs on your computer: Claude
reaches your phone through CodeDroid's server, so there is no pairing, but no `adb` or
`install_apk` either. In Claude Code you can also add it by URL:

```bash
claude mcp add --transport http codedroid https://orchestrator.codedroid.com/mcp
```

**Claude Code, with adb and installs from this computer**: run in your terminal:

```bash
claude plugin install codedroid --marketplace codedroid-team/codedroid-mcp
```

**Codex**: run in your terminal:

```bash
codex plugin marketplace add codedroid-team/codedroid-mcp
codex plugin add codedroid@codedroid
```

**Antigravity**: run in your terminal:

```bash
npx -y @codedroid/mcp setup --client=antigravity
```

It adds the CodeDroid plugin to `~/.gemini/config/plugins`. Restart Antigravity and find it under
**Customizations** > **Installed**.

**Cursor**: [Add to Cursor](https://cursor.com/en/install-mcp?name=codedroid&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjb2RlZHJvaWQvbWNwIl19)

**VS Code**: [Install in VS Code](https://vscode.dev/redirect/mcp/install?name=codedroid&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40codedroid%2Fmcp%22%5D%7D)

**Zed**: add this to `~/.config/zed/settings.json` (Windows: `%APPDATA%\Zed\settings.json`):

```json
{
  "context_servers": {
    "codedroid": {
      "command": "npx",
      "args": ["-y", "@codedroid/mcp"]
    }
  }
}
```

Each plugin includes the MCP server and skills for phone control and Android app testing.
Restart your coding client after installing.

Using another client? See [manual MCP setup](docs/reference.md#mcp-configuration).

#### 2. Sign in, or pair your phone

1. Install CodeDroid from [get.codedroid.com](https://get.codedroid.com), sign in, and turn on its
   accessibility service when it asks.
2. On your computer, run:

   ```bash
   npx -y @codedroid/mcp login
   ```

   and sign in with the same Google account in the browser that opens. Every phone on the account
   is reached. Check that the page shows the code the terminal printed.
3. Tap **Allow** on your phone when prompted.

Without a browser, or for one phone that is not on your account, pair instead: open **CodeDroid →
Settings → Computers → Pair a computer** on the phone and run the command shown there, for example
`npx -y @codedroid/mcp pair ABCD-EFGH`, exactly as shown. Pairing codes expire after 10 minutes and
work once.

### Ask your agent

> Read the screen on my phone and describe what is open.

Then try:

- “Open Android Settings and check the Android version.”
- “Open my app, navigate to sign-in, and take a screenshot.”
- “Install this APK, launch it, and check for crashes.”*

*`install_apk` works over CodeDroid's connection, with [one setting to allow](docs/reference.md#installing-builds). Reading logs with `adb` also requires
Android platform-tools and a USB or wireless debugging connection. See [adb setup](docs/reference.md#adb-setup).

## What it includes

- **MCP tools** to read the screen, take screenshots, tap, type, swipe, open apps, and hand
  CodeDroid's agent a multi-step task, on one phone or [several](docs/reference.md#several-phones).
  Phones can be shared like a device farm: an agent claims one for its job, and every other agent
  or computer sees it `in_use` until it is released ([details](docs/reference.md#shared-phones-claims-and-status)).
  See the [tool list](docs/reference.md#tools).
- **Skills**: `codedroid-phone` teaches the agent to drive the phone one checked step at a time,
  and `test-on-device` walks it through building, installing, and verifying an Android app change.
  `app-e2e` tests an app end to end: it explores the app, writes a test PRD, critical user
  journeys and test cases into its repo (`e2e/`), stops for your review of each, runs the cases on
  the phone and writes a report with a screenshot per case. Each step is its own skill
  (`app-e2e-explore`, `-prd`, `-cujs`, `-testcases`, `-run`), and `app-e2e-verify` has a fresh
  agent judge each test case's design, hunting for a broken app that would still pass it, before
  you review them. Then `app-e2e-rerun` runs some of the cases (by id, journey or priority, last
  failures, the ones a change touches, a flaky check), `app-e2e-bug` turns a bug into a case that reproduces it, and `app-e2e-maintain` keeps
  the cases current as the app changes. After writing the documents, the agent runs
  `npx -y @codedroid/mcp e2e report`, which writes a quality report and HTML pages into `e2e/`
  and lists any problems in them; it needs no phone ([details](docs/reference.md#quality-report-for-an-apps-e2e-folder)).
- **Flows**: the agent records what it does as a [Maestro](https://docs.maestro.dev) flow
  (`record_start`, `record_stop`), and `run_flow` or `npx -y @codedroid/mcp flow run <file>` replays
  it on the phone with no model in the loop, from a terminal or CI. A flow written for Maestro runs
  too. `batch` runs several known steps in one call. See [flows](docs/reference.md#flows-record-and-replay).
- **A live view**: `npx -y @codedroid/mcp viewer` shows the phone's screen in your browser while the
  agent drives it, and lets you tap, type and press Back or Home yourself.
- **`install_apk`** to install a build from your computer, with no cable or shared network.
- **An `adb` tool** that runs adb commands on your computer, to read logs and run tests. You can [turn it off](docs/reference.md#adb-setup).

The flows, the viewer and the last two run on your computer, so they come with the local install only. The directory's
plugin has the phone tools and the skills; the connector, and adding the server by URL, have the
phone tools alone. `claude-plugin/` in this repository is what the directory lists.

## Privacy and security

The plugin runs `npx -y @codedroid/mcp@latest`, which asks npm for the newest release, downloads
it when it has changed, and starts a local MCP server; the `app-e2e` skills run
`npx -y @codedroid/mcp e2e report` the same way. Once a day the server asks npm for the newest
version too, sending nothing but the package name (`CODEDROID_MCP_UPDATE_CHECK=0` turns that off).
Everything else it sends goes over TLS to the CodeDroid server, `orchestrator.codedroid.com`
unless the pairing command shown on your phone names another:

- **Pairing** sends the one-time code, your computer's name, and its OS (for example `darwin`),
  so the phone can show which computer is connected.
- **Setting up over USB** downloads the app from `get.codedroid.com`, checks it against the
  published SHA-256 before installing it, and changes only CodeDroid's own settings on the phone
  (its accessibility service, keyboard and permissions). It installs only after you agree.
- **Tool calls** are relayed between your agent and the phone: screen contents, screenshots, text
  you ask it to type, clipboard reads and writes, and task progress. Each call also names the MCP
  client that made it and its version. The phone asks you to **Allow** a computer the first time,
  shows when one is in use, and can stop or revoke it.

The local server listens on `127.0.0.1` only and requires a per-user token. Pairing credentials,
the token, and logs stay in `~/.codedroid` on your computer. The `adb` tool runs only on your
computer, and its `push` and `pull` stay within your project and temp directories. See
[Architecture](docs/reference.md#architecture) for details.

The plugin itself collects no analytics. The CodeDroid app and server keep usage records under
your CodeDroid account: pairing and connecting, whether a computer was allowed, and for each phone
tool call its name, whether it worked and its error code, how long it took, the MCP client,
session and versions involved, your computer's OS and a random id for it, and the task id of a
`run_task`. Usage records never include tool arguments, screen contents, or text you type.

When your agent calls `run_task`, the instruction travels through the CodeDroid relay to your phone,
which runs the task with CodeDroid's servers and our AI model provider (OpenAI). The relay passes
messages through without storing them. CodeDroid does not keep task content (instructions, task
history, screen contents, screenshots, text the agent types, clipboard contents, or model inputs and
outputs) beyond what is needed to run the task, and never longer than 30 days. While your account is
open we keep only task metadata: ids, timestamps, status, token counts, cost, tool names, error
codes, and a one-way hash of the instruction. OpenAI may keep task conversations for a limited time
under its own data policies. CodeDroid is not intended for users under 18. See the
[privacy policy](https://www.codedroid.com/privacy).

## Need help?

Check everything at once (Node, adb, pairing, the daemon, each phone, your coding clients):

```bash
npx -y @codedroid/mcp doctor
```

Manage or revoke computer access in **CodeDroid → Settings → Computers**. Run flows from CI with
the [GitHub Action](docs/reference.md#ci-replay-flows-from-github-actions).

See the [reference guide](docs/reference.md) for tools, manual setup, configuration,
[troubleshooting](docs/reference.md#troubleshooting), and development.

## License

[MIT](LICENSE) © 2026 CodeDroid
