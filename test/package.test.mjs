/**
 * What npm and the plugin ship agree: one version, the bin, the skills, the MCP config.
 *
 * Run: node test/package.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { SKILLS } from "../src/skill.js";
import { VERSION } from "../src/version.js";

const read = (path) => JSON.parse(fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
const mcp = read(".mcp.json");
const gemini = read("gemini-extension.json");
const codex = read(".codex-plugin/plugin.json");
const marketplace = read(".agents/plugins/marketplace.json");
const server = read("server.json");

assert.equal(pkg.version, VERSION, "src/version.js and package.json");
assert.equal(plugin.version, VERSION, "the plugin and package.json");
assert.ok(fs.existsSync(new URL(`../${pkg.bin["codedroid-mcp"]}`, import.meta.url)));
assert.match(fs.readFileSync(new URL(`../${pkg.bin["codedroid-mcp"]}`, import.meta.url), "utf8"), /^#!\/usr\/bin\/env node\n/);
for (const path of ["src", "skills", ".claude-plugin", ".mcp.json", "README.md"]) assert.ok(pkg.files.includes(path), `npm ships ${path}`);
for (const name of SKILLS) assert.ok(fs.existsSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url)), name);
assert.deepEqual(
  mcp.mcpServers.codedroid.args.slice(-1),
  [`${pkg.name}@${pkg.version}`],
  "the plugin pins this package to the released version — bump .mcp.json and gemini-extension.json on release",
);

assert.equal(gemini.version, VERSION, "the Gemini extension and package.json");
assert.deepEqual(gemini.mcpServers, mcp.mcpServers, "Gemini and Claude launch the same MCP server");
assert.ok(pkg.files.includes("gemini-extension.json"), "npm ships the Gemini extension manifest");

assert.equal(codex.version, VERSION, "the Codex plugin and package.json");
assert.equal(codex.skills, "./skills/");
assert.equal(codex.mcpServers, "./.mcp.json");
assert.equal(marketplace.plugins[0].name, codex.name);
assert.equal(marketplace.plugins[0].source.path, "./", "Codex installs the repository root");
for (const file of [".codex-plugin", ".agents/plugins/marketplace.json"]) assert.ok(pkg.files.includes(file));

// The MCP Registry checks that the npm release it points at declares the same mcpName.
assert.equal(server.name, pkg.mcpName, "server.json and package.json mcpName");
assert.equal(server.version, VERSION, "server.json and package.json");
assert.deepEqual(
  server.packages.map((p) => [p.identifier, p.version]),
  [[pkg.name, VERSION]],
  "server.json points at this npm release",
);
assert.ok(server.description.length <= 100, "the MCP Registry caps descriptions at 100 characters");

for (const icon of [plugin.icon, codex.interface.composerIcon, codex.interface.logo]) {
  assert.ok(fs.existsSync(new URL(`../${icon}`, import.meta.url)), icon);
}
assert.ok(pkg.files.includes("assets"), "npm ships the plugin icon");

console.log("package.test.mjs: ALL PASS");
