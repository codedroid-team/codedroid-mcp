/**
 * The shipped skills: loadable SKILL.md files that name only tools that exist, and install copies them.
 *
 * The phone's tools come from test/fixtures/phone-tools.json, its tools/list as the app's JVM test
 * (McpToolsTest.exportsTheToolsForTheBridge) writes it, so a tool renamed on the phone fails here.
 *
 * Run: node test/skill.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdbTool } from "../src/adb-tool.js";
import { createInstallTool } from "../src/install-tool.js";
import { createSetupPhoneTool } from "../src/phone-setup.js";
import { installSkills, SKILLS, SKILLS_SOURCE, skillSource } from "../src/skill.js";
import { createDevicesTool, createStatusTool } from "../src/status-tool.js";

const phone = JSON.parse(fs.readFileSync(new URL("./fixtures/phone-tools.json", import.meta.url), "utf8")).tools;
const local = [createAdbTool({ env: {} }).definition, createDevicesTool({}).definition, createStatusTool({}).definition, createInstallTool({}).definition, createSetupPhoneTool().definition];
const tools = new Set([...phone, ...local].map((t) => t.name));
const params = new Set([...phone, ...local].flatMap((t) => Object.keys(t.inputSchema.properties ?? {})));
// What the phone's replies carry: error codes and the `after` observation.
const replyWords = new Set(["stale_node", "not_found", "needs_setup", "bad_args", "screen_changed"]);

for (const name of SKILLS) {
  const source = fs.readFileSync(skillSource(name), "utf8");
  const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(front, `${name}: SKILL.md must open with YAML frontmatter`);
  assert.match(front[1], new RegExp(`^name: ${name}$`, "m"));
  assert.match(front[1], /^description: .{80,1024}$/m, `${name}: the description says when to load it`);

  // A code span that reads like a tool or parameter name must be a real one.
  for (const [, span] of source.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    assert.ok(tools.has(span) || params.has(span) || replyWords.has(span), `${name}: \`${span}\` is not a tool, a parameter or a reply field`);
  }
  assert.match(source, /com\.codedroid\.agent/, `${name}: carries the don't-force-stop-CodeDroid rule`);
}

// Every skill in skills/ is in SKILLS, so `skill install` copies it too.
const shipped = fs.readdirSync(SKILLS_SOURCE).filter((d) => fs.existsSync(skillSource(d)));
assert.deepEqual([...shipped].sort(), [...SKILLS].sort(), "skills/ and SKILLS in src/skill.js differ");

// The driving skill covers every tool there is.
const driving = fs.readFileSync(skillSource("codedroid-phone"), "utf8");
for (const tool of tools) assert.ok(driving.includes(`\`${tool}\``), `codedroid-phone does not mention \`${tool}\``);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-skill-"));
try {
  const written = installSkills({ dir });
  assert.deepEqual(written, SKILLS.map((name) => path.join(dir, name, "SKILL.md")));
  for (const [i, name] of SKILLS.entries()) assert.equal(fs.readFileSync(written[i], "utf8"), fs.readFileSync(skillSource(name), "utf8"));
  installSkills({ dir }); // reinstall over an existing copy
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// An upgrade's install removes the skills a release retired, when they are this package's own copies:
// left behind, an old create-cujs would still load and point agents at steps that are gone.
const upgraded = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-skill-upgrade-"));
try {
  const seed = (name, body) => {
    fs.mkdirSync(path.join(upgraded, name), { recursive: true });
    fs.writeFileSync(path.join(upgraded, name, "SKILL.md"), body);
  };
  seed("create-cujs", "---\nname: create-cujs\ndescription: old\n---\nNever force-stop com.codedroid.agent.\n");
  fs.writeFileSync(path.join(upgraded, "create-cujs", "notes.md"), "the user's own file");
  seed("my-skill", "---\nname: my-skill\ndescription: unrelated\n---\ncom.codedroid.agent\n");
  installSkills({ dir: upgraded });
  assert.ok(!fs.existsSync(path.join(upgraded, "create-cujs", "SKILL.md")), "a retired skill of ours is removed");
  assert.ok(fs.existsSync(path.join(upgraded, "create-cujs", "notes.md")), "a file the package did not write stays");
  assert.ok(fs.existsSync(path.join(upgraded, "my-skill", "SKILL.md")), "other skills stay");
  for (const name of SKILLS) assert.ok(fs.existsSync(path.join(upgraded, name, "SKILL.md")), name);
} finally {
  fs.rmSync(upgraded, { recursive: true, force: true });
}

// Releases before 0.1.5 named the app com.codedroid.app; their copies are ours too, and a retired
// skill's folder with nothing else in it goes with its file.
const older = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-skill-0.1.4-"));
try {
  for (const name of ["create-cujs", "create-tests"]) {
    fs.mkdirSync(path.join(older, name));
    fs.writeFileSync(path.join(older, name, "SKILL.md"), `---\nname: ${name}\ndescription: old\n---\nNever force-stop com.codedroid.app.\n`);
  }
  fs.mkdirSync(path.join(older, "create-tests-mine"));
  fs.writeFileSync(path.join(older, "create-tests-mine", "SKILL.md"), "---\nname: create-tests-mine\ndescription: mine\n---\nNothing of CodeDroid's.\n");
  installSkills({ dir: older });
  assert.deepEqual(fs.readdirSync(older).filter((d) => d.startsWith("create-")), ["create-tests-mine"], "0.1.4's retired skills are removed, folders and all");
} finally {
  fs.rmSync(older, { recursive: true, force: true });
}

// A same-named skill that is not ours stays.
const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-skill-foreign-"));
try {
  fs.mkdirSync(path.join(foreign, "create-tests"));
  fs.writeFileSync(path.join(foreign, "create-tests", "SKILL.md"), "---\nname: create-tests\ndescription: the user's own\n---\nNothing of CodeDroid's.\n");
  installSkills({ dir: foreign });
  assert.ok(fs.existsSync(path.join(foreign, "create-tests", "SKILL.md")), "a same-named skill that is not ours stays");
} finally {
  fs.rmSync(foreign, { recursive: true, force: true });
}

console.log("skill.test.mjs: ALL PASS");
