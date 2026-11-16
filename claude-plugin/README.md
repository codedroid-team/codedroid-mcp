# CodeDroid

Let Claude use your Android phone. Read the screen, tap and type, open apps, take screenshots,
hand CodeDroid's own phone agent a whole task, and verify the Android app you are building on a
real device, through [CodeDroid](https://get.codedroid.com).

This plugin connects Claude to CodeDroid's server over HTTPS. Nothing is installed or run on
your computer. Your phone and computer can be on different networks.

## Get started

1. Install CodeDroid on your phone from [get.codedroid.com](https://get.codedroid.com), sign in
   with Google, and turn on its accessibility service when it asks.
2. Install this plugin. The first time Claude uses it, sign in with the same Google account.
3. On the phone, tap **Allow** when CodeDroid asks whether Claude may use it.

Then ask Claude:

> Read the screen on my phone and describe what is open.

- "Open Android Settings and check the Android version."
- "Open my app, navigate to sign-in, and take a screenshot."
- "Run the sign-up flow in my app and tell me where it breaks."

## What it includes

- **MCP tools** to read the screen, take screenshots, tap, type, swipe, open apps, and hand
  CodeDroid's agent a multi-step task, on one phone or several on your account
  (`codedroid_devices` lists them).
- **Skills**: `codedroid-phone` teaches Claude to drive the phone one checked step at a time;
  `test-on-device` walks it through building, installing and verifying an Android app change;
  `app-e2e` explores an app, writes a test PRD, critical user journeys and test cases into its
  repo, runs them on the phone and writes a report, with `app-e2e-rerun`, `app-e2e-bug` and
  `app-e2e-maintain` to keep them current.

Installing builds and reading logs with adb happen on your computer, so they are not part of
this plugin. For those, install the local version with
`npx -y @codedroid/mcp setup`, which also works with Codex, Cursor, VS Code and other clients.
See the [reference](https://github.com/codedroid-team/codedroid-mcp/blob/main/docs/reference.md).

## Privacy and security

Claude signs in to CodeDroid with your Google account (OAuth; Claude never sees your password)
and holds a token you can revoke from CodeDroid on the phone: **Settings > Computers**. Tool
calls go over TLS to the CodeDroid server, `orchestrator.codedroid.com`, which relays them to
your phone: screen contents, screenshots, text Claude asks it to type, clipboard reads and
writes, and task progress. The phone asks you to **Allow** Claude the first time, shows when it
is in use, and can stop or revoke it.

CodeDroid keeps usage records under your account: connecting, and for each tool call its name,
whether it worked, its error code and how long it took. Usage records never include tool
arguments, screen contents, or text you type. When Claude calls `run_task`, the instruction
runs on your phone with CodeDroid's servers and our AI model provider (OpenAI); CodeDroid keeps
task content no longer than 30 days. CodeDroid is not intended for users under 18. See the
[privacy policy](https://www.codedroid.com/privacy) and [terms](https://www.codedroid.com/terms).

## Need help?

[Open an issue](https://github.com/codedroid-team/codedroid-mcp/issues), or revoke and
reconnect from **CodeDroid > Settings > Computers** on the phone.

## License

[MIT](LICENSE) © 2026 CodeDroid
