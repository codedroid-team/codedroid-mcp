/**
 * This computer's credentials for phones, kept in ~/.codedroid/host.json (dir 0700, file 0600):
 *
 *   {account: {server, email, refresh_token, access_token, expires_at, devices: [{id, model}]},
 *    pairings: [{server, host_id, token, device: {id, model}}, ...]}
 *
 * The account is this computer signed in with the user's Google account (`login`, account.js):
 * every phone signed in to CodeDroid with that account is reached, with no pairing. A pairing is
 * the older way, one phone at a time: the phone shows a one-time code (Settings > Computers > Pair
 * a computer) that `pair` redeems at the CodeDroid server for a host token. Either credential is
 * the key to the relay: anyone holding it reaches the phones (still behind their Allow sheet), so
 * the file is the user's alone. A file from before several phones holds one pairing at its top
 * level, and is read as a list of one; the latest pairing is kept there too, so an older
 * codedroid-mcp still finds a phone.
 *
 * readHosts lists every phone this computer can reach, the account's first, as pairings: an
 * account's entry has `account: true` and no token (relay-transport.js gets an access token for it).
 */
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const DEFAULT_SERVER = "https://orchestrator.codedroid.com";

export const LOGIN_STEP =
  "Run npx -y @codedroid/mcp login and sign in with the Google account you use in CodeDroid: every phone " +
  "signed in to CodeDroid with it is reached, with nothing to pair.";

export const PAIR_BY_HAND =
  "On the phone, open CodeDroid > Settings > Computers > Pair a computer, then run the command it shows " +
  "on this computer (npx -y @codedroid/mcp pair XXXX-XXXX).";

export const PAIRING_STEPS =
  `${LOGIN_STEP} Or plug the phone into this computer with USB debugging on and run npx -y @codedroid/mcp setup: ` +
  `it installs CodeDroid if needed and signs the phone in. Or pair by hand. ${PAIR_BY_HAND}`;

/** What to do when the account has no phone: the one problem signing in does not solve. */
export const NO_ACCOUNT_PHONE =
  "No phone is signed in to CodeDroid with this account. On the phone, open CodeDroid and sign in with the same " +
  "Google account, or plug it in with USB debugging on and run npx -y @codedroid/mcp setup.";

export function hostFilePath(home = os.homedir()) {
  return path.join(home, ".codedroid", "host.json");
}

export function daemonTokenPath(home = os.homedir()) {
  return path.join(home, ".codedroid", "daemon-token");
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** The shared daemon credential, or null only when the file does not exist. */
export function readDaemonToken({ home = os.homedir() } = {}) {
  const file = daemonTokenPath(home);
  try {
    const entry = fs.lstatSync(file);
    if (!entry.isFile()) throw new Error("expected a regular token file, not a directory or symlink");
    if (
      process.platform !== "win32" &&
      (entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0)
    ) {
      throw new Error("the token must be owned by this user with permissions 0600");
    }
    const token = fs.readFileSync(file, "utf8").trim();
    if (!TOKEN_PATTERN.test(token)) throw new Error("invalid token contents");
    return token;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(
      `Cannot read daemon token at ${file}: ${e.message}. ` +
        "Check its permissions; to reset it, end all CodeDroid daemon processes before deleting the file and restarting.",
      { cause: e },
    );
  }
}

/**
 * Create once and reuse across ports and restarts. Publish a fully written 0600 file with a hard
 * link: unlike rename, link fails if another starter already published its token. Every starter
 * reads the winner. Staging on the same filesystem keeps publication atomic, without exposing a
 * partially written credential or overwriting an existing one.
 */
export function ensureDaemonToken({ home = os.homedir() } = {}) {
  const existing = readDaemonToken({ home });
  if (existing) return existing;
  const file = daemonTokenPath(home);
  let staging;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    staging = fs.mkdtempSync(path.join(path.dirname(file), ".daemon-token-"));
    const staged = path.join(staging, "token");
    fs.writeFileSync(staged, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(staged, file);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const token = readDaemonToken({ home });
    if (!token) throw new Error("the token disappeared during startup; end all daemons before resetting it");
    return token;
  } catch (e) {
    throw new Error(
      `Cannot create daemon token at ${file}: ${e.message}. ` +
        "Make ~/.codedroid writable, or provision a private 0600 daemon-token file there before starting.",
      { cause: e },
    );
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** A saved pairing as used, or null when it is incomplete or its server is unusable. */
function validHost(host) {
  try {
    return host?.token && host.server ? { ...host, server: normalizeServer(host.server) } : null;
  } catch (e) {
    return null;
  }
}

/** host.json as saved, or {} when there is none or it is not JSON. */
function readHostFile(home) {
  try {
    return JSON.parse(fs.readFileSync(hostFilePath(home), "utf8")) ?? {};
  } catch (e) {
    return {};
  }
}

function writeHostFile(saved, home) {
  const file = hostFilePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A new file, renamed over the old: 0600 from its first byte, and never half-written.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The explicit pairings, in the order they were made; empty when none was made. */
export function readPairings({ home = os.homedir() } = {}) {
  const saved = readHostFile(home);
  const entries = Array.isArray(saved?.pairings) ? saved.pairings : [saved];
  return entries.map(validHost).filter(Boolean);
}

/**
 * The account this computer is signed in with: CODEDROID_TOKEN in the environment (a refresh
 * token from `login --ci`, for CI; CODEDROID_SERVER names its server), else host.json's. Null when
 * neither.
 */
export function readAccount({ home = os.homedir(), env = process.env } = {}) {
  const fromEnv = env.CODEDROID_TOKEN?.trim();
  if (fromEnv) {
    return { server: normalizeServer(env.CODEDROID_SERVER?.trim() || DEFAULT_SERVER), refresh_token: fromEnv, fromEnv: true, devices: [] };
  }
  const account = readHostFile(home).account;
  if (!account?.refresh_token || !account.server) return null;
  try {
    return { ...account, server: normalizeServer(account.server), devices: Array.isArray(account.devices) ? account.devices : [] };
  } catch (e) {
    return null;
  }
}

/** Keeps [account] (null to sign out) in host.json, leaving the pairings as they are. */
export function saveAccount(account, { home = os.homedir() } = {}) {
  const saved = readHostFile(home);
  const { account: _, ...rest } = saved;
  if (account?.fromEnv) return;
  writeHostFile(account ? { ...rest, account } : rest, home);
}

/** An account's phone as a pairing entry: reached with an access token, not a host token. */
export function accountHost(account, device) {
  return { server: account.server, account: true, host_id: null, token: null, device: { id: device.id, model: device.model ?? null } };
}

/**
 * Every phone this computer reaches, the account's phones first, then the pairings with any other
 * phone. [accountDevices] is the account's phone list to use instead of the saved one (the daemon
 * keeps a fresh one). Empty when this computer is neither signed in with a phone nor paired.
 */
export function readHosts({ home = os.homedir(), env = process.env, accountDevices } = {}) {
  const account = readAccount({ home, env });
  const devices = account ? (accountDevices ?? account.devices).filter((d) => d?.id) : [];
  const own = new Set(devices.map((d) => String(d.id)));
  return [
    ...devices.map((d) => accountHost(account, d)),
    ...readPairings({ home }).filter((h) => !own.has(String(deviceKey(h)))),
  ];
}

export function saveHosts(hosts, { home = os.homedir() } = {}) {
  const pairings = hosts.filter((h) => !h.account);
  const { account } = readHostFile(home);
  writeHostFile({ ...pairings.at(-1), pairings, ...(account ? { account } : {}) }, home);
}

/** What names a pairing's phone: its device id, or the host id from a server that sent none. */
export function deviceKey(host) {
  return host.device?.id ?? host.host_id;
}

/** A pairing as a person reads it: "Pixel 9 (6f1c0d6e-...)". */
export function describeHost(host) {
  return `${host.device?.model ?? "unknown model"} (${deviceKey(host)})`;
}

/**
 * The pairing [selector] names among [hosts], tried in this order: its device id; its model; the
 * start of its id; part of its model ("Pixel" for "Google Pixel 5"). Case does not matter. A
 * selector that names several phones, or none, throws a message naming the paired phones.
 */
export function findHost(hosts, selector) {
  const wanted = String(selector ?? "").trim().toLowerCase();
  const paired = hosts.length ? `Paired: ${hosts.map(describeHost).join(", ")}.` : `None is paired. ${PAIRING_STEPS}`;
  if (!wanted) throw new Error(`Name a phone by its id or model. ${paired}`);
  const exact = hosts.find((h) => String(deviceKey(h)).toLowerCase() === wanted);
  if (exact) return exact;
  for (const matches of [
    hosts.filter((h) => h.device?.model?.toLowerCase() === wanted),
    hosts.filter((h) => String(deviceKey(h)).toLowerCase().startsWith(wanted)),
    hosts.filter((h) => h.device?.model?.toLowerCase().includes(wanted)),
  ]) {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`"${selector}" matches ${matches.length} paired phones: ${matches.map(describeHost).join(", ")}. Use the id.`);
    }
  }
  throw new Error(`No paired phone is "${selector}". ${paired}`);
}

/** Forgets the pairing [selector] names (findHost); resolves the one removed. */
export function unpair(selector, { home = os.homedir() } = {}) {
  const hosts = readHosts({ home });
  const removed = findHost(hosts, selector);
  if (removed.account) {
    throw new Error(
      `${describeHost(removed)} is reached through your account, not a pairing. To stop reaching it, sign CodeDroid ` +
        "out on the phone, remove this computer in CodeDroid > Settings > Computers there, or run npx -y @codedroid/mcp logout.",
    );
  }
  saveHosts(hosts.filter((h) => h !== removed), { home });
  return removed;
}

/** The phone a pairing points at, as status and /health show it. */
export function pairedDevice(host) {
  return host
    ? { id: host.device?.id ?? null, model: host.device?.model ?? null, server: host.server, ...(host.account ? { account: true } : {}) }
    : null;
}

/** A loopback host, where plaintext http is safe because nothing leaves this machine. */
function isLoopbackHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

/** [server] without a trailing slash, or an error saying what is wrong with it. */
export function normalizeServer(server) {
  let url;
  try {
    url = new URL(server);
  } catch (e) {
    throw new Error(`Not a server URL: ${server}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Not an http(s) server URL: ${server}`);
  // Plaintext http would send the pairing code and the host token in the open; allow it only to a
  // loopback host (local development) and require https for anything reachable over a network.
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(`Refusing a plaintext http server for ${server}: use https (http is allowed only for localhost).`);
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

const NEW_CODE = "On the phone, open CodeDroid > Settings > Computers > Pair a computer for a new one.";

/**
 * Redeems [code] at [server] and adds the pairing to the saved ones, replacing an earlier pairing
 * with the same phone; resolves what was saved. Throws a message for the user, and leaves the
 * saved pairings as they were, on any failure.
 */
export async function pair(
  code,
  { server = DEFAULT_SERVER, fetch = globalThis.fetch, home = os.homedir(), hostname = os.hostname(), platform = os.platform() } = {},
) {
  // The server reads the code the forgiving way (any case, with or without the dash); this only
  // catches what cannot be one before a round-trip.
  const typed = String(code).replace(/\s+/g, "");
  if (!/^[0-9a-z]{8}$/i.test(typed.replace(/-/g, ""))) {
    throw new Error(`${code} is not a pairing code: it is 8 letters and digits, like ABCD-EFGH. ${NEW_CODE}`);
  }
  const base = normalizeServer(server);
  let res;
  try {
    res = await fetch(`${base}/v1/mcp/pairings/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: typed,
        name: hostname.replace(/\.local$/, "").slice(0, 64) || "computer",
        platform: platform.slice(0, 32),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`Could not reach the CodeDroid server at ${base}: ${e.cause?.message ?? e.message}`);
  }
  const body = await res.json().catch(() => null);
  if (res.status === 404) throw new Error(`The code ${code} is not valid: codes work once, for 10 minutes. ${NEW_CODE}`);
  if (!res.ok) {
    const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
    throw new Error(`The CodeDroid server at ${base} refused the pairing (HTTP ${res.status}${detail}).`);
  }
  if (typeof body?.token !== "string" || !body.host_id) {
    throw new Error(`The CodeDroid server at ${base} answered the pairing without a host token; update codedroid-mcp.`);
  }
  const host = {
    server: base,
    host_id: body.host_id,
    token: body.token,
    device: { id: body.device?.id ?? null, model: body.device?.model ?? null },
  };
  const others = readPairings({ home }).filter((h) => deviceKey(h) !== deviceKey(host));
  saveHosts([...others, host], { home });
  return host;
}
