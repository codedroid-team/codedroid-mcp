# CodeDroid MCP

Let Claude Code, Codex, Gemini CLI, or any MCP client use your Android phone.
Read the screen, interact with apps, take screenshots, and test what you build
through [CodeDroid](https://get.codedroid.com). Your phone and computer can be on different networks.

## Get started

You'll need **Node.js 20+** and **CodeDroid on your Android phone**, signed in with
its accessibility service enabled. Both devices need internet access.

### 1. Install for your coding client

**Claude Code** — run inside Claude Code:

```text
/plugin marketplace add codedroid-team/codedroid-mcp
/plugin install codedroid@codedroid
```

**Codex** — run in your terminal:

```bash
codex plugin marketplace add codedroid-team/codedroid-mcp
codex plugin add codedroid@codedroid
```

**Gemini CLI** — run in your terminal:

```bash
gemini extensions install https://github.com/codedroid-team/codedroid-mcp
```

Each installation includes the MCP server and skills for phone control and Android app testing.
Restart your coding client after installing.

Using another client? See [manual MCP setup](docs/reference.md#mcp-configuration).

### 2. Pair your phone

1. Open **CodeDroid → Settings → Computers → Pair a computer** on your phone.
2. Run the command shown there in your computer's terminal. For example:

   ```bash
   npx -y @codedroid/mcp pair ABCD-EFGH
   ```

3. Tap **Allow** on your phone when prompted.

Use the command exactly as shown. Pairing codes expire after 10 minutes and work once.

### 3. Ask your agent

> Read the screen on my phone and describe what is open.

Then try:

- “Open Android Settings and check the Android version.”
- “Open my app, navigate to sign-in, and take a screenshot.”
- “Install this APK, launch it, and check for crashes.”*

*Installing APKs and using `adb` also requires turning the `adb` tool on, Android platform-tools,
and a USB or wireless debugging connection. See [adb setup](docs/reference.md#adb-setup).

## What it includes

- **MCP tools** to read the screen, take screenshots, tap, type, swipe, open apps, and hand
  CodeDroid's agent a multi-step task, on one phone or [several](docs/reference.md#several-phones).
  See the [tool list](docs/reference.md#tools).
- **Skills**: `codedroid-phone` teaches the agent to drive the phone one checked step at a time,
  and `test-on-device` walks it through building, installing, and verifying an Android app change.
- **An optional `adb` tool**, off by default, that runs adb commands on your computer.

## Privacy and security

The plugin runs `npx -y @codedroid/mcp@<version>`, which downloads this exact release from npm
and starts a local MCP server. Everything it sends goes over TLS to the CodeDroid server, `orchestrator.codedroid.com`
unless the pairing command shown on your phone names another:

- **Pairing** sends the one-time code, your computer's name, and its OS (for example `darwin`),
  so the phone can show which computer is connected.
- **Tool calls** are relayed between your agent and the phone: screen contents, screenshots, text
  you ask it to type, clipboard reads and writes, and task progress. The phone asks you to
  **Allow** a computer the first time, shows when one is in use, and can stop or revoke it.

The local server listens on `127.0.0.1` only and requires a per-user token. Pairing credentials,
the token, and logs stay in `~/.codedroid` on your computer. The `adb` tool runs only on your
computer and is off unless you turn it on. The plugin collects no analytics. See
[Architecture](docs/reference.md#architecture) for details.

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
