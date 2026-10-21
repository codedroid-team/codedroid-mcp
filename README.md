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
