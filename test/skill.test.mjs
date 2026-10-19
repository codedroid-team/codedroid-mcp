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
import { installSkills, SKILLS, skillSource } from "../src/skill.js";
import { createStatusTool } from "../src/status-tool.js";

const phone = JSON.parse(fs.readFileSync(new URL("./fixtures/phone-tools.json", import.meta.url), "utf8")).tools;
const local = [createAdbTool({ env: {} }).definition, createStatusTool({}).definition];
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
  assert.match(source, /com\.codedroid\.app/, `${name}: carries the don't-force-stop-CodeDroid rule`);
}

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

console.log("skill.test.mjs: ALL PASS");
