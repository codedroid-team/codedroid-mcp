/**
 * The answer-key parser, on a synthetic table (no network, no third-party text).
 *
 * Run: node test/eval-key.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKey, parseKeyFile } from "../eval/key.mjs";

const md = [
  "| Test Case | Steps | Expected | Result | Related Comment / Defect |",
  "| :-------- | :---- | :------- | :----: | :----------------------- |",
  "|**Widgets**||||||",
  "| Add one | 1. Tap `Add`<br>2. Type a name | Widget is listed | | |",
  "| Pipe in code | 1. Run `a | b` | Output shown | | |",
  "| Short row | 1. Tap `Go` | Done |",
  "|**Errors**||||||",
  "| Add one | 1. Go offline<br>2. Tap `Add` | Error `No connection` |",
].join("\n");
const rows = parseKeyFile(md, "Mobile/Android/Feature template/X/My File.md");
assert.equal(rows.length, 4);
assert.deepEqual(rows.map((r) => r.id), ["K-my-file-1", "K-my-file-2", "K-my-file-3", "K-my-file-4"]);
assert.equal(rows[0].section, "Widgets");
assert.equal(rows[0].steps, "1. Tap `Add`\n2. Type a name");
assert.equal(rows[1].steps, "1. Run `a | b`");
assert.equal(rows[2].expected, "Done"); // short row keeps its columns
assert.equal(rows[3].section, "Errors"); // same title, different id
assert.equal(rows[3].title, rows[0].title);
assert.equal(rows[3].file, "Mobile/Android/Feature template/X/My File.md");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-key-"));
fs.writeFileSync(path.join(dir, "key.json"), JSON.stringify({ qaSha: "deadbeef", rows: [] }));
const pinned = JSON.parse(fs.readFileSync(new URL("../eval/config.json", import.meta.url), "utf8")).qaSha;
assert.throws(() => loadKey(dir), (e) => e.message.includes("deadbeef") && e.message.includes(pinned));
fs.writeFileSync(path.join(dir, "key.json"), JSON.stringify({ qaSha: pinned, rows: rows }));
assert.equal(loadKey(dir).length, 4);

console.log("eval-key: ok");
