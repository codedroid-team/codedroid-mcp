/**
 * The agent skills that ship with this package: `codedroid-phone` (driving the phone through
 * CodeDroid) and `test-on-device` (the developer loop: build, install, drive, check, report).
 *
 * - The Claude Code plugin (plugin/claude) carries them already; `skill install` is for using the
 *   MCP server without the plugin: Claude Code (~/.claude/skills), Codex (--codex: ~/.codex/skills),
 *   or any directory (--dir).
 * - Change together: the skills name tools, so a renamed tool means editing them
 *   (test/skill.test.mjs checks every name they use exists).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export const SKILLS = ["codedroid-phone", "test-on-device"];

export const SKILLS_SOURCE = fileURLToPath(new URL("../skills/", import.meta.url));

export function skillSource(name) {
  return path.join(SKILLS_SOURCE, name, "SKILL.md");
}

export function defaultSkillsDir({ codex = false } = {}) {
  return codex ? path.join(os.homedir(), ".codex", "skills") : path.join(os.homedir(), ".claude", "skills");
}

/** Copies every skill to <dir>/<name>/SKILL.md, overwriting older copies; returns the written paths. */
export function installSkills({ dir = defaultSkillsDir() } = {}) {
  return SKILLS.map((name) => {
    const target = path.join(dir, name, "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(skillSource(name), target);
    return target;
  });
}
