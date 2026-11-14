/**
 * claude-plugin/, what the Claude plugin directory lists: the same skills as skills/, the same
 * version as the package, a remote MCP server and nothing that runs on the user's computer, in
 * the file types the directory accepts from anyone (text, SVG, PNG, JPEG, GIF, WebP, fonts).
 *
 * Run: node test/claude-plugin.test.mjs (after node scripts/sync-claude-plugin.mjs)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILLS } from "../src/skill.js";
import { VERSION } from "../src/version.js";

const root = new URL("../", import.meta.url);
const plugin = new URL("../claude-plugin/", import.meta.url);
const read = (url) => fs.readFileSync(url, "utf8");
// Gitignored files the OS leaves in folders; never committed, so never listed.
const OS_JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const files = (dir) =>
  fs.readdirSync(dir, { recursive: true }).filter((f) => !OS_JUNK.has(path.basename(f)) && !fs.statSync(new URL(f, dir)).isDirectory());

const manifest = JSON.parse(read(new URL(".claude-plugin/plugin.json", plugin)));
assert.equal(manifest.name, "codedroid");
assert.equal(manifest.version, VERSION, "claude-plugin/ and package.json: run scripts/sync-claude-plugin.mjs");
const local = JSON.parse(read(new URL(".claude-plugin/plugin.json", root)));
for (const field of ["displayName", "author", "homepage", "repository", "license", "icon", "privacyPolicyUrl"]) {
  assert.deepEqual(manifest[field], local[field], `${field}: the two plugins say the same`);
}
// The portal warns on fields the plugins reference does not list; the listing form takes these.
// displayName it warns on too, yet reads for the listing's name.
for (const field of ["documentationUrl", "supportUrl", "termsOfServiceUrl"]) {
  assert.ok(!(field in manifest), `${field}: not a field the directory recognizes in plugin.json`);
}
assert.ok(fs.existsSync(new URL(manifest.icon, plugin)), "the icon the manifest names is in the folder");

const mcp = JSON.parse(read(new URL(".mcp.json", plugin)));
assert.deepEqual(Object.keys(mcp.mcpServers), ["codedroid"]);
const server = mcp.mcpServers.codedroid;
assert.equal(server.type, "http");
assert.match(server.url, /^https:\/\/[a-z0-9.-]+\.codedroid\.com\/mcp$/, "a remote server, over https");
assert.ok(!("command" in server), "nothing runs on the user's computer");
assert.ok(!("headers" in server), "no credential travels in headers: the server's OAuth signs the user in");

// The same skills, byte for byte.
for (const name of SKILLS) {
  const dir = new URL(`skills/${name}/`, root);
  for (const file of files(dir)) {
    const source = new URL(file, dir);
    assert.equal(read(new URL(`skills/${name}/${file}`, plugin)), read(source), `claude-plugin/skills/${name}/${file} differs: run scripts/sync-claude-plugin.mjs`);
  }
}
const shipped = fs.readdirSync(new URL("skills/", plugin)).filter((f) => !OS_JUNK.has(f));
assert.deepEqual([...shipped].sort(), [...SKILLS].sort(), "claude-plugin/skills/ and SKILLS differ");
assert.equal(read(new URL("LICENSE", plugin)), read(new URL("LICENSE", root)));
assert.ok(fs.readFileSync(new URL("assets/icon.png", plugin)).equals(fs.readFileSync(new URL("assets/icon.png", root))));

// A README of 40 words or more, and only files the directory accepts from any organization.
assert.ok(read(new URL("README.md", plugin)).split(/\s+/).length >= 40);
const allowed = /\.(md|json|yaml|yml|txt|svg|png|jpe?g|gif|webp|woff2?|ttf|otf)$|^LICENSE$/i;
const refused = new Set(["package.json", "package-lock.json", "pnpm-workspace.yaml", ".npmrc"]);
for (const file of files(plugin)) {
  const base = path.basename(file);
  assert.ok(allowed.test(base), `claude-plugin/${file}: not a file type the directory accepts`);
  assert.ok(!refused.has(base), `claude-plugin/${file}: a dependency install, accepted only from Verified organizations`);
  if (!/\.png$/.test(base)) assert.ok(!read(new URL(file, plugin)).startsWith("#!"), `claude-plugin/${file}: a script`);
}

console.log("claude-plugin.test.mjs: ALL PASS");
