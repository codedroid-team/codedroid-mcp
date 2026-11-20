/**
 * This computer signed in to CodeDroid with the user's Google account, the way the phone is:
 * `login` (RFC 8628, the device flow at the CodeDroid server's OAuth endpoints), the access
 * token each connection carries, the account's phones, and the sign-in codes `setup` hands a
 * phone on adb so it signs in as the same account with no Google sign-in of its own.
 *
 * The server keeps one grant per login, named after this computer, which the phone shows in
 * Settings > Computers and can remove; removing it ends the refresh token. The bridge's refresh
 * token is renewed in place, never replaced, so the one `login --ci` prints stays good as a CI
 * secret (CODEDROID_TOKEN) as long as it is used within 30 days.
 *
 * A library: failures are errors with a message for the user, never process.exit().
 */
import { spawn } from "child_process";
import os from "os";
import { DEFAULT_SERVER, normalizeServer, readAccount, saveAccount } from "./host.js";

export const CLIENT_ID = "codedroid-mcp";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "phone";
// A token with less than this left is refreshed before use.
const REFRESH_AHEAD_MS = 60_000;

export class LoginLapsedError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginLapsedError";
  }
}

export const LOGIN_AGAIN = "Run npx -y @codedroid/mcp login to sign in again.";

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server's answer as JSON, or null; errors name the server. */
async function post(fetch, url, form, { timeout = 30_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`Could not reach the CodeDroid server at ${new URL(url).origin}: ${e.cause?.message ?? e.message}`);
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * Opens [url] in the person's browser, best effort: a terminal with no desktop prints the URL
 * and nothing more.
 */
export function openBrowser(url, { platform = process.platform, spawner = spawn } = {}) {
  const [command, args] =
    platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawner(command, args, { stdio: "ignore", detached: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Signs this computer in: asks the server for a code, shows it and the link (opening the browser
 * unless [open] is false), waits for the sign-in, and keeps the account in host.json unless
 * [save] is false. Resolves the account, with the phones on it.
 *
 * @param {object} [options]
 * @param {string} [options.server]
 * @param {typeof fetch} [options.fetch]
 * @param {(line: string) => void} [options.log]  what to tell the person
 * @param {boolean} [options.open]  open the browser; the link is printed either way
 * @param {boolean} [options.save]  keep the account in host.json (false for `login --ci`)
 * @param {string} [options.hostname]  how the phone names this computer
 * @param {number} [options.timeoutMs]  how long to wait for the sign-in
 */
export async function login({
  server = DEFAULT_SERVER,
  fetch = globalThis.fetch,
  log = () => {},
  open = true,
  save = true,
  home = os.homedir(),
  hostname = os.hostname(),
  timeoutMs,
  sleep = sleepMs,
  now = Date.now,
  openUrl = openBrowser,
} = {}) {
  const base = normalizeServer(server);
  const started = await post(fetch, `${base}/oauth/device_authorization`, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    client_name: hostname.replace(/\.local$/, "").slice(0, 64) || "computer",
  });
  if (started.status !== 200 || !started.body?.device_code || !started.body.user_code) {
    const detail = started.body?.error_description ? `: ${started.body.error_description}` : "";
    throw new Error(
      started.status === 404
        ? `The CodeDroid server at ${base} has no account login yet; pair with a code instead, or update the server.`
        : `The CodeDroid server at ${base} refused to start the sign-in (HTTP ${started.status}${detail}).`,
    );
  }
  const { device_code, user_code, verification_uri, verification_uri_complete, interval = 5, expires_in = 600 } = started.body;
  const link = verification_uri_complete ?? verification_uri;
  log(`Sign in with Google at ${link}`);
  log(`Check that the page shows the code ${user_code}, then continue with the account you use in CodeDroid.`);
  if (open && openUrl(link)) log("Opened it in your browser.");

  const deadline = now() + (timeoutMs ?? expires_in * 1000);
  let wait = Math.max(1, interval) * 1000;
  for (;;) {
    if (now() >= deadline) throw new Error("The sign-in was not completed in time. Run login again for a new code.");
    await sleep(wait);
    const polled = await post(fetch, `${base}/oauth/token`, { grant_type: DEVICE_CODE_GRANT, device_code, client_id: CLIENT_ID });
    if (polled.status === 200 && polled.body?.access_token && polled.body.refresh_token) {
      const account = accountFromTokens(base, polled.body, now());
      if (save) saveAccount(account, { home });
      try {
        account.devices = await fetchDevices(account, { fetch, home, save, now });
      } catch (e) {
        log(`Signed in, but the phones could not be listed yet: ${e.message}`);
      }
      return account;
    }
    const error = polled.body?.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      wait += 5_000;
      continue;
    }
    if (error === "expired_token") throw new Error("The sign-in code expired. Run login again for a new one.");
    if (error === "access_denied") throw new Error("The sign-in was refused.");
    const detail = polled.body?.error_description ? `: ${polled.body.error_description}` : "";
    throw new Error(`The CodeDroid server at ${base} refused the sign-in (HTTP ${polled.status}${detail}).`);
  }
}

function accountFromTokens(server, tokens, nowMs) {
  return {
    server,
    email: emailOf(tokens.access_token),
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: nowMs + Math.max(0, Number(tokens.expires_in) || 0) * 1000,
    devices: [],
  };
}

/** The account an access token is for, from its payload; null when it has none. */
export function emailOf(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).sub ?? null;
  } catch (e) {
    return null;
  }
}

/** One refresh at a time per process; a second caller waits for the first. */
let refreshing = null;

/**
 * An access token for [account] good for at least a minute, refreshing it when needed and
 * keeping the refreshed account in host.json (unless it came from the environment). Throws
 * LoginLapsedError when the account can no longer be refreshed: it was removed on a phone, revoked
 * with logout, or lapsed after 30 days unused.
 */
export async function accessToken(account, { fetch = globalThis.fetch, home = os.homedir(), now = Date.now, save = true } = {}) {
  if (!account) throw new LoginLapsedError(`This computer is not signed in. ${LOGIN_AGAIN}`);
  if (account.access_token && account.expires_at && account.expires_at - now() > REFRESH_AHEAD_MS) return account.access_token;
  if (!refreshing) {
    refreshing = refresh(account, { fetch, home, now, save }).finally(() => {
      refreshing = null;
    });
  }
  const refreshed = await refreshing;
  Object.assign(account, refreshed);
  return account.access_token;
}

async function refresh(account, { fetch, home, now, save }, retried = false) {
  const base = account.server;
  const polled = await post(fetch, `${base}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: account.refresh_token,
    client_id: CLIENT_ID,
  });
  if (polled.status === 200 && polled.body?.access_token) {
    const fresh = {
      ...account,
      email: emailOf(polled.body.access_token) ?? account.email,
      refresh_token: polled.body.refresh_token ?? account.refresh_token,
      access_token: polled.body.access_token,
      expires_at: now() + Math.max(0, Number(polled.body.expires_in) || 0) * 1000,
    };
    if (save && !account.fromEnv) saveAccount(fresh, { home });
    return fresh;
  }
  if (polled.body?.error === "invalid_grant") {
    // Another process (the daemon, or a CLI) may have signed in again meanwhile: use what it kept.
    const current = !account.fromEnv && !retried ? readAccount({ home, env: {} }) : null;
    if (current && current.refresh_token !== account.refresh_token) return refresh(current, { fetch, home, now, save }, true);
    if (!account.fromEnv) saveAccount(null, { home });
    throw new LoginLapsedError(
      `This computer's CodeDroid sign-in is no longer valid: it was removed on a phone (Settings > Computers), signed out, ` +
        `or unused for 30 days. ${LOGIN_AGAIN}`,
    );
  }
  const detail = polled.body?.error_description ? `: ${polled.body.error_description}` : "";
  throw new Error(`The CodeDroid server at ${base} could not renew the sign-in (HTTP ${polled.status}${detail}).`);
}

/** A GET with the account's access token; {status, body}. */
async function get(account, path, { fetch, home, now, save, timeout = 15_000 }) {
  const token = await accessToken(account, { fetch, home, now, save });
  let res;
  try {
    res = await fetch(`${account.server}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`Could not reach the CodeDroid server at ${account.server}: ${e.cause?.message ?? e.message}`);
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * The account's phones from the server, [{id, model, linked}], kept in host.json as the account's
 * (unless [save] is false or the account came from the environment).
 */
export async function fetchDevices(account, { fetch = globalThis.fetch, home = os.homedir(), now = Date.now, save = true } = {}) {
  const { status, body } = await get(account, "/v1/mcp/devices", { fetch, home, now, save });
  if (status === 401) {
    throw new LoginLapsedError(`This computer's CodeDroid sign-in is no longer valid. ${LOGIN_AGAIN}`);
  }
  if (status !== 200 || !Array.isArray(body?.devices)) {
    throw new Error(`The CodeDroid server at ${account.server} could not list the account's phones (HTTP ${status}).`);
  }
  const devices = body.devices.filter((d) => d?.id).map((d) => ({ id: String(d.id), model: d.model ?? null, linked: !!d.linked }));
  account.devices = devices;
  if (body.account && !account.email) account.email = body.account;
  if (save && !account.fromEnv) saveAccount(account, { home });
  return devices;
}

/**
 * A one-time code (ten minutes) for a phone on this computer's adb to sign in to CodeDroid as
 * this account, with no Google sign-in on the phone (phone-setup.js hands it over).
 */
export async function mintSignInCode(account, { fetch = globalThis.fetch, home = os.homedir(), now = Date.now } = {}) {
  const token = await accessToken(account, { fetch, home, now });
  let res;
  try {
    res = await fetch(`${account.server}/v1/auth/signin-codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`Could not reach the CodeDroid server at ${account.server}: ${e.cause?.message ?? e.message}`);
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401) throw new LoginLapsedError(`This computer's CodeDroid sign-in is no longer valid. ${LOGIN_AGAIN}`);
  if (res.status === 404) {
    throw new Error(`The CodeDroid server at ${account.server} cannot sign a phone in from this computer yet; sign in on the phone.`);
  }
  if (res.status !== 201 || typeof body?.code !== "string") {
    throw new Error(`The CodeDroid server at ${account.server} gave no sign-in code (HTTP ${res.status}).`);
  }
  return body.code;
}

/**
 * Signs this computer out: tells the server to end the login, and forgets the account here. The
 * phones' pairings, if any, stay. Resolves the account that was signed out, or null.
 */
export async function logout({ fetch = globalThis.fetch, home = os.homedir(), env = process.env } = {}) {
  const account = readAccount({ home, env });
  if (!account) return null;
  try {
    await post(fetch, `${account.server}/oauth/revoke`, { token: account.refresh_token, client_id: CLIENT_ID }, { timeout: 15_000 });
  } catch (e) {
    // Offline: the account is forgotten here, and the server's grant lapses unused.
  }
  // CODEDROID_TOKEN's login is not the one host.json keeps: that one stays, still valid.
  if (!account.fromEnv) saveAccount(null, { home });
  return account;
}
