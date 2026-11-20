/**
 * Account login against a fake CodeDroid server on a real HTTP port: the device flow, the token
 * kept and renewed, the account's phones, sign-in codes and logout. No orchestrator, no browser.
 *
 * Run: node test/account.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { accessToken, emailOf, fetchDevices, login, LoginLapsedError, logout, mintSignInCode, openBrowser } from "../src/account.js";
import { startDaemon } from "../src/daemon.js";
import { hostFilePath, readAccount, readHosts, readPairings, saveAccount, saveHosts, unpair } from "../src/host.js";

const ALICE = "alice@example.com";

/** An access token as the server mints it: a JWT whose payload names the account; nothing checks the signature here. */
function accessTokenFor(email, n = 1) {
  const payload = Buffer.from(JSON.stringify({ sub: email, grant: "g1", n })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

/**
 * The CodeDroid server's OAuth and account endpoints, scripted: `approveAfter` polls answer
 * pending until the user "signs in"; `refreshAnswers` what each refresh gets.
 */
async function fakeServer({ approveAfter = 2, slowDownAt = null, refreshAnswers = [] } = {}) {
  const state = { requests: [], polls: 0, refreshes: 0, devices: [], codes: [], revoked: [], liveRefresh: "cdmcp_r_1" };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = Object.fromEntries(new URLSearchParams(body));
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, form });
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/oauth/device_authorization") {
      assert.equal(form.client_id, "codedroid-mcp");
      assert.equal(form.scope, "phone");
      return json(200, {
        device_code: "cdmcp_d_x",
        user_code: "ABCD-EFGH",
        verification_uri: `${state.url}/oauth/device`,
        verification_uri_complete: `${state.url}/oauth/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 0,
      });
    }
    if (req.url === "/oauth/token" && form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      assert.equal(form.device_code, "cdmcp_d_x");
      state.polls++;
      if (slowDownAt !== null && state.polls === slowDownAt) return json(400, { error: "slow_down" });
      if (state.polls <= approveAfter) return json(400, { error: "authorization_pending" });
      return json(200, { access_token: accessTokenFor(ALICE), token_type: "Bearer", expires_in: 3600, refresh_token: state.liveRefresh, scope: "phone" });
    }
    if (req.url === "/oauth/token" && form.grant_type === "refresh_token") {
      state.refreshes++;
      const scripted = refreshAnswers.shift();
      if (scripted) return json(scripted.status, scripted.body);
      if (form.refresh_token !== state.liveRefresh) return json(400, { error: "invalid_grant", error_description: "The refresh token is not valid." });
      return json(200, { access_token: accessTokenFor(ALICE, state.refreshes + 1), token_type: "Bearer", expires_in: 3600, refresh_token: form.refresh_token, scope: "phone" });
    }
    if (req.url === "/v1/mcp/devices") {
      if (req.headers.authorization !== `Bearer ${state.expectAccess ?? accessTokenFor(ALICE)}`) return json(401, { detail: "Sign in again" });
      return json(200, { account: ALICE, devices: state.devices });
    }
    if (req.url === "/v1/auth/signin-codes") {
      if (!req.headers.authorization?.startsWith("Bearer ")) return json(401, { detail: "Sign in again" });
      const code = `cdsi_${state.codes.length + 1}`;
      state.codes.push(code);
      return json(201, { code, expires_in: 600 });
    }
    if (req.url === "/oauth/revoke") {
      state.revoked.push(form.token);
      res.writeHead(200);
      return res.end();
    }
    json(404, { detail: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-account-"));
const newHome = () => fs.mkdtempSync(path.join(root, "home-"));
const noSleep = async () => {};
// The daemon reads the account from this process's environment: these cases are about host.json.
delete process.env.CODEDROID_TOKEN;

try {
  // ── login: the link and code are shown, polling waits, the account is kept with its phones ──
  {
    const server = await fakeServer({ approveAfter: 2, slowDownAt: 2 });
    server.devices = [{ id: "dev-1", model: "Pixel 9", linked: true }, { id: "dev-2", model: null, linked: false }];
    const home = newHome();
    const log = [];
    const opened = [];
    const account = await login({ server: server.url, home, hostname: "borna-mbp.local", log: (l) => log.push(l), sleep: noSleep, openUrl: (u) => (opened.push(u), true) });
    assert.equal(server.requests[0].form.client_name, "borna-mbp", "the phone shows the computer's name");
    assert.ok(log[0].includes(`${server.url}/oauth/device?user_code=ABCD-EFGH`), log[0]);
    assert.ok(log[1].includes("ABCD-EFGH"), "the code is shown, to check against the page");
    assert.deepEqual(opened, [`${server.url}/oauth/device?user_code=ABCD-EFGH`]);
    assert.equal(server.polls, 3, "pending, slow_down, then the tokens");
    assert.equal(account.email, ALICE);
    assert.equal(account.refresh_token, "cdmcp_r_1");
    assert.deepEqual(account.devices.map((d) => d.id), ["dev-1", "dev-2"]);

    const saved = readAccount({ home, env: {} });
    assert.equal(saved.server, server.url);
    assert.equal(saved.refresh_token, "cdmcp_r_1");
    assert.deepEqual(saved.devices.map((d) => [d.id, d.model]), [["dev-1", "Pixel 9"], ["dev-2", null]]);
    if (process.platform !== "win32") assert.equal(fs.statSync(hostFilePath(home)).mode & 0o777, 0o600, "the account is a credential");

    // The account's phones are this computer's hosts, with no token of their own, before any pairing.
    saveHosts([{ server: server.url, host_id: "h", token: "t", device: { id: "dev-2", model: "Pixel 8" } }, { server: server.url, host_id: "h3", token: "t3", device: { id: "dev-3", model: "Pixel 7" } }], { home });
    const hosts = readHosts({ home, env: {} });
    assert.deepEqual(hosts.map((h) => [h.device.id, !!h.account, h.token]), [["dev-1", true, null], ["dev-2", true, null], ["dev-3", false, "t3"]], "a pairing with a phone on the account gives way to the account");
    assert.equal(readAccount({ home, env: {} }).refresh_token, "cdmcp_r_1", "saving pairings keeps the account");
    assert.deepEqual(readHosts({ home, env: {}, accountDevices: [{ id: "dev-9", model: "Fold" }] }).map((h) => h.device.id), ["dev-9", "dev-2", "dev-3"], "the daemon's fresh list replaces the saved one");

    // A valid access token is reused; one about to lapse is renewed in place and kept.
    assert.equal(await accessToken(saved, { home }), accessTokenFor(ALICE));
    saved.expires_at = Date.now() + 10_000;
    assert.equal(await accessToken(saved, { home }), accessTokenFor(ALICE, 2));
    assert.equal(server.refreshes, 1);
    assert.equal(readAccount({ home, env: {} }).access_token, accessTokenFor(ALICE, 2), "the renewed token is kept");
    assert.equal(readAccount({ home, env: {} }).refresh_token, "cdmcp_r_1", "the bridge's refresh token does not rotate");

    // A sign-in code for a phone on adb.
    server.expectAccess = accessTokenFor(ALICE, 2);
    assert.equal(await mintSignInCode(saved, { home }), "cdsi_1");

    // Logout revokes the refresh token and forgets the account; the pairings stay.
    const out = await logout({ home, env: {} });
    assert.equal(out.email, ALICE);
    assert.deepEqual(server.revoked, ["cdmcp_r_1"]);
    assert.equal(readAccount({ home, env: {} }), null);
    assert.deepEqual(readHosts({ home, env: {} }).map((h) => h.device.id), ["dev-2", "dev-3"], "the pairings are back in play");
    assert.equal(await logout({ home, env: {} }), null);
    await server.close();
  }

  // ── A revoked login: the account is forgotten and the message says how to sign in again ──
  {
    const server = await fakeServer();
    const home = newHome();
    const account = { server: server.url, email: ALICE, refresh_token: "cdmcp_r_old", access_token: "x", expires_at: 0, devices: [] };
    saveAccount(account, { home });
    await assert.rejects(accessToken({ ...account }, { home }), (e) => e instanceof LoginLapsedError && /login/.test(e.message));
    assert.equal(readAccount({ home, env: {} }), null, "a login the server no longer knows is dropped");

    // Another process signed in again meanwhile: its token is used, not the stale one.
    saveAccount({ ...account, refresh_token: "cdmcp_r_1" }, { home });
    const stale = { ...account };
    assert.equal(await accessToken(stale, { home }), accessTokenFor(ALICE, 4), "the failed try, the stale try, then the fresh token");
    assert.equal(stale.refresh_token, "cdmcp_r_1", "the caller's account is brought up to date");

    // Listing phones with a token the server refuses says to sign in again.
    server.expectAccess = "something-else";
    await assert.rejects(fetchDevices({ ...stale, expires_at: Date.now() + 3600_000, access_token: "wrong" }, { home }), LoginLapsedError);
    await server.close();
  }

  // ── CODEDROID_TOKEN: the account from the environment, never written to disk ──
  {
    const server = await fakeServer();
    server.devices = [{ id: "dev-ci", model: "Emulator", linked: true }];
    const home = newHome();
    const env = { CODEDROID_TOKEN: "cdmcp_r_1", CODEDROID_SERVER: server.url };
    const account = readAccount({ home, env });
    assert.equal(account.fromEnv, true);
    assert.deepEqual(readHosts({ home, env }), [], "nothing is known until the daemon lists the account's phones");
    server.expectAccess = accessTokenFor(ALICE, 2);
    assert.deepEqual((await fetchDevices(account, { home })).map((d) => d.id), ["dev-ci"]);
    assert.ok(!fs.existsSync(hostFilePath(home)), "an environment token writes nothing");
    assert.deepEqual(readHosts({ home, env, accountDevices: account.devices }).map((h) => [h.device.id, h.account]), [["dev-ci", true]]);
    assert.throws(() => readAccount({ home, env: { CODEDROID_TOKEN: "x", CODEDROID_SERVER: "http://evil.example.com" } }), /plaintext/, "a plaintext server off this machine is refused");
    await server.close();
  }

  // ── login --ci: nothing saved; a server without the flow says so ──
  {
    const server = await fakeServer({ approveAfter: 0 });
    const home = newHome();
    const account = await login({ server: server.url, home, save: false, log: () => {}, sleep: noSleep, open: false });
    assert.equal(account.refresh_token, "cdmcp_r_1");
    assert.ok(!fs.existsSync(hostFilePath(home)));
    await server.close();

    const old = http.createServer((req, res) => (res.writeHead(404, { "Content-Type": "application/json" }), res.end('{"detail":"Not Found"}')));
    await new Promise((resolve) => old.listen(0, "127.0.0.1", resolve));
    await assert.rejects(login({ server: `http://127.0.0.1:${old.address().port}`, home, log: () => {}, sleep: noSleep, open: false }), /has no account login yet; pair with a code/);
    await new Promise((resolve) => old.close(resolve));
  }

  // ── unpair keeps the pairings readHosts hides behind the account ──
  {
    const home = newHome();
    const pairing = (id) => ({ server: "https://orchestrator.example.com", host_id: `h-${id}`, token: `t-${id}`, device: { id, model: null } });
    saveHosts([pairing("dev-2"), pairing("dev-3"), pairing("dev-4")], { home });
    saveAccount({ server: "https://orchestrator.example.com", email: ALICE, refresh_token: "r", devices: [{ id: "dev-2", model: "Pixel 8" }] }, { home });
    assert.equal(unpair("dev-4", { home }).device.id, "dev-4");
    assert.deepEqual(readPairings({ home }).map((h) => h.device.id), ["dev-2", "dev-3"], "the pairing with a phone also on the account stays");
    assert.throws(() => unpair("dev-2", { home }), /reached through your account/);
    assert.deepEqual(readPairings({ home }).map((h) => h.device.id), ["dev-2", "dev-3"]);
    assert.equal(readAccount({ home, env: {} }).refresh_token, "r", "unpair keeps the account");
  }

  // ── logout with CODEDROID_TOKEN revokes that token and leaves host.json's login alone ──
  {
    const server = await fakeServer();
    const home = newHome();
    saveAccount({ server: server.url, email: ALICE, refresh_token: "cdmcp_r_saved", devices: [] }, { home });
    const out = await logout({ home, env: { CODEDROID_TOKEN: "cdmcp_r_ci", CODEDROID_SERVER: server.url } });
    assert.equal(out.fromEnv, true);
    assert.deepEqual(server.revoked, ["cdmcp_r_ci"]);
    assert.equal(readAccount({ home, env: {} }).refresh_token, "cdmcp_r_saved", "the saved login is still there, and still valid");
    await server.close();
  }

  // ── The daemon: a hanging server never holds up its start; the phone list follows the login ──
  {
    const home = newHome();
    const offline = () => { throw new Error("no phone in this test"); };
    const hang = () => new Promise(() => {});
    saveAccount({ server: "https://orchestrator.example.com", email: ALICE, refresh_token: "r-a", devices: [] }, { home });
    let started = Date.now();
    let daemon = await startDaemon({ port: 0, home, phoneTransportFactory: offline, accountDevices: hang, accountStartupWaitMs: 100 });
    assert.ok(Date.now() - started < 3_000, "no phones saved: the start waits, within its bound");
    await daemon.close();

    saveAccount({ server: "https://orchestrator.example.com", email: ALICE, refresh_token: "r-a", devices: [{ id: "dev-saved", model: null }] }, { home });
    started = Date.now();
    daemon = await startDaemon({ port: 0, home, phoneTransportFactory: offline, accountDevices: hang, accountStartupWaitMs: 60_000 });
    assert.ok(Date.now() - started < 3_000, "phones saved: the start does not wait on the server");
    assert.deepEqual(daemon.phones.select().map((e) => e.pairing.device.id), ["dev-saved"]);
    await daemon.close();

    saveAccount({ server: "https://orchestrator.example.com", email: ALICE, refresh_token: "r-a", devices: [] }, { home });
    daemon = await startDaemon({ port: 0, home, phoneTransportFactory: offline, accountDevices: async () => [{ id: "dev-a", model: null }] });
    try {
      assert.deepEqual(daemon.phones.select().map((e) => e.pairing.device.id), ["dev-a"], "the list read at start");
      saveAccount({ server: "https://orchestrator.example.com", email: "bob@example.com", refresh_token: "r-b", devices: [{ id: "dev-b", model: null }] }, { home });
      assert.deepEqual(daemon.phones.select().map((e) => e.pairing.device.id), ["dev-b"], "another login: its own phones, not the last one's");
    } finally {
      await daemon.close();
    }
  }

  // ── The pieces ──
  assert.equal(emailOf(accessTokenFor("x@y.z")), "x@y.z");
  assert.equal(emailOf("not.a.jwt"), null);
  assert.equal(emailOf(""), null);
  {
    const spawned = [];
    const spawner = (command, args) => (spawned.push([command, ...args]), { unref() {}, on() {} });
    openBrowser("https://x", { platform: "darwin", spawner });
    openBrowser("https://x", { platform: "linux", spawner });
    openBrowser("https://x", { platform: "win32", spawner });
    assert.deepEqual(spawned, [["open", "https://x"], ["xdg-open", "https://x"], ["cmd", "/c", "start", "", "https://x"]]);
    assert.equal(openBrowser("https://x", { platform: "linux", spawner: () => { throw new Error("no"); } }), false);
  }
  console.log("account: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
