# CodeDroid MCP

Let Claude Code, Codex, Antigravity, or any MCP client use your Android phone.
Read the screen, interact with apps, take screenshots, and test what you build
through [CodeDroid](https://get.codedroid.com). Your phone and computer can be on different networks.

## Get started

You'll need **Node.js 20+** and an Android phone. Both devices need internet access.

### Fastest: plug in your phone

Turn on **USB debugging** on the phone, plug it into your computer, and run:

```bash
npx -y @codedroid/mcp setup
```

It adds CodeDroid to every coding client it finds (Claude Code, Codex, Antigravity, Cursor, VS Code,
Claude Desktop, Windsurf, Zed), installs the CodeDroid app on the phone, turns on its accessibility
service, and pairs the phone with this computer. On the phone, you allow USB debugging for this
computer, sign in to CodeDroid with Google, and tap **Allow** when your computer first connects.
Then restart your coding client.

Already have the plugin? Ask your agent to "set up my phone" instead: it does the same, and asks
you before installing anything.
Setting up over USB needs [adb](https://developer.android.com/tools/releases/platform-tools).

### Or step by step

#### 1. Install for your coding client

**Every client at once**: run `npx -y @codedroid/mcp setup` in your terminal. Or for one client:

**Claude Code**: run in your terminal:

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

#### 2. Pair your phone

1. Install CodeDroid from [get.codedroid.com](https://get.codedroid.com), sign in, and turn on its
   accessibility service when it asks.
2. Open **CodeDroid → Settings → Computers → Pair a computer**.
3. Run the command shown there in your computer's terminal. For example:

   ```bash
   npx -y @codedroid/mcp pair ABCD-EFGH
   ```

4. Tap **Allow** on your phone when prompted.

Use the command exactly as shown. Pairing codes expire after 10 minutes and work once.

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
  See the [tool list](docs/reference.md#tools).
- **Skills**: `codedroid-phone` teaches the agent to drive the phone one checked step at a time,
  and `test-on-device` walks it through building, installing, and verifying an Android app change.
  `app-e2e` tests an app end to end: it explores the app, writes a test PRD, critical user
  journeys and test cases into its repo (`e2e/`), stops for your review of each, runs the cases on
  the phone and writes a report with a screenshot per case. Each step is its own skill
  (`app-e2e-explore`, `-prd`, `-cujs`, `-testcases`, `-run`). Then `app-e2e-rerun` runs some
  of the cases (by id, journey or priority, last failures, the ones a change touches, a flaky
  check), `app-e2e-bug` turns a bug into a case that reproduces it, and `app-e2e-maintain` keeps
  the cases current as the app changes. After writing the documents, the agent runs
  `npx -y @codedroid/mcp e2e report`, which writes a quality report and HTML pages into `e2e/`
  and lists any broken references in them; it needs no phone ([details](docs/reference.md#quality-report-for-an-apps-e2e-folder)).
- **`install_apk`** to install a build from your computer, with no cable or shared network.
- **An `adb` tool** that runs adb commands on your computer, to read logs and run tests. You can [turn it off](docs/reference.md#adb-setup).

## Privacy and security

The plugin runs `npx -y @codedroid/mcp@<version>`, which downloads this exact release from npm
and starts a local MCP server. Everything it sends goes over TLS to the CodeDroid server, `orchestrator.codedroid.com`
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

Check your connection:

```bash
npx -y @codedroid/mcp status
```

Manage or revoke computer access in **CodeDroid → Settings → Computers**.

See the [reference guide](docs/reference.md) for tools, manual setup, configuration,
[troubleshooting](docs/reference.md#troubleshooting), and development.

## License

[MIT](LICENSE) © 2026 CodeDroid
