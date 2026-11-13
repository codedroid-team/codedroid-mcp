#!/usr/bin/env node
/**
 * Brings claude-plugin/ in line with the package: the skills, the license, the icon and the version.
 *
 * claude-plugin/ is what the Claude plugin directory lists (see docs/reference.md): the skills and
 * a remote MCP server, with nothing that runs on the user's computer. The skills are the same
 * files as skills/; this copies them, so edit skills/ and run this. test/claude-plugin.test.mjs
 * fails until it has been run.
 *
 * Run: node scripts/sync-claude-plugin.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS } from "../src/skill.js";
import { VERSION } from "../src/version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "claude-plugin");

fs.rmSync(path.join(plugin, "skills"), { recursive: true, force: true });
for (const name of SKILLS) {
  fs.cpSync(path.join(root, "skills", name), path.join(plugin, "skills", name), { recursive: true });
}
fs.copyFileSync(path.join(root, "LICENSE"), path.join(plugin, "LICENSE"));
fs.mkdirSync(path.join(plugin, "assets"), { recursive: true });
fs.copyFileSync(path.join(root, "assets", "icon.png"), path.join(plugin, "assets", "icon.png"));

const manifest = path.join(plugin, ".claude-plugin", "plugin.json");
const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
json.version = VERSION;
fs.writeFileSync(manifest, `${JSON.stringify(json, null, 2)}\n`);
console.log(`claude-plugin/ at ${VERSION}: ${SKILLS.length} skills, LICENSE, icon`);
