/**
 * The answer key: a human-written test suite (public owncloud/QA, pinned commit) parsed into rows.
 * The fetched text stays under eval/.cache/ (gitignored); none of it is committed.
 *
 * Run: node eval/key.mjs fetch
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));

/** Split a table line on `|` outside backticks, dropping the outer pipes. */
function splitCells(line) {
  const cells = [];
  let cur = "";
  let inCode = false;
  for (const ch of line.trim()) {
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  cells.shift(); // text before the leading pipe
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop(); // after the trailing pipe
  return cells.map((c) => c.trim().replace(/<br\s*\/?>/gi, "\n"));
}

export function parseKeyFile(markdown, file) {
  const stem = path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const rows = [];
  let section = "";
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const [title = "", steps = "", expected = "", ...rest] = splitCells(line);
    if (title === "Test Case") continue;
    if (/^[:\-\s]*$/.test(title) && [steps, expected, ...rest].every((c) => /^[:\-\s]*$/.test(c))) continue;
    const name = title.match(/^\*\*(.+)\*\*$/);
    if (name && [steps, expected, ...rest].every((c) => c === "")) {
      section = name[1];
      continue;
    }
    rows.push({ id: `K-${stem}-${rows.length + 1}`, file, section, title, steps, expected });
  }
  return rows;
}

export function loadKey(cacheDir) {
  const key = JSON.parse(fs.readFileSync(path.join(cacheDir, "key.json"), "utf8"));
  if (key.qaSha !== config.qaSha) {
    throw new Error(`answer key is at ${key.qaSha} but config pins ${config.qaSha}; run: node eval/key.mjs fetch`);
  }
  return key.rows;
}

function fetchKey() {
  const cache = path.join(here, ".cache");
  const qa = path.join(cache, "QA");
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(qa)) execFileSync("git", ["clone", "--quiet", config.qaRepo, qa], { stdio: "inherit" });
  execFileSync("git", ["-C", qa, "checkout", "--quiet", config.qaSha], { stdio: "inherit" });
  const missing = config.keyFiles.filter((f) => !fs.existsSync(path.join(qa, f)));
  if (missing.length) {
    console.error(`missing key files:\n${missing.join("\n")}`);
    process.exit(1);
  }
  const rows = [];
  for (const f of config.keyFiles) {
    const parsed = parseKeyFile(fs.readFileSync(path.join(qa, f), "utf8"), f);
    console.log(`${parsed.length}\t${f}`);
    rows.push(...parsed);
  }
  fs.writeFileSync(path.join(cache, "key.json"), JSON.stringify({ qaSha: config.qaSha, rows }, null, 2));
  console.log(`${rows.length}\ttotal`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "fetch") fetchKey();
  else {
    console.error("usage: node eval/key.mjs fetch");
    process.exit(2);
  }
}
