/**
 * `setup`: what it writes into each client's config, and which CLI commands it runs, in a home of
 * its own with a fake CLI — it never touches a real client.
 *
 * Run: node test/setup.test.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addServer, clients, enableClaudeAutoUpdate, pickClients, refreshInstalls, runCli, SERVER } from "../src/setup.js";
import { installSkills, SKILLS, skillSource } from "../src/skill.js";
import { VERSION } from "../src/version.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-setup-"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const newHome = () => fs.mkdtempSync(path.join(root, "home-"));

/** A fake CLI: records each call; `answers` maps "command args..." to {ok, stdout}. */
function fakeRun(answers = {}) {
  const calls = [];
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    return { ok: false, stdout: "", reason: `${command} is not on PATH`, ...answers[line] };
  };
  return { run, calls };
}

try {
  assert.deepEqual(SERVER.args, ["-y", "@codedroid/mcp@latest"], "@latest like the plugins' .mcp.json: a release arrives with the next start");

  // ── JSON configs: add, then nothing to do, then a newer pin keeps the env ──
  {
    const file = path.join(newHome(), ".cursor", "mcp.json");
    assert.equal(addServer(file, "mcpServers", SERVER).status, "added", "creates the file and its directory");
    assert.deepEqual(readJson(file), { mcpServers: { codedroid: SERVER } });
    assert.equal(addServer(file, "mcpServers", SERVER).status, "present");

    const config = readJson(file);
    config.mcpServers.codedroid = { command: "npx", args: ["-y", "@codedroid/mcp@0.1.0"], env: { CODEDROID_MCP_ADB: "1" } };
    config.mcpServers.other = { command: "other" };
    config.theme = "dark";
    fs.writeFileSync(file, JSON.stringify(config));
    fs.chmodSync(file, 0o600);
    assert.equal(addServer(file, "mcpServers", SERVER).status, "updated");
    assert.deepEqual(readJson(file), {
      mcpServers: { codedroid: { ...SERVER, env: { CODEDROID_MCP_ADB: "1" } }, other: { command: "other" } },
      theme: "dark",
    }, "keeps the env, the other servers and the other settings");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "keeps the file's mode");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["mcp.json"], "leaves no temporary file");
  }

  // An unpinned CodeDroid entry is ours too.
  {
    const file = path.join(newHome(), "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { codedroid: { command: "npx", args: ["-y", "@codedroid/mcp"] } } }));
    assert.equal(addServer(file, "mcpServers", SERVER).status, "updated");
  }

  // Comments and trailing commas (Zed's settings.json) stay; only the codedroid entry changes.
  {
    const file = path.join(newHome(), "settings.json");
    const text = '// Zed settings\n{\n  "theme": "One Dark", // mine\n  "ui_font_size": 16,\n}\n';
    fs.writeFileSync(file, text);
    assert.equal(addServer(file, "context_servers", SERVER).status, "added");
    const written = fs.readFileSync(file, "utf8");
    assert.ok(written.startsWith('// Zed settings\n{\n  "theme": "One Dark", // mine\n'), written);
    assert.equal(addServer(file, "context_servers", SERVER).status, "present", "reads its own write");
  }

  // Another server named codedroid, a config that is not JSON, or a wrong shape: never rewritten.
  {
    const dir = newHome();
    const cases = {
      "foreign.json": [JSON.stringify({ mcpServers: { codedroid: { command: "node", args: ["/src/codedroid/index.js"] } } }), "skipped"],
      "broken.json": ['{\n  "servers": {\n', "failed"],
      "array.json": ["[]", "failed"],
      "servers-array.json": [JSON.stringify({ mcpServers: [] }), "failed"],
    };
    for (const [name, [text, status]] of Object.entries(cases)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      assert.equal(addServer(file, "mcpServers", SERVER).status, status, name);
      assert.equal(fs.readFileSync(file, "utf8"), text, `${name} is left unchanged`);
    }
    const empty = path.join(dir, "empty.json");
    fs.writeFileSync(empty, "");
    assert.equal(addServer(empty, "mcpServers", SERVER).status, "added", "an empty file is an empty config");

    // Root reads a mode-000 file anyway, so there is nothing to test as root.
    if (process.getuid?.() > 0) {
      const unreadable = path.join(dir, "unreadable.json");
      const text = JSON.stringify({ mcpServers: { other: { command: "other" } } });
      fs.writeFileSync(unreadable, text);
      fs.chmodSync(unreadable, 0o000);
      assert.throws(() => addServer(unreadable, "mcpServers", SERVER), { code: "EACCES" });
      fs.chmodSync(unreadable, 0o644);
      assert.equal(fs.readFileSync(unreadable, "utf8"), text, "an unreadable config is not an empty one");
    }
  }

  // A symlinked config (a dotfile manager's) stays a symlink: the write goes to its target.
  {
    const dir = newHome();
    const target = path.join(dir, "dotfiles", "mcp.json");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, "{}");
    const link = path.join(dir, "mcp.json");
    fs.symlinkSync(target, link);
    assert.equal(addServer(link, "mcpServers", SERVER).status, "added");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.deepEqual(readJson(target), { mcpServers: { codedroid: SERVER } });
  }

  // ── Each JSON client's file and shape, per platform ──
  {
    const home = newHome();
    const { run } = fakeRun();
    const byId = (all) => Object.fromEntries(all.map((c) => [c.id, c]));
    const mac = byId(clients({ home, platform: "darwin", env: {}, run }));
    for (const id of ["cursor", "vscode", "claude-desktop", "windsurf", "zed"]) assert.equal(mac[id].installed(), false, `${id}: not installed yet`);
    const support = path.join(home, "Library", "Application Support");
    fs.mkdirSync(path.join(support, "Code", "User"), { recursive: true });
    fs.mkdirSync(path.join(support, "Claude"), { recursive: true });
    assert.deepEqual(pickClients(Object.values(mac), undefined).map((c) => c.id), ["vscode", "claude-desktop"], "only the installed ones");
    for (const id of ["vscode", "claude-desktop", "cursor", "windsurf", "zed"]) assert.equal(mac[id].setup().status, "added", id);
    assert.deepEqual(readJson(path.join(support, "Code", "User", "mcp.json")), { servers: { codedroid: { type: "stdio", ...SERVER } } });
    assert.deepEqual(readJson(path.join(support, "Claude", "claude_desktop_config.json")), { mcpServers: { codedroid: SERVER } });
    assert.deepEqual(readJson(path.join(home, ".cursor", "mcp.json")), { mcpServers: { codedroid: SERVER } });
    assert.deepEqual(readJson(path.join(home, ".codeium", "windsurf", "mcp_config.json")), { mcpServers: { codedroid: SERVER } });
    assert.deepEqual(readJson(path.join(home, ".config", "zed", "settings.json")), { context_servers: { codedroid: SERVER } });

    const linux = byId(clients({ home, platform: "linux", env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, run }));
    linux["claude-desktop"].setup();
    assert.ok(fs.existsSync(path.join(home, "xdg", "Claude", "claude_desktop_config.json")));
    linux.zed.setup();
    assert.ok(fs.existsSync(path.join(home, "xdg", "zed", "settings.json")));
    const windows = byId(clients({ home, platform: "win32", env: { APPDATA: path.join(home, "roaming") }, run }));
    windows.vscode.setup();
    assert.ok(fs.existsSync(path.join(home, "roaming", "Code", "User", "mcp.json")));
    windows.zed.setup();
    assert.ok(fs.existsSync(path.join(home, "roaming", "Zed", "settings.json")));
  }

  // ── --client picks by id, and names an unknown one ──
  {
    const all = clients({ home: newHome(), env: {}, run: fakeRun().run });
    assert.deepEqual(pickClients(all, "cursor, codex").map((c) => c.id), ["codex", "cursor"]);
    assert.throws(() => pickClients(all, "cursor,emacs"), /Unknown client: emacs\. Clients: claude-code, codex, antigravity, cursor/);
  }

  // ── Claude Code: installs the plugin, unless it or a standalone server is there ──
  {
    const install = "claude plugin install codedroid --marketplace codedroid-team/codedroid-mcp";
    const claude = (answers) => {
      const fake = fakeRun(answers);
      const client = clients({ home: newHome(), env: {}, run: fake.run }).find((c) => c.id === "claude-code");
      return { ...fake, client };
    };

    let { client, calls } = claude({ "claude --version": { ok: true }, "claude plugin list --json": { ok: true, stdout: "[]" }, [install]: { ok: true } });
    assert.equal(client.installed(), true);
    assert.equal(client.setup().status, "added");
    assert.equal(calls.at(-1), install);

    ({ client, calls } = claude({ "claude plugin list --json": { ok: true, stdout: JSON.stringify([{ id: "codedroid@codedroid" }]) } }));
    assert.equal(client.setup().status, "present");
    assert.ok(!calls.includes(install));

    ({ client, calls } = claude({ "claude plugin list --json": { ok: true, stdout: "[]" }, "claude mcp get codedroid": { ok: true } }));
    assert.equal(client.setup().status, "skipped", "a standalone server: the plugin would register the tools twice");
    assert.ok(!calls.includes(install));

    ({ client } = claude({ "claude plugin list --json": { ok: true, stdout: "[]" }, [install]: { ok: false, reason: "Failed to clone" } }));
    assert.deepEqual(client.setup(), { status: "failed", detail: "failed: Failed to clone" });
    ({ client } = claude({}));
    assert.equal(client.installed(), false);
  }

  // ── A client's CLI runs in an empty directory: never the home one, whose local-scope servers only it has ──
  {
    const seen = runCli(process.execPath, ["-e", "console.log(JSON.stringify([process.cwd(), require('fs').readdirSync('.')]))"]);
    assert.equal(seen.ok, true, seen.reason);
    const [cwd, entries] = JSON.parse(seen.stdout);
    assert.ok(cwd.startsWith(fs.realpathSync(os.tmpdir())), cwd);
    assert.deepEqual(entries, [], "nothing there for the CLI to read as a project");
    assert.equal(fs.existsSync(cwd), false, "and it is removed afterwards");
    assert.equal(runCli("codedroid-no-such-cli", []).reason, "codedroid-no-such-cli is not on PATH");
  }

  // ── Codex: adds the marketplace, then the plugin; reads config.toml for what is there ──
  {
    const home = newHome();
    const codexHome = path.join(home, "codex-home");
    fs.mkdirSync(codexHome);
    const fake = fakeRun({
      "codex plugin marketplace add codedroid-team/codedroid-mcp": { ok: true },
      "codex plugin add codedroid@codedroid": { ok: true },
    });
    const codex = clients({ home, env: { CODEX_HOME: codexHome }, run: fake.run }).find((c) => c.id === "codex");
    assert.equal(codex.setup().status, "added");
    assert.deepEqual(fake.calls, ["codex plugin marketplace add codedroid-team/codedroid-mcp", "codex plugin add codedroid@codedroid"]);

    fs.writeFileSync(path.join(codexHome, "config.toml"), '[plugins."codedroid@codedroid"]\nenabled = true\n');
    assert.equal(codex.setup().status, "present");
    fs.writeFileSync(path.join(codexHome, "config.toml"), '[mcp_servers.codedroid]\ncommand = "npx"\n');
    assert.equal(codex.setup().status, "skipped");
    assert.equal(fake.calls.length, 2, "and runs nothing more");

    const failing = clients({ home: newHome(), env: {}, run: fakeRun().run }).find((c) => c.id === "codex");
    assert.deepEqual(failing.setup(), { status: "failed", detail: "failed: codex is not on PATH" });
  }

  // ── Antigravity: the plugin folder the app loads; an earlier release's config server goes ──
  {
    const home = newHome();
    const configDir = path.join(home, ".gemini", "config");
    const configPath = path.join(configDir, "mcp_config.json");
    const pluginDir = path.join(configDir, "plugins", "codedroid");
    const fake = fakeRun();
    const antigravity = () => clients({ home, platform: "linux", env: {}, run: fake.run }).find((c) => c.id === "antigravity");
    assert.equal(antigravity().installed(), false, "no app");
    fs.mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
    assert.equal(antigravity().installed(), true, "the app's data folder");

    assert.equal(antigravity().setup().status, "added");
    assert.deepEqual(fake.calls, [], "no CLI needed");
    const manifest = readJson(path.join(pluginDir, ".antigravity-plugin", "plugin.json"));
    assert.equal(manifest.version, VERSION);
    assert.deepEqual(readJson(path.join(pluginDir, "mcp_config.json")), { mcpServers: { codedroid: SERVER } });
    assert.ok(fs.existsSync(path.join(pluginDir, "skills", "codedroid-phone", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(pluginDir, manifest.logo)));
    assert.equal(antigravity().setup().status, "present");

    // An older release's plugin is replaced, and its server in mcp_config.json removed.
    fs.writeFileSync(path.join(pluginDir, ".antigravity-plugin", "plugin.json"), JSON.stringify({ name: "codedroid", version: "0.1.0" }));
    fs.writeFileSync(path.join(pluginDir, "stale.txt"), "");
    fs.writeFileSync(configPath, '{\n  // mine\n  "mcpServers": {\n    "other": { "command": "x" },\n    "codedroid": { "command": "npx", "args": ["-y", "@codedroid/mcp@0.1.14"] }\n  }\n}\n');
    assert.equal(antigravity().setup().status, "updated");
    assert.equal(readJson(path.join(pluginDir, ".antigravity-plugin", "plugin.json")).version, VERSION);
    assert.ok(!fs.existsSync(path.join(pluginDir, "stale.txt")));
    assert.match(fs.readFileSync(configPath, "utf8"), /\/\/ mine/);
    assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /codedroid/);

    // A newer plugin stays; a codedroid server of someone else's, or another plugin's folder, is left alone.
    fs.writeFileSync(path.join(pluginDir, ".antigravity-plugin", "plugin.json"), JSON.stringify({ name: "codedroid", version: "99.0.0" }));
    assert.equal(antigravity().setup().status, "present");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { codedroid: { command: "other" } } }));
    assert.equal(antigravity().setup().status, "skipped");
    fs.rmSync(configPath);
    fs.rmSync(path.join(pluginDir, ".antigravity-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "someone-else" }));
    assert.equal(antigravity().setup().status, "skipped");
    assert.ok(fs.existsSync(path.join(pluginDir, "plugin.json")));

    const mac = newHome();
    fs.mkdirSync(path.join(mac, "Applications", "Antigravity.app"), { recursive: true });
    assert.equal(clients({ home: mac, platform: "darwin", env: {}, run: fakeRun().run }).find((c) => c.id === "antigravity").installed(), true, "the app in ~/Applications");
  }

  // ── Claude Code: auto-update for the marketplace, which Claude leaves off for one that is not Anthropic's ──
  {
    const home = newHome();
    const file = path.join(home, ".claude", "plugins", "known_marketplaces.json");
    assert.equal(enableClaudeAutoUpdate(home), false, "no Claude Code here: nothing to write");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ codedroid: { source: { source: "github", repo: "codedroid-team/codedroid-mcp" }, installLocation: "/x" } }, null, 2) + "\n");
    assert.equal(enableClaudeAutoUpdate(home), true);
    assert.equal(readJson(file).codedroid.autoUpdate, true);
    assert.equal(readJson(file).codedroid.installLocation, "/x", "the rest of the entry stays");
    assert.equal(enableClaudeAutoUpdate(home), false, "already on");
    fs.writeFileSync(file, JSON.stringify({ codedroid: { autoUpdate: false } }));
    assert.equal(enableClaudeAutoUpdate(home), false, "a choice made in /plugin stays");
    assert.equal(readJson(file).codedroid.autoUpdate, false);
    fs.writeFileSync(file, JSON.stringify({ other: {} }));
    assert.equal(enableClaudeAutoUpdate(home), false, "a marketplace Claude does not know is not added");

    // setup with the plugin present turns it on; check reports the plugin's version and the switch.
    fs.writeFileSync(file, JSON.stringify({ codedroid: { source: {} } }));
    const listing = (version) => ({ "claude plugin list --json": { ok: true, stdout: JSON.stringify([{ id: "codedroid@codedroid", version }]) } });
    const claude = (answers) => clients({ home, env: {}, run: fakeRun(answers).run }).find((c) => c.id === "claude-code");
    assert.deepEqual(claude(listing("0.1.3")).setup(), { status: "updated", detail: `has the CodeDroid plugin 0.1.3, ${VERSION} arrives with the next Claude Code start, auto-update on` });
    assert.equal(claude(listing("0.1.3")).setup().status, "present", "and then nothing to do");
    fs.writeFileSync(file, JSON.stringify({ codedroid: { autoUpdate: false } }));
    assert.equal(claude(listing("0.1.3")).check().detail, `has the CodeDroid plugin 0.1.3, this is ${VERSION}: run claude plugin update codedroid@codedroid, auto-update off`);
    assert.equal(claude(listing(VERSION)).setup().detail, `has the CodeDroid plugin ${VERSION}, auto-update off`);
    // A fresh install turns it on too, once claude has recorded the marketplace.
    fs.writeFileSync(file, JSON.stringify({ codedroid: { source: {} } }));
    const install = "claude plugin install codedroid --marketplace codedroid-team/codedroid-mcp";
    assert.deepEqual(claude({ "claude plugin list --json": { ok: true, stdout: "[]" }, [install]: { ok: true } }).setup(), { status: "added", detail: "installed the CodeDroid plugin, auto-update on" });
    assert.equal(readJson(file).codedroid.autoUpdate, true);
  }

  // ── Codex: the plugin version in its cache, against this release ──
  {
    const home = newHome();
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(path.join(codexHome, "plugins", "cache", "codedroid", "codedroid", "0.1.9"), { recursive: true });
    fs.mkdirSync(path.join(codexHome, "plugins", "cache", "codedroid", "codedroid", "0.1.15"), { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), '[plugins."codedroid@codedroid"]\nenabled = true\n');
    const codex = clients({ home, env: {}, run: fakeRun().run }).find((c) => c.id === "codex");
    assert.equal(codex.check().detail, `has the CodeDroid plugin 0.1.15 (this is ${VERSION}: run codex plugin marketplace upgrade codedroid, then codex plugin add codedroid@codedroid)`);
    fs.mkdirSync(path.join(codexHome, "plugins", "cache", "codedroid", "codedroid", VERSION));
    assert.equal(codex.check().detail, `has the CodeDroid plugin ${VERSION}`);
  }

  // ── The daemon's refresh: what earlier releases left becomes this release, and nothing new appears ──
  {
    const home = newHome();
    assert.deepEqual(refreshInstalls({ home, platform: "linux", env: {} }), [], "an empty computer: nothing to do");

    // A config pinned to an older release moves to @latest and keeps its env; @latest and someone else's stay.
    const cursor = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(cursor, JSON.stringify({ mcpServers: { codedroid: { command: "npx", args: ["-y", "@codedroid/mcp@0.1.14"], env: { CODEDROID_MCP_ADB: "0" } } } }));
    const vscode = path.join(home, ".config", "Code", "User", "mcp.json");
    fs.mkdirSync(path.dirname(vscode), { recursive: true });
    fs.writeFileSync(vscode, JSON.stringify({ servers: { codedroid: { type: "stdio", command: "npx", args: ["-y", "@codedroid/mcp@latest"] } } }));
    const windsurf = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    fs.mkdirSync(path.dirname(windsurf), { recursive: true });
    fs.writeFileSync(windsurf, JSON.stringify({ mcpServers: { codedroid: { command: "other" } } }));
    // An older Antigravity plugin of ours.
    const pluginDir = path.join(home, ".gemini", "config", "plugins", "codedroid");
    fs.mkdirSync(path.join(pluginDir, ".antigravity-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, ".antigravity-plugin", "plugin.json"), JSON.stringify({ name: "codedroid", version: "0.1.14" }));
    // Skills a `skill install` of an older release left, one of them changed since.
    const skills = path.join(home, ".claude", "skills");
    installSkills({ dir: skills });
    fs.writeFileSync(path.join(skills, "codedroid-phone", "SKILL.md"), "---\nname: codedroid-phone\n---\nOld text about com.codedroid.agent.\n");
    // Claude Code knows the marketplace, with the switch untouched.
    const known = path.join(home, ".claude", "plugins", "known_marketplaces.json");
    fs.mkdirSync(path.dirname(known), { recursive: true });
    fs.writeFileSync(known, JSON.stringify({ codedroid: { source: {} } }));

    assert.deepEqual(refreshInstalls({ home, platform: "linux", env: {} }), [
      "Claude Code: turned on auto-update for the codedroid marketplace in Claude Code",
      `Antigravity: updated the CodeDroid plugin in ${pluginDir}, 0.1.14 to ${VERSION}`,
      `Cursor: moved ${cursor} from 0.1.14 to @latest`,
      `Skills: brought the ${SKILLS.length} in ${skills} up to ${VERSION}`,
    ]);
    assert.deepEqual(readJson(cursor).mcpServers.codedroid, { ...SERVER, env: { CODEDROID_MCP_ADB: "0" } });
    assert.deepEqual(readJson(windsurf), { mcpServers: { codedroid: { command: "other" } } });
    assert.equal(readJson(path.join(pluginDir, ".antigravity-plugin", "plugin.json")).version, VERSION);
    assert.ok(fs.existsSync(path.join(pluginDir, "skills", "codedroid-phone", "SKILL.md")));
    assert.equal(fs.readFileSync(path.join(skills, "codedroid-phone", "SKILL.md"), "utf8"), fs.readFileSync(skillSource("codedroid-phone"), "utf8"));
    assert.equal(readJson(known).codedroid.autoUpdate, true);
    assert.ok(!fs.existsSync(path.join(home, ".codex", "skills")), "installs nothing where there was nothing");
    assert.deepEqual(refreshInstalls({ home, platform: "linux", env: {} }), [], "and then there is nothing to do");

    // One client's broken file is one line: the others still get theirs.
    fs.writeFileSync(path.join(pluginDir, ".antigravity-plugin", "plugin.json"), JSON.stringify({ name: "codedroid", version: "0.1.14" }));
    fs.rmSync(cursor);
    fs.mkdirSync(path.join(cursor, "mcp.json"), { recursive: true });
    const lines = refreshInstalls({ home, platform: "linux", env: {} });
    assert.match(lines.find((l) => l.startsWith("Cursor")) ?? "", /could not update it/);
    assert.ok(lines.some((l) => l.startsWith("Antigravity: updated")));
  }

  // ── The CLI: --client and --yes write the config, then say how to pair ──
  {
    const home = newHome();
    const indexPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
    // No adb, so setup never reaches a phone that happens to be plugged into this computer.
    const env = { ...process.env, HOME: home, USERPROFILE: home, ADB: path.join(home, "no-adb") };
    const cli = (args) => new Promise((resolve) => {
      execFile(process.execPath, [indexPath, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      });
    });

    let result = await cli(["setup", "--client=cursor", "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Cursor: added the server to .*mcp\.json$/m);
    assert.match(result.stdout, /Restart Cursor to load CodeDroid\./);
    assert.match(result.stdout, /adb is not installed, so the phone can't be set up over USB\. Get it: https:\/\/developer\.android\.com\S+\nTo reach a phone: Run npx -y @codedroid\/mcp login/);
    assert.deepEqual(readJson(path.join(home, ".cursor", "mcp.json")), { mcpServers: { codedroid: SERVER } });

    result = await cli(["setup", "--client=cursor", "--yes"]);
    assert.match(result.stdout, /^Cursor: set up in /m);
    assert.doesNotMatch(result.stdout, /Restart/);

    result = await cli(["setup", "--client=emacs"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown client: emacs/);

    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), "{ mine\n}");
    result = await cli(["setup", "--client=cursor", "--yes"]);
    assert.equal(result.code, 1, "a client it could not set up fails the run");
    assert.match(result.stdout, /could not read .* as JSON/);

    // A client that throws is one failure: the next client and the pairing steps still run.
    fs.rmSync(path.join(home, ".cursor", "mcp.json"));
    fs.mkdirSync(path.join(home, ".cursor", "mcp.json"));
    result = await cli(["setup", "--client=cursor,windsurf", "--yes"]);
    assert.equal(result.code, 1, "a client it could not set up fails the run");
    assert.match(result.stdout, /^Cursor: failed: .*EISDIR/m);
    assert.match(result.stdout, /^Windsurf: added the server to /m);
    assert.match(result.stdout, /adb is not installed, so the phone can't be set up over USB\. Get it: https:\/\/developer\.android\.com\S+\nTo reach a phone: Run npx -y @codedroid\/mcp login/);
  }

  console.log("setup.test.mjs: ALL PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
