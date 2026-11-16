/**
 * The answer key: a human-written test suite (public owncloud/QA, pinned commit) parsed into rows.
 * The fetched text stays under eval/.cache/ (gitignored); none of it is committed.
 *
 * Run: node eval/key.mjs fetch
 *   clones qaRepo into eval/.cache/QA (or reuses it), checks out qaSha and writes eval/.cache/key.json.
 *   An existing key.json is removed first, so a refused fetch leaves none.
 *   Exit codes: 0 done; 1 refused (bad config, damaged or changed cache, git error; one line says what); 2 usage error.
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const config = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));
/** sha256 of this file: a key.json written by another version of the parser is refused. */
export const PARSER = crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");

/** Split a table line on `|` outside backticks, dropping the outer pipes; `\|` is a literal pipe. */
function splitCells(line) {
  const cells = [];
  let cur = "";
  let inCode = false;
  const text = line.trim();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
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

const isAlign = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c) || c === "");

export function parseKeyFile(markdown, file) {
  const stem = path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const rows = [];
  let section = "";
  let table = null; // { exp, steps } for a table that has an Expected column
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("|")) {
      table = null;
      continue;
    }
    const cells = splitCells(lines[i]);
    const next = lines[i + 1]?.startsWith("|") ? splitCells(lines[i + 1]) : null;
    if (next && isAlign(next) && next.some((c) => c !== "")) {
      // the line before an alignment row is that table's header, never a case
      const exp = cells.findIndex((c) => /expected/i.test(c));
      const steps = cells.findIndex((c) => /steps/i.test(c));
      table = exp < 0 ? null : { exp, steps: steps < 0 ? 1 : steps };
      continue;
    }
    if (isAlign(cells) && cells.some((c) => c !== "")) continue;
    if (!table) continue;
    const title = cells[0] ?? "";
    const name = title.match(/^\*\*(.+)\*\*$/);
    if (name && cells.slice(table.exp).every((c) => c === "")) {
      section = name[1];
      continue;
    }
    rows.push({ id: `K-${stem}-${rows.length + 1}`, file, section, title, steps: cells[table.steps] ?? "", expected: cells[table.exp] ?? "" });
  }
  return rows;
}

/** Rows of every key file, in order; two files giving the same id are refused. */
export function buildKey(qaDir, keyFiles) {
  const rows = [];
  const from = new Map();
  for (const f of keyFiles) {
    for (const row of parseKeyFile(fs.readFileSync(path.join(qaDir, f), "utf8"), f)) {
      if (from.has(row.id)) throw new Error(`key id ${row.id} comes from both ${from.get(row.id)} and ${f}`);
      from.set(row.id, f);
      rows.push(row);
    }
  }
  return rows;
}

export function loadKey(cacheDir) {
  const file = path.join(cacheDir, "key.json");
  const stale = (why) => new Error(`${why}; run: node eval/key.mjs fetch`);
  if (!fs.existsSync(file)) throw stale(`no answer key at ${file}`);
  let key;
  try {
    key = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw stale(`the answer key at ${file} is not valid JSON`);
  }
  if (!Array.isArray(key?.rows)) throw stale(`the answer key at ${file} has no rows`);
  if (key.qaSha !== config.qaSha) throw stale(`answer key is at ${key.qaSha} but config pins ${config.qaSha}`);
  if (JSON.stringify(key.keyFiles) !== JSON.stringify(config.keyFiles)) throw stale("answer key was built from other keyFiles than config.json lists");
  if (key.parser !== PARSER) throw stale("answer key was built by another parser (key.mjs changed since the fetch)");
  return key.rows;
}

/** The environment for git, without the variables that would point it at another repository. */
function gitEnv() {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) delete env[k];
  return env;
}

/** Runs git; a failure becomes one line: the command and git's first line of complaint. */
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() }).trim();
  } catch (e) {
    const why = String(e.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? e.message;
    throw new Error(`git ${args.join(" ")}: ${why}`);
  }
}
const gitOk = (args) => spawnSync("git", args, { stdio: "ignore", env: gitEnv() }).status === 0;

function checkConfig(qa) {
  if (typeof config.qaRepo !== "string") throw new Error("config.json: qaRepo must be a string");
  if (typeof config.qaSha !== "string" || !/^[0-9a-f]{40}$/.test(config.qaSha)) {
    throw new Error("config.json: qaSha must be a full commit sha (40 lowercase hex characters)");
  }
  if (!Array.isArray(config.keyFiles) || !config.keyFiles.length || !config.keyFiles.every((f) => typeof f === "string")) {
    throw new Error("config.json: keyFiles must be a non-empty list of paths");
  }
  for (const f of config.keyFiles) {
    const rel = path.relative(qa, path.resolve(qa, f));
    if (path.isAbsolute(f) || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
      throw new Error(`config.json: keyFiles entry ${f} is outside the clone`);
    }
  }
}

const lstat = (p) => fs.lstatSync(p, { throwIfNoEntry: false });

function fetchKey() {
  const cache = path.join(here, ".cache");
  const qa = path.join(cache, "QA");
  const keyFile = path.join(cache, "key.json");
  // a refused or failed fetch must not leave an older key looking current
  fs.rmSync(keyFile, { force: true });
  checkConfig(qa);
  fs.mkdirSync(cache, { recursive: true });
  if (!lstat(qa)) {
    // clone beside it and rename, so an interrupted clone never looks like a cache
    for (const f of fs.readdirSync(cache)) if (f.startsWith("QA.tmp-")) fs.rmSync(path.join(cache, f), { recursive: true, force: true });
    const tmp = path.join(cache, `QA.tmp-${process.pid}`);
    try {
      git(["clone", "--quiet", config.qaRepo, tmp]);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    fs.renameSync(tmp, qa);
  }
  // a symlink, a .git file or an empty or half-made folder would let git -C act on another repository
  const damaged = () => new Error(`the cache at ${qa} is damaged (not a complete clone); delete ${qa} and run: node eval/key.mjs fetch`);
  if (!lstat(qa).isDirectory() || !lstat(path.join(qa, ".git"))?.isDirectory()) throw damaged();
  let top = "";
  try {
    top = git(["-C", qa, "rev-parse", "--show-toplevel"]);
  } catch {}
  if (!top || fs.realpathSync(top) !== fs.realpathSync(qa) || !gitOk(["-C", qa, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) {
    throw damaged();
  }
  const has = () => gitOk(["-C", qa, "cat-file", "-e", `${config.qaSha}^{commit}`]);
  if (!has()) {
    git(["-C", qa, "fetch", "--quiet", "origin"]);
    if (!has()) throw new Error(`commit ${config.qaSha} is not in ${config.qaRepo}`);
  }
  if (git(["-C", qa, "status", "--porcelain"])) throw new Error(`${qa} has local changes; undo them or delete the folder, then run: node eval/key.mjs fetch`);
  git(["-C", qa, "checkout", "--quiet", config.qaSha]);
  const missing = config.keyFiles.filter((f) => !fs.existsSync(path.join(qa, f)));
  if (missing.length) throw new Error(`missing key files: ${missing.join(", ")}`);
  const rows = buildKey(qa, config.keyFiles);
  for (const f of config.keyFiles) console.log(`${rows.filter((r) => r.file === f).length}\t${f}`);
  const key = { qaSha: config.qaSha, keyFiles: config.keyFiles, parser: PARSER, rows };
  const tmp = `${keyFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(key, null, 2));
  fs.renameSync(tmp, keyFile);
  console.log(`${rows.length}\ttotal`);
}

function isMain() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  if (process.argv[2] === "fetch") {
    try {
      fetchKey();
    } catch (e) {
      console.error(`key.mjs: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error("usage: node eval/key.mjs fetch");
    process.exit(2);
  }
}
