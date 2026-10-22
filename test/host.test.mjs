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
  ensureDaemonToken,
  hostFilePath,
  pair,
  pairedDevice,
  readDaemonToken,
  readHost,
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
  assert.equal(readHost({ home }), null);
  fs.mkdirSync(path.dirname(hostFilePath(home)), { recursive: true });
  fs.writeFileSync(hostFilePath(home), JSON.stringify({ id: "old" }));
  assert.equal(readHost({ home }), null);

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
    assert.deepEqual(readHost({ home }), host);
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

  // ── A hand-edited server is read normalized; a bad one is no pairing ──
  {
    const saved = JSON.parse(fs.readFileSync(hostFilePath(home), "utf8"));
    fs.writeFileSync(hostFilePath(home), JSON.stringify({ ...saved, server: "HTTPS://Orchestrator.dev2.codedroid.com/?x=1" }));
    assert.equal(readHost({ home }).server, "https://orchestrator.dev2.codedroid.com");
    fs.writeFileSync(hostFilePath(home), JSON.stringify({ ...saved, server: "not a url" }));
    assert.equal(readHost({ home }), null);
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
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
