/**
 * The answer-key parser and fetch, on synthetic tables and local git repos (no network, no third-party text).
 *
 * Run: node test/eval-key.test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as keyModule from "../eval/key.mjs";

const { buildKey, loadKey, parseKeyFile } = keyModule;
const KEY_SRC = fileURLToPath(new URL("../eval/key.mjs", import.meta.url));
const PARSER = crypto.createHash("sha256").update(fs.readFileSync(KEY_SRC)).digest("hex");
const CONFIG = JSON.parse(fs.readFileSync(new URL("../eval/config.json", import.meta.url), "utf8"));
const temps = [];
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
};
const failed = [];
const test = (name, fn) => {
  try {
    fn();
  } catch (e) {
    failed.push(name);
    console.error(`FAIL ${name}: ${String(e.message).split("\n")[0]}`);
  }
};
const parse = (lines, file = "F.md") => parseKeyFile(lines.join("\n"), file);
const fields = (rows) => rows.map((r) => [r.id, r.title, r.section, r.steps, r.expected]);

// git and fetch against a local upstream
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=eval@example.com", "-c", "user.name=eval", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const TABLE = "| Item | Steps | Expected |\n|---|---|---|\n";
function commit(repo, files) {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "c");
  return git(repo, "rev-parse", "HEAD");
}
/** A local upstream with `files` committed, and an eval folder holding key.mjs and a config pinned to it. */
function setup(files, root = tmpDir("eval-fetch-")) {
  const up = path.join(root, "up");
  fs.mkdirSync(up);
  git(up, "init", "-q", "-b", "main");
  const sha = commit(up, files);
  const ev = path.join(root, "ev");
  fs.mkdirSync(ev);
  fs.copyFileSync(KEY_SRC, path.join(ev, "key.mjs"));
  const config = { qaRepo: up, qaSha: sha, keyFiles: Object.keys(files) };
  writeConfig(ev, config);
  return { root, up, ev, sha, config };
}
const writeConfig = (ev, config) => fs.writeFileSync(path.join(ev, "config.json"), JSON.stringify(config));
const fetch = (ev, env = {}) => spawnSync(process.execPath, [path.join(ev, "key.mjs"), "fetch"], { cwd: ev, encoding: "utf8", env: { ...process.env, ...env } });
/** Another repository whose origin has a commit it has not fetched, so a `git fetch` in it would show. */
function otherRepo(root) {
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  commit(other, { README: "other\n" });
  const origin = path.join(root, "other-origin.git");
  git(root, "clone", "-q", "--bare", other, origin);
  const w = path.join(root, "other-work");
  git(root, "clone", "-q", origin, w);
  commit(w, { "n.txt": "n\n" });
  git(w, "push", "-q", "origin", "main");
  git(other, "remote", "add", "origin", origin);
  return other;
}
/** What a git command run in `repo` by mistake would change. */
const repoState = (repo) => ({
  remotes: git(repo, "for-each-ref", "refs/remotes"),
  fetchHead: fs.existsSync(path.join(repo, ".git", "FETCH_HEAD")),
  head: git(repo, "rev-parse", "HEAD"),
  branch: git(repo, "symbolic-ref", "HEAD"),
  status: git(repo, "status", "--porcelain"),
});
const readKey = (ev) => JSON.parse(fs.readFileSync(path.join(ev, ".cache", "key.json"), "utf8"));
/** A refusal: exit 1, one line on stderr, no stack trace, containing each of `parts`. */
function refused(r, ...parts) {
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stderr}`);
  assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  assert.ok(!/\n\s+at /.test(r.stderr), r.stderr);
  for (const p of parts) assert.ok(r.stderr.includes(p), `${p} in ${r.stderr}`);
}

try {
  test("parses rows, sections, <br> and pipes in code; a short row keeps its columns; ids number per file", () => {
    const rows = parse(
      [
        "| Item | Steps | Expected | Remark |",
        "| :--- | :---- | :------- | :----: |",
        "|**Widgets**|||||",
        "| Add one | 1. Tap `Add`<br>2. Type a name | Widget is listed | |",
        "| Pipe in code | 1. Run `a | b` | Output shown | |",
        "| Short row | 1. Tap `Go` | Done |",
        "|**Errors**|||||",
        "| Add one | 1. Go offline<br>2. Tap `Add` | Error `No connection` |",
      ],
      "Mobile/Android/Feature template/X/My File.md",
    );
    assert.deepEqual(rows.map((r) => r.id), ["K-my-file-1", "K-my-file-2", "K-my-file-3", "K-my-file-4"]);
    assert.equal(rows[0].section, "Widgets");
    assert.equal(rows[0].steps, "1. Tap `Add`\n2. Type a name");
    assert.equal(rows[1].steps, "1. Run `a | b`");
    assert.equal(rows[2].expected, "Done");
    assert.equal(rows[3].section, "Errors");
    assert.equal(rows[3].title, rows[0].title);
    assert.equal(rows[3].file, "Mobile/Android/Feature template/X/My File.md");
  });

  test("other header names, tables without an Expected column, section rows with text, numbering across tables", () => {
    const rows = parse(
      [
        "| Scenario | Actions | Expected outcome |",
        "| :--- | :--- | :--- |",
        "|**S1**| some text |||",
        "| One | Tap `Go` | Done |",
        "",
        "| Title | Status |",
        "| --- | --- |",
        "| Grid row | ok |",
        "",
        "| Name | Steps | Expected |",
        "|---|---|---|",
        "| Two | Tap | Shown |",
      ],
      "Z.md",
    );
    assert.deepEqual(fields(rows), [
      ["K-z-1", "One", "S1", "Tap `Go`", "Done"],
      ["K-z-2", "Two", "S1", "Tap", "Shown"],
    ]);
    assert.equal(parse(["| Title | Status |", "| --- | --- |", "| a | b |"], "Y.md").length, 0);
  });

  test("a line that is not a table row ends the table", () => {
    const rows = parse(["| Item | Steps | Expected |", "|---|---|---|", "| A | s | e |", "", "Loose text", "| stray | x | y |"]);
    assert.deepEqual(fields(rows), [["K-f-1", "A", "", "s", "e"]]);
  });

  test("a bold title with text in the Expected column is a case, not a section", () => {
    const rows = parse(["| Item | Steps | Expected |", "|---|---|---|", "|**Group**|||", "| **Bold case** | s | e |", "| Plain | s2 | e2 |"]);
    assert.deepEqual(fields(rows), [
      ["K-f-1", "**Bold case**", "Group", "s", "e"],
      ["K-f-2", "Plain", "Group", "s2", "e2"],
    ]);
  });

  test("a row without a trailing pipe keeps its last cell", () => {
    const rows = parse(["| Item | Steps | Expected |", "|---|---|---|", "| A | s | e", "| B | s2 | e2 |"]);
    assert.deepEqual(fields(rows), [
      ["K-f-1", "A", "", "s", "e"],
      ["K-f-2", "B", "", "s2", "e2"],
    ]);
  });

  test("the first Expected column is the one read", () => {
    const rows = parse(["| Item | Steps | Expected | Expected before |", "|---|---|---|---|", "| A | s | now | then |"]);
    assert.equal(rows[0].expected, "now");
  });

  test("only dashes and colons make an alignment row", () => {
    const rows = parse(["| Item | Steps | Expected |", "|---|---|---|", "| A | s | e |", "| : | : | : |", "| a-b | c-d | e-f |"]);
    assert.deepEqual(rows.map((r) => r.title), ["A", ":", "a-b"]);
  });

  test("a BOM, CRLF line ends and escaped pipes", () => {
    const md = "\uFEFF| Item | Steps | Expected |\r\n|---|---|---|\r\n| A | type a\\|b | shows `a\\|b` |\r\n| B | s | e |\r\n";
    assert.deepEqual(fields(parseKeyFile(md, "F.md")), [
      ["K-f-1", "A", "", "type a|b", "shows `a|b`"],
      ["K-f-2", "B", "", "s", "e"],
    ]);
  });

  test("buildKey: ids stay per file; two files giving the same id are refused, naming both", () => {
    const dir = tmpDir("eval-build-");
    const put = (f, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    };
    put("x/One.md", TABLE + "| a | s | e |\n| b | s | e |\n");
    put("y/Two.md", TABLE + "| c | s | e |\n");
    put("z/One.md", TABLE + "| d | s | e |\n");
    assert.deepEqual(buildKey(dir, ["x/One.md", "y/Two.md"]).map((r) => [r.id, r.file]), [
      ["K-one-1", "x/One.md"],
      ["K-one-2", "x/One.md"],
      ["K-two-1", "y/Two.md"],
    ]);
    assert.throws(
      () => buildKey(dir, ["x/One.md", "y/Two.md", "z/One.md"]),
      (e) => e.message.includes("K-one-1") && e.message.includes("x/One.md") && e.message.includes("z/One.md"),
    );
  });

  test("loadKey refuses a key built at another commit, from other files or by another parser", () => {
    const dir = tmpDir("eval-key-");
    const rows = [{ id: "K-a-1" }];
    const write = (over) => fs.writeFileSync(path.join(dir, "key.json"), JSON.stringify({ qaSha: CONFIG.qaSha, keyFiles: CONFIG.keyFiles, parser: PARSER, rows, ...over }));
    const stale = (over, ...parts) => {
      write(over);
      assert.throws(
        () => loadKey(dir),
        (e) => e.message.endsWith("run: node eval/key.mjs fetch") && parts.every((p) => e.message.includes(p)),
        JSON.stringify(over),
      );
    };
    stale({ qaSha: "deadbeef" }, "deadbeef", CONFIG.qaSha);
    stale({ keyFiles: CONFIG.keyFiles.slice(1) }, "keyFiles");
    stale({ keyFiles: [...CONFIG.keyFiles].reverse() }, "keyFiles");
    stale({ keyFiles: undefined }, "keyFiles");
    stale({ parser: "0".repeat(64) }, "parser");
    stale({ parser: undefined }, "parser");
    write({});
    assert.deepEqual(loadKey(dir), rows);
    fs.rmSync(path.join(dir, "key.json"));
    assert.throws(() => loadKey(dir), (e) => e.message.endsWith("run: node eval/key.mjs fetch"));
  });

  test("loadKey refuses a key.json that is not JSON or has no rows array, with the fetch hint", () => {
    const dir = tmpDir("eval-key-");
    const good = { qaSha: CONFIG.qaSha, keyFiles: CONFIG.keyFiles, parser: PARSER };
    for (const text of ["{bad", "", "null", "[]", "5", JSON.stringify(good), JSON.stringify({ ...good, rows: {} }), JSON.stringify({ ...good, rows: "x" })]) {
      fs.writeFileSync(path.join(dir, "key.json"), text);
      assert.throws(
        () => loadKey(dir),
        (e) => !(e instanceof SyntaxError) && !(e instanceof TypeError) && e.message.endsWith("; run: node eval/key.mjs fetch") && e.message.includes("key.json"),
        text,
      );
    }
  });

  test("fetch writes key.json with qaSha, keyFiles, parser and rows", () => {
    const { ev, sha, config } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    const r = fetch(ev);
    assert.equal(r.status, 0, r.stderr);
    const key = readKey(ev);
    assert.deepEqual(Object.keys(key), ["qaSha", "keyFiles", "parser", "rows"]);
    assert.equal(key.qaSha, sha);
    assert.deepEqual(key.keyFiles, config.keyFiles);
    assert.equal(key.parser, PARSER);
    assert.deepEqual(fields(key.rows), [["K-a-1", "a", "", "s", "e"]]);
    assert.deepEqual(fs.readdirSync(path.join(ev, ".cache")).sort(), ["QA", "key.json"]);
  });

  test("fetch after a pin bump fetches the new commit", () => {
    const { up, ev, config } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    assert.equal(fetch(ev).status, 0);
    const sha2 = commit(up, { "d/A.md": TABLE + "| a | s | e |\n| b | s | e |\n" });
    writeConfig(ev, { ...config, qaSha: sha2 });
    const r = fetch(ev);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readKey(ev).qaSha, sha2);
    assert.equal(readKey(ev).rows.length, 2);
  });

  test("fetch checks the config first", () => {
    const { ev, sha, config } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    for (const [over, part] of [
      [{ qaSha: "main" }, "qaSha"],
      [{ qaSha: sha.toUpperCase() }, "qaSha"],
      [{ qaSha: undefined }, "qaSha"],
      [{ keyFiles: [] }, "keyFiles"],
      [{ keyFiles: "d/A.md" }, "keyFiles"],
      [{ keyFiles: [1] }, "keyFiles"],
      [{ qaRepo: undefined }, "qaRepo"],
    ]) {
      writeConfig(ev, { ...config, ...over });
      refused(fetch(ev), part);
      assert.ok(!fs.existsSync(path.join(ev, ".cache", "QA")), JSON.stringify(over));
    }
  });

  test("a failed clone leaves no QA folder and no temp folder, and an old temp folder is removed", () => {
    const { root, ev, config } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    writeConfig(ev, { ...config, qaRepo: path.join(root, "no-such-repo") });
    refused(fetch(ev), "clone");
    assert.deepEqual(fs.readdirSync(path.join(ev, ".cache")), []);
    writeConfig(ev, config);
    fs.mkdirSync(path.join(ev, ".cache", "QA.tmp-1"));
    fs.writeFileSync(path.join(ev, ".cache", "QA.tmp-1", "junk"), "x");
    assert.equal(fetch(ev).status, 0);
    assert.deepEqual(fs.readdirSync(path.join(ev, ".cache")).sort(), ["QA", "key.json"]);
  });

  test("a half-made QA folder is reported as damaged and the enclosing repo is not touched", () => {
    for (const make of [(qa) => fs.mkdirSync(qa, { recursive: true }), (qa) => git(path.dirname(qa), "init", "-q", path.basename(qa))]) {
      const root = tmpDir("eval-fetch-");
      git(root, "init", "-q", "-b", "outer");
      fs.writeFileSync(path.join(root, "README"), "outer\n");
      git(root, "add", "README");
      git(root, "commit", "-qm", "outer");
      const { ev } = setup({ "d/A.md": TABLE + "| a | s | e |\n" }, root);
      const qa = path.join(ev, ".cache", "QA");
      fs.mkdirSync(path.dirname(qa), { recursive: true });
      make(qa);
      const before = [git(root, "rev-parse", "HEAD"), git(root, "symbolic-ref", "HEAD"), git(root, "status", "--porcelain")];
      refused(fetch(ev), "damaged", ".cache/QA");
      assert.deepEqual([git(root, "rev-parse", "HEAD"), git(root, "symbolic-ref", "HEAD"), git(root, "status", "--porcelain")], before);
      assert.ok(!fs.existsSync(path.join(ev, ".cache", "key.json")));
    }
  });

  test("a QA path that is a symlink or a file, or whose .git is a file, is damaged and git never runs in the other repository", () => {
    const links = [
      ["symlink", (qa, other) => fs.symlinkSync(other, qa)],
      ["gitfile", (qa, other) => {
        fs.mkdirSync(qa);
        fs.writeFileSync(path.join(qa, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
      }],
      ["file", (qa) => fs.writeFileSync(qa, "x")],
    ];
    for (const [how, make] of links) {
      const { root, ev } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
      const other = otherRepo(root);
      const qa = path.join(ev, ".cache", "QA");
      fs.mkdirSync(path.dirname(qa), { recursive: true });
      make(qa, other);
      const before = repoState(other);
      const r = fetch(ev);
      assert.equal(r.status, 1, `${how}: exit ${r.status}: ${r.stderr}`);
      refused(r, "damaged", ".cache/QA");
      assert.deepEqual(repoState(other), before, how);
      assert.ok(!fs.existsSync(path.join(ev, ".cache", "key.json")), how);
    }
  });

  test("GIT_DIR in the environment never sends git to another repository", () => {
    // no cache yet: the clone and checkout happen in the cache
    const fresh = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    const other1 = otherRepo(fresh.root);
    const before1 = repoState(other1);
    const r1 = fetch(fresh.ev, { GIT_DIR: path.join(other1, ".git") });
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(repoState(other1), before1);
    assert.deepEqual(fields(readKey(fresh.ev).rows), [["K-a-1", "a", "", "s", "e"]]);

    // a healthy cache that must fetch a new pin: the fetch runs in the cache
    const { root, up, ev, config } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    assert.equal(fetch(ev).status, 0);
    const sha2 = commit(up, { "d/A.md": TABLE + "| a | s | e |\n| b | s | e |\n" });
    writeConfig(ev, { ...config, qaSha: sha2 });
    const other = otherRepo(root);
    const before = repoState(other);
    const r = fetch(ev, { GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, ".git", "index") });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(repoState(other), before);
    assert.equal(readKey(ev).qaSha, sha2);
    assert.equal(readKey(ev).rows.length, 2);
  });

  test("a keyFiles entry outside the clone is refused, naming it, before anything is read", () => {
    const { root, ev, config } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    fs.writeFileSync(path.join(root, "outside.md"), TABLE + "| x | s | e |\n");
    for (const entry of ["../../../outside.md", "../QA-sibling/A.md", "..", path.join(root, "outside.md"), "d/../../x.md"]) {
      writeConfig(ev, { ...config, keyFiles: ["d/A.md", entry] });
      refused(fetch(ev), entry);
      assert.ok(!fs.existsSync(path.join(ev, ".cache", "QA")), entry);
      assert.ok(!fs.existsSync(path.join(ev, ".cache", "key.json")), entry);
    }
    writeConfig(ev, { ...config, keyFiles: ["d/./A.md"] });
    assert.equal(fetch(ev).status, 0);
  });

  test("a refused fetch leaves no older key.json behind", () => {
    const { ev, config } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    assert.equal(fetch(ev).status, 0);
    const key = path.join(ev, ".cache", "key.json");
    for (const over of [{ qaSha: "main" }, { keyFiles: ["d/A.md", "d/Nope.md"] }, { qaSha: "0123456789abcdef0123456789abcdef01234567" }]) {
      fs.writeFileSync(key, "{}");
      writeConfig(ev, { ...config, ...over });
      assert.equal(fetch(ev).status, 1, JSON.stringify(over));
      assert.ok(!fs.existsSync(key), JSON.stringify(over));
    }
    writeConfig(ev, config);
    assert.equal(fetch(ev).status, 0);
    assert.deepEqual(fs.readdirSync(path.join(ev, ".cache")).sort(), ["QA", "key.json"]);
  });

  test("fetch refuses local changes in the QA folder", () => {
    const { ev } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    assert.equal(fetch(ev).status, 0);
    fs.appendFileSync(path.join(ev, ".cache", "QA", "d", "A.md"), "| local | s | e |\n");
    refused(fetch(ev), "local changes");
  });

  test("fetch refuses a pinned commit the upstream does not have, and a missing key file", () => {
    const { ev, config } = setup({ "d/A.md": TABLE + "| a | s | e |\n" });
    const absent = "0123456789abcdef0123456789abcdef01234567";
    writeConfig(ev, { ...config, qaSha: absent });
    refused(fetch(ev), absent);
    writeConfig(ev, { ...config, keyFiles: ["d/A.md", "d/Nope.md"] });
    refused(fetch(ev), "d/Nope.md");
  });

  test("fetch refuses two key files that give the same ids", () => {
    const { ev } = setup({ "a/Same.md": TABLE + "| a | s | e |\n", "b/Same.md": TABLE + "| b | s | e |\n" });
    refused(fetch(ev), "a/Same.md", "b/Same.md");
    assert.ok(!fs.existsSync(path.join(ev, ".cache", "key.json")));
  });

  test("CLI: usage exits 2; importing key.mjs when argv[1] is not a file does not throw", () => {
    const usage = spawnSync(process.execPath, [KEY_SRC], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.ok(usage.stderr.includes("usage"), usage.stderr);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../eval/key.mjs", import.meta.url).href)})`, "not-a-file"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });
} finally {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
}

if (failed.length) {
  console.error(`eval-key: ${failed.length} failed`);
  process.exit(1);
}
console.log("eval-key: ok");
