/**
 * The agent skills that ship with this package: `codedroid-phone` (driving the phone through
 * CodeDroid), `test-on-device` (the developer loop: build, install, drive, check, report), and
 * `app-e2e` with its five steps (explore, test PRD, CUJs, test cases, run and report: an app tested
 * end to end, its documents in the app's repo under e2e/), and the everyday jobs on those files:
 * `app-e2e-rerun` (some cases), `app-e2e-bug` (a case for a bug), `app-e2e-maintain` (keeping them current).
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

export const SKILLS = [
  "codedroid-phone",
  "test-on-device",
  "app-e2e",
  "app-e2e-explore",
  "app-e2e-prd",
  "app-e2e-cujs",
  "app-e2e-testcases",
  "app-e2e-run",
  "app-e2e-rerun",
  "app-e2e-bug",
  "app-e2e-maintain",
];

/** Skills earlier releases shipped and this one does not: an install removes its own old copies. */
export const RETIRED_SKILLS = ["create-cujs", "create-tests"];

export const SKILLS_SOURCE = fileURLToPath(new URL("../skills/", import.meta.url));

export function skillSource(name) {
  return path.join(SKILLS_SOURCE, name, "SKILL.md");
}

export function defaultSkillsDir({ codex = false } = {}) {
  return codex ? path.join(os.homedir(), ".codex", "skills") : path.join(os.homedir(), ".claude", "skills");
}

/**
 * Copies every skill to <dir>/<name>/SKILL.md, overwriting older copies, and removes the retired
 * ones this package installed (a same-named skill of the user's own stays); returns the written paths.
 */
export function installSkills({ dir = defaultSkillsDir() } = {}) {
  for (const name of RETIRED_SKILLS) {
    const file = path.join(dir, name, "SKILL.md");
    // Ours: every skill this package ships carries its don't-force-stop-CodeDroid rule.
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("com.codedroid.agent")) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
  return SKILLS.map((name) => {
    const target = path.join(dir, name, "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(skillSource(name), target);
    return target;
  });
}
