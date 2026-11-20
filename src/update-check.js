/**
 * Whether a newer @codedroid/mcp is on npm. Clients launch `npx -y @codedroid/mcp@latest`, so a new
 * release arrives with their next start on its own; this only makes that visible: the daemon logs
 * it and codedroid_status reports it, so the agent can tell the user to restart the client.
 *
 * One request to the npm registry a day, from the daemon, with nothing but the package name in it;
 * `CODEDROID_MCP_UPDATE_CHECK=0` turns it off. What it learned is kept in ~/.codedroid/update-check.json,
 * and a failed check keeps the last answer.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { VERSION } from "./version.js";

export const UPDATE_CHECK_ENV = "CODEDROID_MCP_UPDATE_CHECK";
export const REGISTRY_URL = "https://registry.npmjs.org/@codedroid/mcp/latest";
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function updateCachePath(home = os.homedir()) {
  return path.join(home, ".codedroid", "update-check.json");
}

/** Negative when version a is older than b; a missing or malformed version counts as oldest. */
export function compareVersions(a, b) {
  const parts = (v) => (typeof v === "string" ? v.split(".").map((n) => Number.parseInt(n, 10) || 0) : [-1]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

export function updateCheckEnabled(env = process.env) {
  const raw = env[UPDATE_CHECK_ENV];
  return !(raw === "0" || raw?.toLowerCase() === "false");
}

/** The last check's answer, {latest, checkedAt}, or null when there was none or the file is bad. */
export function readUpdateCache({ home = os.homedir() } = {}) {
  try {
    const cache = JSON.parse(fs.readFileSync(updateCachePath(home), "utf8"));
    return SEMVER.test(cache?.latest) && Number.isFinite(cache?.checkedAt) ? { latest: cache.latest, checkedAt: cache.checkedAt } : null;
  } catch (e) {
    return null;
  }
}

/** What to say when [latest] is newer than this release, else null. */
export function describeUpdate(latest, current = VERSION) {
  if (!latest || compareVersions(latest, current) <= 0) return null;
  return {
    current,
    latest,
    hint: `CodeDroid MCP ${latest} is out; this is ${current}. Coding clients launch @latest, so restarting the client brings it in.`,
  };
}

/** The last check's verdict on this release, from the cache alone: for tools, which must not wait on npm. */
export function cachedUpdate({ home = os.homedir() } = {}) {
  return describeUpdate(readUpdateCache({ home })?.latest);
}

/**
 * The newest version on npm, {latest, checkedAt}: the cache when it is younger than [ttlMs], else
 * one request. Null when the check is off, or nothing is known and npm did not answer.
 */
export async function checkForUpdate({
  home = os.homedir(),
  env = process.env,
  fetch: fetchFn = globalThis.fetch,
  now = Date.now(),
  ttlMs = CHECK_INTERVAL_MS,
} = {}) {
  if (!updateCheckEnabled(env)) return null;
  const cache = readUpdateCache({ home });
  if (cache && now - cache.checkedAt < ttlMs) return cache;
  try {
    const res = await fetchFn(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`npm answered ${res.status}`);
    const { version } = await res.json();
    if (!SEMVER.test(version)) throw new Error("npm answered without a version");
    const fresh = { latest: version, checkedAt: now };
    const file = updateCachePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(fresh));
    return fresh;
  } catch (e) {
    return cache;
  }
}

/**
 * The daemon's check: now and then once a day, logging when a newer release is out. Returns a
 * function that stops it.
 */
export function startUpdateChecks({ home = os.homedir(), env = process.env, log = () => {}, intervalMs = CHECK_INTERVAL_MS, fetch: fetchFn } = {}) {
  const run = async () => {
    const result = await checkForUpdate({ home, env, ...(fetchFn ? { fetch: fetchFn } : {}) });
    const update = describeUpdate(result?.latest);
    if (update) log(update.hint);
  };
  run().catch(() => {});
  const timer = setInterval(() => run().catch(() => {}), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
