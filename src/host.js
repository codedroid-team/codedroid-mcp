/**
 * This computer's pairing with a phone, kept in ~/.codedroid/host.json (dir 0700, file 0600):
 * {server, host_id, token, device: {id, model}}.
 *
 * The phone shows a one-time code (Settings > Computers > Pair a computer); `pair` redeems it at
 * the CodeDroid server for a host token. The token is the key to the relay: anyone holding it
 * reaches the phone (still behind its Allow sheet), so the file is the user's alone.
 */
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

/**
 * The running daemon's bearer token, written by the daemon at startup and read by every client on
 * this computer (shim, CLI). The file is the shared secret: in a 0700 dir, 0600, so a process that
 * cannot read the user's home — another local user, a browser reaching loopback — cannot get it.
 * Null when no daemon has written one.
 */
export function readDaemonToken({ home = os.homedir() } = {}) {
  try {
    const token = fs.readFileSync(daemonTokenPath(home), "utf8").trim();
    return token || null;
  } catch (e) {
    return null;
  }
}

export function writeDaemonToken(token, { home = os.homedir() } = {}) {
  const file = daemonTokenPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Same atomic 0600 write as saveHost: 0600 from its first byte, never half-written.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearDaemonToken({ home = os.homedir() } = {}) {
  try {
    fs.rmSync(daemonTokenPath(home));
  } catch (e) {
    /* already gone */
  }
}

/** The saved pairing, or null when this computer is not paired. */
export function readHost({ home = os.homedir() } = {}) {
  try {
    const host = JSON.parse(fs.readFileSync(hostFilePath(home), "utf8"));
    return host?.token && host.server ? { ...host, server: normalizeServer(host.server) } : null;
  } catch (e) {
    return null;
  }
}

export function saveHost(host, { home = os.homedir() } = {}) {
  const file = hostFilePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A new file, renamed over the old: 0600 from its first byte, and never half-written.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(host, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The phone a pairing points at, as status and /health show it. */
export function pairedDevice(host) {
  return host ? { id: host.device?.id ?? null, model: host.device?.model ?? null, server: host.server } : null;
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
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

const NEW_CODE = "On the phone, open CodeDroid > Settings > Computers > Pair a computer for a new one.";

/**
 * Redeems [code] at [server] and saves the pairing, replacing any earlier one; resolves what was
 * saved. Throws a message for the user, and leaves the earlier pairing as it was, on any failure.
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
  saveHost(host, { home });
  return host;
}
