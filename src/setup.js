/**
 * `setup` adds CodeDroid to the coding clients on this computer:
 *
 * - Claude Code and Codex get the plugin through their own CLI, as the README's install commands
 *   do: the MCP server and the skills, updated by the client.
 * - Antigravity gets the plugin copied into its global plugins folder, which the app, the IDE and
 *   the CLI all load. Running a newer `setup` replaces it with that release.
 * - Cursor, VS Code, Claude Desktop, Windsurf and Zed get the MCP server in their JSON config, pinned
 *   to this release like the plugin's .mcp.json. Running a newer `setup` moves the pin.
 *
 * A client that already has some other `codedroid` server is left alone, so its tools are never
 * registered twice. A config keeps its comments and formatting, and one that cannot be read or
 * parsed is never rewritten.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import { applyEdits, modify, parse } from "jsonc-parser";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { VERSION } from "./version.js";

const PACKAGE = "@codedroid/mcp";
const REPO = "codedroid-team/codedroid-mcp";
const PLUGIN = "codedroid@codedroid";
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** What the Antigravity plugin is made of, as the repository root holds it for `agy plugin install`. */
const ANTIGRAVITY_PLUGIN_FILES = [".antigravity-plugin", "assets", "mcp_config.json", "skills"];

export const SERVER = { command: "npx", args: ["-y", `${PACKAGE}@${VERSION}`] };
export const MANUAL_SETUP = `https://github.com/${REPO}/blob/main/docs/reference.md#mcp-configuration`;

/**
 * Runs a client's CLI: ok, its stdout, and a one-line reason for when it failed. It runs in an
 * empty directory, so what it sees is the client's user-wide setup: from the home directory,
 * `claude mcp get` also finds a server added there in local scope, which no other project has.
 */
export function runCli(command, args, { timeout = 180_000 } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-setup-"));
  let result;
  try {
    result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      // npm-installed CLIs are .cmd shims on Windows, which only a shell runs.
      shell: process.platform === "win32",
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const text = result.error?.code === "ENOENT"
    ? `${command} is not on PATH`
    : result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `${command} exited with ${result.status}`;
  return { ok: result.status === 0, stdout: result.stdout ?? "", reason: text.split("\n").at(-1) };
}

function appDataDir({ home, platform, env }) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA ?? path.join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME ?? path.join(home, ".config");
}

/** Zed's config: ~/.config/zed on macOS, the platform's config directory elsewhere. */
function zedDir({ home, platform, appData }) {
  if (platform === "darwin") return path.join(home, ".config", "zed");
  return path.join(appData, platform === "win32" ? "Zed" : "zed");
}

/** Every supported client: an id for --client, a name, whether it is installed, and its setup. */
export function clients({ home = os.homedir(), platform = process.platform, env = process.env, run = runCli } = {}) {
  const appData = appDataDir({ home, platform, env });
  const onPath = (command) => () => run(command, ["--version"]).ok;
  return [
    { id: "claude-code", name: "Claude Code", installed: onPath("claude"), setup: () => setupClaudeCode(run) },
    {
      id: "codex",
      name: "Codex",
      installed: onPath("codex"),
      setup: () => setupCodex(run, env.CODEX_HOME ?? path.join(home, ".codex")),
    },
    antigravity({ home, platform, env }),
    jsonClient("cursor", "Cursor", path.join(home, ".cursor"), "mcp.json", "mcpServers", SERVER),
    jsonClient("vscode", "VS Code", path.join(appData, "Code", "User"), "mcp.json", "servers", { type: "stdio", ...SERVER }),
    jsonClient("claude-desktop", "Claude Desktop", path.join(appData, "Claude"), "claude_desktop_config.json", "mcpServers", SERVER),
    jsonClient("windsurf", "Windsurf", path.join(home, ".codeium", "windsurf"), "mcp_config.json", "mcpServers", SERVER),
    jsonClient("zed", "Zed", zedDir({ home, platform, appData }), "settings.json", "context_servers", SERVER),
  ];
}

/** The clients named in `only` (comma-separated ids), else every installed one. Throws on an unknown id. */
export function pickClients(all, only) {
  if (!only) return all.filter((client) => client.installed());
  const ids = only.split(",").map((id) => id.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !all.some((client) => client.id === id));
  if (unknown.length) throw new Error(`Unknown client: ${unknown.join(", ")}. Clients: ${all.map((c) => c.id).join(", ")}.`);
  return all.filter((client) => ids.includes(client.id));
}

const failed = (result) => ({ status: "failed", detail: `failed: ${result.reason}` });

function setupClaudeCode(run) {
  const plugins = parseJson(run("claude", ["plugin", "list", "--json"]).stdout);
  if (Array.isArray(plugins) && plugins.some((p) => p.id === PLUGIN)) return { status: "present", detail: "has the CodeDroid plugin" };
  if (run("claude", ["mcp", "get", "codedroid"]).ok) return { status: "skipped", detail: "already has a codedroid MCP server" };
  const install = run("claude", ["plugin", "install", "codedroid", "--marketplace", REPO]);
  return install.ok ? { status: "added", detail: "installed the CodeDroid plugin" } : failed(install);
}

function setupCodex(run, codexHome) {
  const config = readText(path.join(codexHome, "config.toml")) ?? "";
  if (/^\s*\[plugins\."codedroid@codedroid"\]/m.test(config)) return { status: "present", detail: "has the CodeDroid plugin" };
  if (/^\s*\[mcp_servers\.codedroid\]/m.test(config)) return { status: "skipped", detail: "already has a codedroid MCP server" };
  for (const args of [["plugin", "marketplace", "add", REPO], ["plugin", "add", PLUGIN]]) {
    const result = run("codex", args);
    if (!result.ok) return failed(result);
  }
  return { status: "added", detail: "installed the CodeDroid plugin" };
}

/**
 * Antigravity: the plugin, as a folder in ~/.gemini/config/plugins, where the app's Customizations
 * page lists it with its skills and MCP server. The MCP config entry earlier releases added instead
 * is removed, so the tools are not registered twice; some other codedroid server there is left alone.
 */
function antigravity({ home, platform, env }) {
  const configDir = path.join(home, ".gemini", "config");
  const configPath = path.join(configDir, "mcp_config.json");
  const pluginDir = path.join(configDir, "plugins", "codedroid");
  const apps = [
    path.join(home, ".gemini", "antigravity"),
    ...(platform === "darwin" ? ["/Applications/Antigravity.app", path.join(home, "Applications", "Antigravity.app")] : []),
    ...(platform === "win32" ? [path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "Antigravity")] : []),
  ];
  return {
    id: "antigravity",
    name: "Antigravity",
    installed: () => apps.some((dir) => fs.existsSync(dir)),
    setup: () => {
      const existing = pluginManifest(pluginDir);
      if (fs.existsSync(pluginDir) && existing?.name !== "codedroid") {
        return { status: "skipped", detail: `${pluginDir} holds some other plugin, left it unchanged` };
      }
      const server = parseJson(readText(configPath))?.mcpServers?.codedroid;
      if (server && !launchesCodeDroid(server)) return { status: "skipped", detail: `already has another codedroid server in ${configPath}` };
      if (server) removeServer(configPath, "mcpServers");
      if (existing && compareVersions(existing.version, VERSION) >= 0) {
        return server ? { status: "updated", detail: `has the CodeDroid plugin, removed the duplicate server from ${configPath}` } : { status: "present", detail: "has the CodeDroid plugin" };
      }
      fs.rmSync(pluginDir, { recursive: true, force: true });
      for (const file of ANTIGRAVITY_PLUGIN_FILES) {
        fs.cpSync(path.join(PACKAGE_ROOT, file), path.join(pluginDir, file), { recursive: true });
      }
      return existing || server
        ? { status: "updated", detail: `updated the CodeDroid plugin in ${pluginDir}` }
        : { status: "added", detail: `added the CodeDroid plugin to ${pluginDir}` };
    },
  };
}

/** A plugin folder's manifest: .antigravity-plugin/plugin.json, else plugin.json at its root. */
function pluginManifest(dir) {
  return parseJson(readText(path.join(dir, ".antigravity-plugin", "plugin.json"))) ?? parseJson(readText(path.join(dir, "plugin.json")));
}

/** Negative when version a is older than b; a missing or malformed version counts as oldest. */
function compareVersions(a, b) {
  const parts = (v) => (typeof v === "string" ? v.split(".").map((n) => Number.parseInt(n, 10) || 0) : [-1]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

function jsonClient(id, name, dir, file, key, entry) {
  const configPath = path.join(dir, file);
  return { id, name, installed: () => fs.existsSync(dir), setup: () => addServer(configPath, key, entry) };
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a config entry launches this package, so `setup` may update it. */
function launchesCodeDroid(entry) {
  return Array.isArray(entry?.args) && entry.args.some((arg) => arg === PACKAGE || String(arg).startsWith(`${PACKAGE}@`));
}

/** Removes config[key].codedroid from the JSON file at configPath, keeping the rest as it was. */
function removeServer(configPath, key) {
  const text = readText(configPath);
  writeText(configPath, applyEdits(text, modify(text, [key, "codedroid"], undefined, {})));
}

/**
 * Puts `entry` at config[key].codedroid in the JSON file at configPath, creating the file if needed.
 * An older CodeDroid entry is updated, keeping fields such as its env; any other is left alone. The
 * file may have comments and trailing commas (Zed's, VS Code's), and keeps them.
 */
export function addServer(configPath, key, entry) {
  const text = readText(configPath) ?? "";
  const config = text.trim() ? parseJson(text) : {};
  if (!isObject(config) || (config[key] !== undefined && !isObject(config[key]))) {
    return { status: "failed", detail: `could not read ${configPath} as JSON, left it unchanged. Add the server by hand: ${MANUAL_SETUP}` };
  }
  const existing = config[key]?.codedroid;
  if (existing && !launchesCodeDroid(existing)) {
    return { status: "skipped", detail: `already has another codedroid server in ${configPath}` };
  }
  const next = { ...existing, ...entry };
  if (existing && JSON.stringify(next) === JSON.stringify(existing)) return { status: "present", detail: `set up in ${configPath}` };
  const updated = text.trim()
    ? applyEdits(text, modify(text, [key, "codedroid"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    : JSON.stringify({ [key]: { codedroid: next } }, null, 2) + "\n";
  writeText(configPath, updated);
  return existing
    ? { status: "updated", detail: `updated the server in ${configPath}` }
    : { status: "added", detail: `added the server to ${configPath}` };
}

/** A file's text, or undefined if it does not exist. Any other error throws: unreadable is not empty. */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}

/** JSON, with the comments and trailing commas some clients allow; undefined when it is not. */
function parseJson(text) {
  const errors = [];
  const value = parse(text ?? "", errors, { allowTrailingComma: true });
  return errors.length ? undefined : value;
}

/** Writes through a symlinked config (dotfile managers) and keeps its mode, never half-written. */
function writeText(file, text) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, target);
}
