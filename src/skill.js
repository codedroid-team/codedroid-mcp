/**
 * The agent skills that ship with this package: `codedroid-phone` (driving the phone through
 * CodeDroid), `test-on-device` (the developer loop: build, install, drive, check, report), and
 * `app-e2e` with its steps (explore, test PRD, CUJs, test cases, `app-e2e-verify` judging each case's
 * design, run and report: an app tested end to end, its documents in the app's repo under e2e/), and
 * the everyday jobs on those files:
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
  "app-e2e-verify",
  "app-e2e-run",
  "app-e2e-rerun",
  "app-e2e-bug",
  "app-e2e-maintain",
];

/** Skills earlier releases shipped and this one does not: an install removes its own old copies. */
export const RETIRED_SKILLS = ["create-cujs", "create-tests"];

/**
 * Ours: every skill this package shipped carries its don't-force-stop-CodeDroid rule, naming the
 * app com.codedroid.app before 0.1.5 and com.codedroid.agent since.
 */
const OURS = /com\.codedroid\.(app|agent)\b/;

export const SKILLS_SOURCE = fileURLToPath(new URL("../skills/", import.meta.url));

export function skillSource(name) {
  return path.join(SKILLS_SOURCE, name, "SKILL.md");
}

export function defaultSkillsDir({ codex = false, home = os.homedir() } = {}) {
  return codex ? path.join(home, ".codex", "skills") : path.join(home, ".claude", "skills");
}

const readOrNull = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    return null;
  }
};

/**
 * Brings a `skill install` directory up to this release: when it holds any skill of ours and one is
 * missing, differs, or is retired, every skill is written again. Returns the written paths, [] when
 * nothing was stale, or null when none of ours is there (never installed, or all the user's own).
 */
export function refreshSkills({ dir = defaultSkillsDir() } = {}) {
  const current = (name) => readOrNull(path.join(dir, name, "SKILL.md"));
  const ours = SKILLS.filter((name) => OURS.test(current(name) ?? ""));
  if (!ours.length) return null;
  const stale =
    SKILLS.some((name) => current(name) !== fs.readFileSync(skillSource(name), "utf8")) ||
    RETIRED_SKILLS.some((name) => OURS.test(current(name) ?? ""));
  return stale ? installSkills({ dir }) : [];
}

/**
 * Copies every skill to <dir>/<name>/SKILL.md, overwriting older copies, and removes the SKILL.md of
 * each retired one this package installed (a same-named skill of the user's own, and any other file in
 * its folder, stays); returns the written paths.
 */
export function installSkills({ dir = defaultSkillsDir() } = {}) {
  for (const name of RETIRED_SKILLS) {
    const file = path.join(dir, name, "SKILL.md");
    if (OURS.test(readOrNull(file) ?? "")) {
      fs.rmSync(file);
      // Only the file it wrote: anything else the user keeps there stays, and so does the folder.
      if (fs.readdirSync(path.dirname(file)).length === 0) fs.rmdirSync(path.dirname(file));
    }
  }
  return SKILLS.map((name) => {
    const target = path.join(dir, name, "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(skillSource(name), target);
    return target;
  });
}
