#!/usr/bin/env node
/**
 * Sets the release version everywhere it is named: package.json and its lock, src/version.js, the
 * Claude, Codex and Antigravity plugin manifests, server.json (twice), the GitHub Action's default
 * version, and claude-plugin/ through sync-claude-plugin.mjs. test/package.test.mjs fails while any of them disagrees.
 *
 * Run: node scripts/set-version.mjs <x.y.z>, then open a pull request; merging it releases
 * (.github/workflows/release.yml).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: node scripts/set-version.mjs <x.y.z>");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (file) => path.join(root, file);

execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: root, stdio: "inherit" });
fs.writeFileSync(at("src/version.js"), fs.readFileSync(at("src/version.js"), "utf8").replace(/VERSION = "[^"]+"/, `VERSION = "${version}"`));
for (const file of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".antigravity-plugin/plugin.json"]) {
  const json = JSON.parse(fs.readFileSync(at(file), "utf8"));
  json.version = version;
  fs.writeFileSync(at(file), `${JSON.stringify(json, null, 2)}\n`);
}
const server = JSON.parse(fs.readFileSync(at("server.json"), "utf8"));
server.version = version;
for (const pkg of server.packages) pkg.version = version;
fs.writeFileSync(at("server.json"), `${JSON.stringify(server, null, 2)}\n`);
fs.writeFileSync(at("action/action.yml"), fs.readFileSync(at("action/action.yml"), "utf8").replace(/(\n  version:\n(?:    .*\n)*?    default: )"[^"]+"/, `$1"${version}"`));
execFileSync(process.execPath, [at("scripts/sync-claude-plugin.mjs")], { stdio: "inherit" });
console.log(`Set ${version}. Run npm test, commit, and open a pull request: merging it releases.`);
