/**
 * This computer's pairings with phones, kept in ~/.codedroid/host.json (dir 0700, file 0600):
 * {pairings: [{server, host_id, token, device: {id, model}}, ...]}. A file from before several
 * phones holds one pairing at its top level, and is read as a list of one; the latest pairing is
 * kept there too, so an older codedroid-mcp still finds a phone.
 *
 * The phone shows a one-time code (Settings > Computers > Pair a computer); `pair` redeems it at
 * the CodeDroid server for a host token. The token is the key to the relay: anyone holding it
 * reaches the phone (still behind its Allow sheet), so the file is the user's alone.
 */
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const DEFAULT_SERVER = "https://orchestrator.codedroid.com";

export const PAIRING_STEPS =
  "On the phone, open CodeDroid > Settings > Computers > Pair a computer, then run the command it shows " +
  "on this computer (npx -y @codedroid/mcp pair XXXX-XXXX).";

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

/** The saved pairings, in the order they were made; empty when this computer is not paired. */
export function readHosts({ home = os.homedir() } = {}) {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(hostFilePath(home), "utf8"));
  } catch (e) {
    return [];
  }
  const entries = Array.isArray(saved?.pairings) ? saved.pairings : [saved];
  return entries.map(validHost).filter(Boolean);
}

export function saveHosts(hosts, { home = os.homedir() } = {}) {
  const file = hostFilePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A new file, renamed over the old: 0600 from its first byte, and never half-written.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...hosts.at(-1), pairings: hosts }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
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
  saveHosts(hosts.filter((h) => h !== removed), { home });
  return removed;
}

/** The phone a pairing points at, as status and /health show it. */
export function pairedDevice(host) {
  return host ? { id: host.device?.id ?? null, model: host.device?.model ?? null, server: host.server } : null;
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
  const others = readHosts({ home }).filter((h) => deviceKey(h) !== deviceKey(host));
  saveHosts([...others, host], { home });
  return host;
}
