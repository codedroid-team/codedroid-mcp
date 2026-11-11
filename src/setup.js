/**
 * `setup` adds CodeDroid to the coding clients on this computer:
 *
 * - Claude Code, Codex and Gemini CLI get the plugin or extension through their own CLI, as the
 *   README's install commands do: the MCP server and the skills, updated by the client.
 * - Cursor, VS Code, Claude Desktop and Windsurf get the MCP server in their JSON config, pinned to
 *   this release like the plugin's .mcp.json. Running a newer `setup` moves the pin.
 *
 * A client that already has some other `codedroid` server is left alone, so its tools are never
 * registered twice, and a config it cannot read or parse (JSON with comments) is never rewritten.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { VERSION } from "./version.js";

const PACKAGE = "@codedroid/mcp";
const REPO = "codedroid-team/codedroid-mcp";
const PLUGIN = "codedroid@codedroid";

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
    { id: "gemini", name: "Gemini CLI", installed: onPath("gemini"), setup: () => setupGemini(run, path.join(home, ".gemini")) },
    jsonClient("cursor", "Cursor", path.join(home, ".cursor"), "mcp.json", "mcpServers", SERVER),
    jsonClient("vscode", "VS Code", path.join(appData, "Code", "User"), "mcp.json", "servers", { type: "stdio", ...SERVER }),
    jsonClient("claude-desktop", "Claude Desktop", path.join(appData, "Claude"), "claude_desktop_config.json", "mcpServers", SERVER),
    jsonClient("windsurf", "Windsurf", path.join(home, ".codeium", "windsurf"), "mcp_config.json", "mcpServers", SERVER),
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

function setupGemini(run, geminiDir) {
  if (fs.existsSync(path.join(geminiDir, "extensions", "codedroid"))) return { status: "present", detail: "has the CodeDroid extension" };
  if (parseJson(readText(path.join(geminiDir, "settings.json")))?.mcpServers?.codedroid) {
    return { status: "skipped", detail: "already has a codedroid MCP server" };
  }
  // --consent acknowledges Gemini's third-party extension notice; the user confirmed setup already.
  const install = run("gemini", ["extensions", "install", `https://github.com/${REPO}`, "--consent"]);
  return install.ok ? { status: "added", detail: "installed the CodeDroid extension" } : failed(install);
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

/**
 * Puts `entry` at config[key].codedroid in the JSON file at configPath, creating the file if needed.
 * An older CodeDroid entry is updated, keeping fields such as its env; any other is left alone.
 */
export function addServer(configPath, key, entry) {
  const text = readText(configPath);
  const config = text?.trim() ? parseJson(text) : {};
  if (!isObject(config) || (config[key] !== undefined && !isObject(config[key]))) {
    return { status: "failed", detail: `could not read ${configPath} as JSON, left it unchanged. Add the server by hand: ${MANUAL_SETUP}` };
  }
  const existing = config[key]?.codedroid;
  if (existing && !launchesCodeDroid(existing)) {
    return { status: "skipped", detail: `already has another codedroid server in ${configPath}` };
  }
  const next = { ...existing, ...entry };
  if (existing && JSON.stringify(next) === JSON.stringify(existing)) return { status: "present", detail: `set up in ${configPath}` };
  config[key] = { ...config[key], codedroid: next };
  writeJson(configPath, config);
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

/** Writes through a symlinked config (dotfile managers) and keeps its mode, never half-written. */
function writeJson(file, value) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(tmp, target);
}
