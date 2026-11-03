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
import { addServer, clients, pickClients, SERVER } from "../src/setup.js";
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
  assert.deepEqual(SERVER.args, ["-y", `@codedroid/mcp@${VERSION}`], "pinned like the plugin's .mcp.json");

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

  // Another server named codedroid, a config with comments, or a wrong shape: never rewritten.
  {
    const dir = newHome();
    const cases = {
      "foreign.json": [JSON.stringify({ mcpServers: { codedroid: { command: "node", args: ["/src/codedroid/index.js"] } } }), "skipped"],
      "jsonc.json": ['{\n  // mine\n  "servers": {}\n}\n', "failed"],
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
    for (const id of ["cursor", "vscode", "claude-desktop", "windsurf"]) assert.equal(mac[id].installed(), false, `${id}: not installed yet`);
    const support = path.join(home, "Library", "Application Support");
    fs.mkdirSync(path.join(support, "Code", "User"), { recursive: true });
    fs.mkdirSync(path.join(support, "Claude"), { recursive: true });
    assert.deepEqual(pickClients(Object.values(mac), undefined).map((c) => c.id), ["vscode", "claude-desktop"], "only the installed ones");
    for (const id of ["vscode", "claude-desktop", "cursor", "windsurf"]) assert.equal(mac[id].setup().status, "added", id);
    assert.deepEqual(readJson(path.join(support, "Code", "User", "mcp.json")), { servers: { codedroid: { type: "stdio", ...SERVER } } });
    assert.deepEqual(readJson(path.join(support, "Claude", "claude_desktop_config.json")), { mcpServers: { codedroid: SERVER } });
    assert.deepEqual(readJson(path.join(home, ".cursor", "mcp.json")), { mcpServers: { codedroid: SERVER } });
    assert.deepEqual(readJson(path.join(home, ".codeium", "windsurf", "mcp_config.json")), { mcpServers: { codedroid: SERVER } });

    const linux = byId(clients({ home, platform: "linux", env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, run }));
    linux["claude-desktop"].setup();
    assert.ok(fs.existsSync(path.join(home, "xdg", "Claude", "claude_desktop_config.json")));
    const windows = byId(clients({ home, platform: "win32", env: { APPDATA: path.join(home, "roaming") }, run }));
    windows.vscode.setup();
    assert.ok(fs.existsSync(path.join(home, "roaming", "Code", "User", "mcp.json")));
  }

  // ── --client picks by id, and names an unknown one ──
  {
    const all = clients({ home: newHome(), env: {}, run: fakeRun().run });
    assert.deepEqual(pickClients(all, "cursor, codex").map((c) => c.id), ["codex", "cursor"]);
    assert.throws(() => pickClients(all, "cursor,emacs"), /Unknown client: emacs\. Clients: claude-code, codex, gemini, cursor/);
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

  // ── Gemini CLI: installs the extension unless it or a standalone server is there ──
  {
    const home = newHome();
    const install = "gemini extensions install https://github.com/codedroid-team/codedroid-mcp --consent";
    const fake = fakeRun({ [install]: { ok: true } });
    const gemini = clients({ home, env: {}, run: fake.run }).find((c) => c.id === "gemini");
    assert.equal(gemini.setup().status, "added");
    assert.deepEqual(fake.calls, [install]);

    fs.mkdirSync(path.join(home, ".gemini"));
    fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { codedroid: { command: "npx" } } }));
    assert.equal(gemini.setup().status, "skipped");
    fs.mkdirSync(path.join(home, ".gemini", "extensions", "codedroid"), { recursive: true });
    assert.equal(gemini.setup().status, "present");
    assert.equal(fake.calls.length, 1);
  }

  // ── The CLI: --client and --yes write the config, then say how to pair ──
  {
    const home = newHome();
    const indexPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const cli = (args) => new Promise((resolve) => {
      execFile(process.execPath, [indexPath, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      });
    });

    let result = await cli(["setup", "--client=cursor", "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Cursor: added the server to .*mcp\.json$/m);
    assert.match(result.stdout, /Restart Cursor to load CodeDroid\./);
    assert.match(result.stdout, /Next, pair your phone\./);
    assert.deepEqual(readJson(path.join(home, ".cursor", "mcp.json")), { mcpServers: { codedroid: SERVER } });

    result = await cli(["setup", "--client=cursor", "--yes"]);
    assert.match(result.stdout, /^Cursor: set up in /m);
    assert.doesNotMatch(result.stdout, /Restart/);

    result = await cli(["setup", "--client=emacs"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown client: emacs/);

    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), "{ // mine\n}");
    result = await cli(["setup", "--client=cursor", "--yes"]);
    assert.equal(result.code, 1, "a client it could not set up fails the run");
    assert.match(result.stdout, /could not read .* as JSON/);
  }

  console.log("setup.test.mjs: ALL PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
