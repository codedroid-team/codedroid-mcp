/**
 * Pairing: redeeming the phone's code and keeping the host token — no server.
 *
 * Run: node test/host.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  daemonTokenPath,
  describeHost,
  ensureDaemonToken,
  findHost,
  hostFilePath,
  pair,
  pairedDevice,
  readDaemonToken,
  readHosts,
  unpair,
} from "../src/host.js";

/** A fetch that records the request and answers [status] with [body]. */
function fakeFetch(status, body) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  fetch.calls = calls;
  return fetch;
}

const REDEEMED = {
  host_id: "6f1c0d6e-0000-4000-8000-000000000001",
  token: "cdmcp_abc",
  device: { id: "6f1c0d6e-0000-4000-8000-000000000002", model: "Pixel 5" },
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-host-"));
try {
  // ── Not paired: no file, or the adb-era {id} file ───────────────────
  assert.deepEqual(readHosts({ home }), []);
  fs.mkdirSync(path.dirname(hostFilePath(home)), { recursive: true });
  fs.writeFileSync(hostFilePath(home), JSON.stringify({ id: "old" }));
  assert.deepEqual(readHosts({ home }), []);

  // ── Redeem: the request, then host.json the user's alone ────────────
  {
    const fetch = fakeFetch(200, REDEEMED);
    const host = await pair(" ABCD-EFGH ", {
      server: "https://orchestrator.dev2.codedroid.com/",
      fetch,
      home,
      hostname: "borna-mbp.local",
      platform: "darwin",
    });
    assert.equal(fetch.calls[0].url, "https://orchestrator.dev2.codedroid.com/v1/mcp/pairings/redeem");
    assert.equal(fetch.calls[0].init.method, "POST");
    assert.equal(fetch.calls[0].init.headers.Authorization, undefined, "redeeming takes no credentials");
    assert.deepEqual(fetch.calls[0].body, { code: "ABCD-EFGH", name: "borna-mbp", platform: "darwin" });
    assert.deepEqual(host, { server: "https://orchestrator.dev2.codedroid.com", ...REDEEMED });
    assert.deepEqual(readHosts({ home }), [host]);
    assert.deepEqual(pairedDevice(host), { ...REDEEMED.device, server: "https://orchestrator.dev2.codedroid.com" });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(hostFilePath(home)).mode & 0o777, 0o600, "an older host.json is narrowed too");
    }
  }

  // ── A long hostname is cut to what the server keeps ─────────────────
  {
    const fetch = fakeFetch(200, REDEEMED);
    await pair("ABCD-EFGH", { fetch, home, hostname: "h".repeat(100), platform: "p".repeat(40) });
    assert.equal(fetch.calls[0].url, "https://orchestrator.codedroid.com/v1/mcp/pairings/redeem", "prod by default");
    assert.equal(fetch.calls[0].body.name.length, 64);
    assert.equal(fetch.calls[0].body.platform.length, 32);
  }

  // ── A fresh home gets a 0700 directory ──────────────────────────────
  {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-host-"));
    try {
      await pair("ABCD-EFGH", { fetch: fakeFetch(200, REDEEMED), home: fresh, hostname: "h", platform: "linux" });
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(path.dirname(hostFilePath(fresh))).mode & 0o777, 0o700);
        assert.equal(fs.statSync(hostFilePath(fresh)).mode & 0o777, 0o600);
      }
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  }

  // ── Unknown, expired or used: say so, keep the old pairing ──────────
  {
    const before = fs.readFileSync(hostFilePath(home), "utf8");
    await assert.rejects(
      pair("ZZZZ-ZZZZ", { fetch: fakeFetch(404, { detail: "Unknown or expired code" }), home }),
      /ZZZZ-ZZZZ is not valid: codes work once, for 10 minutes.*Pair a computer/,
    );
    assert.equal(fs.readFileSync(hostFilePath(home), "utf8"), before);
  }

  // ── Typed lowercase, without the dash, or split by a space: the server reads it ──
  for (const typed of ["abcdefgh", "abcd efgh", "abcd-efgh"]) {
    const fetch = fakeFetch(200, REDEEMED);
    await pair(typed, { fetch, home });
    assert.equal(fetch.calls[0].body.code, typed.replace(" ", ""));
  }

  // ── Not a code: said before any request ─────────────────────────────
  for (const typed of ["A", "ABCD-EFG", "ABCD-EFGHI", "ABCD_EFGH"]) {
    const fetch = fakeFetch(200, REDEEMED);
    await assert.rejects(pair(typed, { fetch, home }), /is not a pairing code: it is 8 letters and digits/);
    assert.equal(fetch.calls.length, 0, typed);
  }

  // ── Other refusals, no network, an answer without a token ───────────
  {
    const before = fs.readFileSync(hostFilePath(home), "utf8");
    await assert.rejects(pair("ABCD-EFGH", { fetch: fakeFetch(429, { detail: "Too many tries" }), home }), /refused the pairing \(HTTP 429: Too many tries\)/);
    await assert.rejects(pair("ABCD-EFGH", { fetch: fakeFetch(502, "<html>"), home }), /refused the pairing \(HTTP 502\)\.$/);
    await assert.rejects(
      pair("ABCD-EFGH", { fetch: async () => Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") })), home }),
      /Could not reach the CodeDroid server at https:\/\/orchestrator\.codedroid\.com: getaddrinfo ENOTFOUND/,
    );
    await assert.rejects(pair("ABCD-EFGH", { fetch: fakeFetch(200, { host_id: "h" }), home }), /without a host token/);
    assert.equal(fs.readFileSync(hostFilePath(home), "utf8"), before, "a failed pair keeps the old pairing");
  }
  await assert.rejects(pair("ABCD-EFGH", { server: "ftp://orchestrator.codedroid.com", fetch: fakeFetch(200, REDEEMED), home }), /Not an http\(s\) server URL/);
  await assert.rejects(pair("ABCD-EFGH", { server: "not a url", fetch: fakeFetch(200, REDEEMED), home }), /Not a server URL/);

  // ── Plaintext http is refused for a networked host, allowed for loopback ──
  await assert.rejects(
    pair("ABCD-EFGH", { server: "http://orchestrator.codedroid.com", fetch: fakeFetch(200, REDEEMED), home }),
    /Refusing a plaintext http server/,
  );
  for (const server of ["http://localhost:8000", "http://127.0.0.1:8000", "http://dev.localhost"]) {
    const host = await pair("ABCD-EFGH", { server, fetch: fakeFetch(200, REDEEMED), home });
    assert.ok(host.server.startsWith("http://"), `${server} is allowed for local development`);
  }

  // ── A hand-edited server is read normalized; a bad or plaintext one is no pairing ──
  {
    const [saved] = readHosts({ home });
    const write = (server) => fs.writeFileSync(hostFilePath(home), JSON.stringify({ pairings: [{ ...saved, server }] }));
    write("HTTPS://Orchestrator.dev2.codedroid.com/?x=1");
    assert.equal(readHosts({ home })[0].server, "https://orchestrator.dev2.codedroid.com");
    write("not a url");
    assert.deepEqual(readHosts({ home }), []);
    write("http://orchestrator.codedroid.com");
    assert.deepEqual(readHosts({ home }), [], "a hand-edited plaintext http pairing is not used");
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// ── Several phones: each pairing adds one, and a phone is named by id or model ──
{
  const multi = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-hosts-"));
  const redeemed = (n, model) => ({ host_id: `host-${n}`, token: `cdmcp_${n}`, device: { id: `${n}f1c0d6e-0000-4000-8000-00000000000${n}`, model } });
  const pairAs = (n, model, server) => pair("ABCD-EFGH", { server, fetch: fakeFetch(200, redeemed(n, model)), home: multi });
  try {
    // A host.json from before several phones is read as one pairing, and kept when another is added.
    fs.mkdirSync(path.dirname(hostFilePath(multi)), { recursive: true });
    fs.writeFileSync(hostFilePath(multi), JSON.stringify({ server: "https://orchestrator.dev2.codedroid.com", ...redeemed(1, "XPS Googlebook") }));
    assert.deepEqual(readHosts({ home: multi }).map((h) => h.device.model), ["XPS Googlebook"]);
    await pairAs(2, "Pixel 9");
    await pairAs(3, "Pixel 9", "https://orchestrator.dev2.codedroid.com");
    const hosts = readHosts({ home: multi });
    assert.deepEqual(hosts.map((h) => h.token), ["cdmcp_1", "cdmcp_2", "cdmcp_3"], "a new pairing never replaces another phone's");
    assert.deepEqual(hosts.map((h) => h.server), [
      "https://orchestrator.dev2.codedroid.com",
      "https://orchestrator.codedroid.com",
      "https://orchestrator.dev2.codedroid.com",
    ]);
    const file = JSON.parse(fs.readFileSync(hostFilePath(multi), "utf8"));
    assert.equal(file.token, "cdmcp_3", "the latest pairing stays at the top level, where an older codedroid-mcp reads it");
    assert.equal(file.pairings.length, 3);

    // Pairing the same phone again replaces its pairing, in place of a second one.
    await pair("ABCD-EFGH", { fetch: fakeFetch(200, { ...redeemed(2, "Pixel 9"), token: "cdmcp_2b" }), home: multi });
    assert.deepEqual(readHosts({ home: multi }).map((h) => h.token), ["cdmcp_1", "cdmcp_3", "cdmcp_2b"]);

    // Naming a phone: its id, a unique model, or the unique start of its id; any case.
    const [xps, pixelA, pixelB] = readHosts({ home: multi });
    assert.equal(findHost([xps, pixelA, pixelB], xps.device.id.toUpperCase()), xps);
    assert.equal(findHost([xps, pixelA, pixelB], "xps googlebook"), xps);
    assert.equal(findHost([xps, pixelA, pixelB], "3f1c"), pixelA);
    assert.equal(findHost([xps, pixelA, pixelB], "googlebook"), xps, "part of a model names the one phone that has it");
    assert.throws(() => findHost([xps, pixelA, pixelB], "pixel"), /"pixel" matches 2 paired phones/);
    assert.throws(() => findHost([xps, pixelA, pixelB], "Pixel 9"), /matches 2 paired phones: Pixel 9 \(3f1c.*\), Pixel 9 \(2f1c.*\)\. Use the id/);
    assert.throws(() => findHost([xps, pixelA, pixelB], "Galaxy"), /No paired phone is "Galaxy"\. Paired: XPS Googlebook \(1f1c/);
    assert.throws(() => findHost([], "Galaxy"), /None is paired\. On the phone/);
    assert.throws(() => findHost([xps], " "), /Name a phone/);
    assert.equal(describeHost({ host_id: "h", device: { id: null, model: null } }), "unknown model (h)", "a pairing without a device id is named by its host id");

    // Unpairing forgets that phone alone.
    assert.equal(unpair("XPS Googlebook", { home: multi }).token, "cdmcp_1");
    assert.deepEqual(readHosts({ home: multi }).map((h) => h.token), ["cdmcp_3", "cdmcp_2b"]);
    assert.throws(() => unpair("XPS", { home: multi }), /No paired phone is "XPS"/);
    assert.deepEqual(readHosts({ home: multi }).map((h) => h.token), ["cdmcp_3", "cdmcp_2b"], "a failed unpair keeps every pairing");
    if (process.platform !== "win32") assert.equal(fs.statSync(hostFilePath(multi)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(multi, { recursive: true, force: true });
  }
}

// ── Token lifecycle: never silently rotate an existing credential ─────
{
  const tokenHome = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-token-"));
  const file = daemonTokenPath(tokenHome);
  try {
    assert.equal(readDaemonToken({ home: tokenHome }), null);
    const token = ensureDaemonToken({ home: tokenHome });
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(ensureDaemonToken({ home: tokenHome }), token);
    assert.equal(readDaemonToken({ home: tokenHome }), token);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["daemon-token"], "staging files are cleaned up");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      fs.chmodSync(file, 0o644);
      assert.throws(() => readDaemonToken({ home: tokenHome }), /permissions 0600/);
      assert.throws(() => ensureDaemonToken({ home: tokenHome }), /permissions 0600/);
      assert.equal(fs.readFileSync(file, "utf8").trim(), token, "insecure files are not replaced");
      fs.chmodSync(file, 0o600);
    }
    fs.writeFileSync(file, "not a token\n");
    assert.throws(() => readDaemonToken({ home: tokenHome }), /invalid token contents/);
    assert.throws(() => ensureDaemonToken({ home: tokenHome }), /end all CodeDroid daemon processes/);
    assert.equal(fs.readFileSync(file, "utf8"), "not a token\n", "invalid contents are not replaced");
    fs.writeFileSync(file, token + "\n");

    if (process.platform !== "win32" && process.getuid() !== 0) {
      fs.chmodSync(file, 0o000);
      try {
        assert.throws(() => readDaemonToken({ home: tokenHome }), /Cannot read daemon token/);
        assert.throws(() => ensureDaemonToken({ home: tokenHome }), /Cannot read daemon token/);
      } finally {
        fs.chmodSync(file, 0o600);
      }
      const dir = path.dirname(file);
      fs.chmodSync(dir, 0o500);
      try {
        assert.equal(ensureDaemonToken({ home: tokenHome }), token, "pre-provisioned read-only homes work");
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      fs.rmSync(file);
      fs.chmodSync(dir, 0o500);
      try {
        assert.throws(() => ensureDaemonToken({ home: tokenHome }), /Make ~\/\.codedroid writable/);
        assert.equal(readDaemonToken({ home: tokenHome }), null, "no silent fallback to another location");
      } finally {
        fs.chmodSync(dir, 0o700);
      }
    }
  } finally {
    fs.rmSync(tokenHome, { recursive: true, force: true });
  }
}

console.log("host.test.mjs: ALL PASS");
