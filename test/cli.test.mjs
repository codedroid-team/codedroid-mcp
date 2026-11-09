/**
 * The CLI against real daemons it starts itself — no phone required.
 *
 * A client's adb setting (flag or env) must decide its own session, and `stop` must say so when
 * a daemon refuses it rather than claim it stopped. Each CLI run has its own home, so this never
 * touches the real ~/.codedroid or a running daemon.
 *
 * Run: node test/cli.test.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../src/daemon.js";
import { daemonTokenPath, ensureDaemonToken } from "../src/host.js";
import { VERSION } from "../src/version.js";

const indexPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-cli-"));

/** A home and environment of its own, isolated from real pairing and daemon state. */
function sandbox(name) {
  const home = path.join(root, name);
  fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
  const env = { ...process.env, HOME: home, TMPDIR: path.join(home, "tmp") };
  for (const key of ["XDG_RUNTIME_DIR", "CODEDROID_MCP_ADB", "CODEDROID_MCP_PORT"]) delete env[key];
  return { home, env };
}

function cli(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [indexPath, ...args], { env, cwd, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function health(port) {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  } catch (e) {
    return null;
  }
}

/** Daemons the CLI started, ended below if a failed assertion left them running. */
const started = [];

try {
  // ── adb is on by default, per client, and stop stops the daemon ─────
  {
    const { home, env } = sandbox("default");
    const port = await freePort();
    // Each client's relative paths start from its own directory, not the daemon's.
    const fakeAdb = path.join(home, "fake-adb");
    fs.writeFileSync(fakeAdb, "#!/bin/sh\npwd -P\n", { mode: 0o755 });
    const adbEnv = { ...env, ADB: fakeAdb };
    const [dirA, dirB] = ["a", "b"].map((name) => {
      fs.mkdirSync(path.join(home, name));
      return fs.realpathSync(path.join(home, name));
    });
    const on = await cli([`--port=${port}`, "call", "adb", '{"command":"version"}'], adbEnv, dirA);
    const running = await health(port);
    started.push(running?.pid);
    assert.equal(on.code, 0, on.stderr);
    assert.equal(on.stdout.trim(), dirA);
    assert.equal((await cli([`--port=${port}`, "call", "adb", '{"command":"version"}'], adbEnv, dirB)).stdout.trim(), dirB);
    assert.equal(running?.adbToolEnabled, true, "a client starts the daemon with adb");
    assert.equal(running?.adbPerClient, true);
    // A client that declines adb does not lose it for the others, and the others do not force it on it.
    for (const [args, extra] of [[["--no-adb"], {}], [[], { CODEDROID_MCP_ADB: "0" }], [["--adb", "--no-adb"], {}], [[], { CODEDROID_MCP_ADB: "nope" }]]) {
      const off = await cli([...args, `--port=${port}`, "call", "adb", '{"command":"version"}'], { ...env, ...extra });
      assert.notEqual(off.code, 0, `${args} ${JSON.stringify(extra)} must not get adb`);
    }
    assert.equal((await health(port))?.adbToolEnabled, true);
    const stop = await cli([`--port=${port}`, "stop"], env);
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /Stopped the daemon/);
    assert.equal(await health(port), null, "and stop must really stop it");
  }

  // ── A client that starts the daemon declining adb keeps it for the next client ─
  {
    const { env } = sandbox("no-adb-first");
    const port = await freePort();
    const result = await cli([`--port=${port}`, "call", "codedroid_status"], { ...env, CODEDROID_MCP_ADB: "0" });
    const running = await health(port);
    started.push(running?.pid);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(running?.adbToolEnabled, true);
    await cli([`--port=${port}`, "stop"], env);
  }

  // ── The daemon command itself can turn adb off for every client ─────
  {
    const { home, env } = sandbox("daemon-off");
    const daemon = await startDaemon({ port: 0, home, enableAdbTool: false });
    try {
      const result = await cli([`--port=${daemon.port}`, "call", "adb", '{"command":"version"}'], env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /started with the adb tool off/);
    } finally {
      await daemon.close();
    }
  }

  // ── A daemon from before per-client adb is replaced, not used ───────
  {
    const { home, env } = sandbox("older-daemon");
    const token = ensureDaemonToken({ home });
    const port = await freePort();
    let shutdowns = 0;
    const older = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ service: "codedroid-mcp-daemon", version: "0.1.3", authentication: "bearer-v1", adbToolEnabled: false }));
      } else if (req.url === "/shutdown" && req.headers.authorization === `Bearer ${token}`) {
        shutdowns++;
        res.end("{}");
        setImmediate(() => {
          older.close();
          older.closeAllConnections();
        });
      } else {
        res.writeHead(401);
        res.end("{}");
      }
    });
    await new Promise((resolve) => older.listen(port, "127.0.0.1", resolve));
    const result = await cli([`--port=${port}`, "call", "codedroid_status"], env);
    const running = await health(port);
    started.push(running?.pid);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(shutdowns, 1);
    assert.match(result.stderr, /Replacing the older daemon \(v0\.1\.3\)/);
    assert.equal(running?.adbPerClient, true);
    await cli([`--port=${port}`, "stop"], env);
  }

  // ── A daemon behind this client's version is replaced, and keeps adb as it was set ─
  for (const [name, adbToolEnabled] of [["behind", true], ["behind-adb-off", false]]) {
    const { home, env } = sandbox(name);
    const token = ensureDaemonToken({ home });
    const port = await freePort();
    let shutdowns = 0;
    const older = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ service: "codedroid-mcp-daemon", version: "0.0.9", pid: 1, authentication: "bearer-v1", adbToolEnabled, adbPerClient: true }));
      } else if (req.url === "/shutdown" && req.headers.authorization === `Bearer ${token}`) {
        shutdowns++;
        res.end("{}");
        setImmediate(() => {
          older.close();
          older.closeAllConnections();
        });
      } else {
        res.writeHead(401);
        res.end("{}");
      }
    });
    await new Promise((resolve) => older.listen(port, "127.0.0.1", resolve));
    const result = await cli([`--port=${port}`, "call", "codedroid_status"], env);
    const running = await health(port);
    started.push(running?.pid);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(shutdowns, 1);
    assert.match(result.stderr, /Replacing the older daemon \(v0\.0\.9\)/);
    assert.equal(running?.version, VERSION);
    assert.equal(running?.adbToolEnabled, adbToolEnabled);
    await cli([`--port=${port}`, "stop"], env);
  }

  // ── A daemon ahead of this client is used, not replaced: clients must not take turns ─
  {
    const { home, env } = sandbox("ahead");
    ensureDaemonToken({ home });
    const port = await freePort();
    let shutdowns = 0;
    const newer = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ service: "codedroid-mcp-daemon", version: "99.0.0", authentication: "bearer-v1", adbToolEnabled: true, adbPerClient: true }));
      } else {
        if (req.url === "/shutdown") shutdowns++;
        res.writeHead(404);
        res.end("{}");
      }
    });
    await new Promise((resolve) => newer.listen(port, "127.0.0.1", resolve));
    const result = await cli([`--port=${port}`, "call", "codedroid_status"], env);
    newer.close();
    newer.closeAllConnections();
    assert.equal(shutdowns, 0);
    assert.doesNotMatch(result.stderr, /Replacing the older daemon/);
  }

  // ── An older daemon that refuses to stop is left running, and said so ─
  {
    const { env } = sandbox("older-refuses");
    const older = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") res.end(JSON.stringify({ service: "codedroid-mcp-daemon", version: "0.1.3", authentication: "bearer-v1", adbToolEnabled: false }));
      else {
        res.writeHead(401);
        res.end("{}");
      }
    });
    await new Promise((resolve) => older.listen(0, "127.0.0.1", resolve));
    try {
      const result = await cli([`--port=${older.address().port}`, "call", "codedroid_status"], env);
      assert.match(result.stderr, /refused to stop/);
    } finally {
      await new Promise((resolve) => older.close(resolve));
    }
  }

  // Legacy discovery is insufficient: refuse to connect, but keep `stop` usable for migration.
  for (const protectedLegacy of [false, true]) {
    const { home, env } = sandbox(`legacy-${protectedLegacy}`);
    const token = protectedLegacy ? ensureDaemonToken({ home }) : null;
    const requests = [];
    const legacy = http.createServer((req, res) => {
      requests.push({ path: req.url, authorization: req.headers.authorization });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ service: "codedroid-mcp-daemon", version: "0.1.2", adbToolEnabled: true }));
      } else if (req.url === "/shutdown" && req.method === "POST") {
        if (token && req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401);
          res.end("{}");
          return;
        }
        res.end(JSON.stringify({ ok: true }));
        // Emulate the old daemon process exiting, including its keep-alive connections.
        setImmediate(() => {
          legacy.close();
          legacy.closeAllConnections();
        });
      } else {
        res.writeHead(500);
        res.end("{}");
      }
    });
    await new Promise((resolve) => legacy.listen(0, "127.0.0.1", resolve));
    const port = legacy.address().port;
    try {
      const connect = await cli([`--port=${port}`, "call", "codedroid_status"], env);
      assert.notEqual(connect.code, 0);
      assert.match(connect.stderr, /needs an authentication upgrade/);
      assert.ok(connect.stderr.includes(`stop --port=${port}`));
      const daemon = await cli(["daemon", `--port=${port}`], env);
      assert.notEqual(daemon.code, 0);
      assert.match(daemon.stderr, /needs an authentication upgrade/);
      assert.ok(!requests.some((req) => req.path === "/mcp"), "never use tools on a legacy daemon");
      // An invalid new credential must not prevent stopping an old daemon which never needed it.
      if (!protectedLegacy) {
        fs.mkdirSync(path.dirname(daemonTokenPath(home)), { recursive: true });
        fs.writeFileSync(daemonTokenPath(home), "invalid", { mode: 0o600 });
      }
      const stop = await cli([`--port=${port}`, "stop"], env);
      assert.equal(stop.code, 0, stop.stderr);
      assert.match(stop.stdout, /Stopped the daemon/);
      if (protectedLegacy) {
        const shutdowns = requests.filter((req) => req.path === "/shutdown");
        assert.deepEqual(shutdowns.map((req) => req.authorization), [undefined, `Bearer ${token}`]);
      } else {
        assert.ok(requests.every((req) => req.authorization === undefined));
      }
    } finally {
      await new Promise((resolve) => legacy.close(resolve));
    }
  }

  // A shared home yields one credential across clients with different runtime/temp environments.
  {
    const { home, env } = sandbox("different-env");
    const daemon = await startDaemon({
      port: 0, home,
      phoneTransportFactory: () => { throw new Error("No phone in CLI test"); },
    });
    try {
      const otherTmp = path.join(home, "other-tmp");
      fs.mkdirSync(otherTmp);
      const result = await cli([`--port=${daemon.port}`, "call", "codedroid_status"], {
        ...env, TMPDIR: otherTmp, XDG_RUNTIME_DIR: otherTmp,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).connected, false);
      fs.rmSync(daemonTokenPath(home));
      const missing = await cli([`--port=${daemon.port}`, "call", "codedroid_status"], env);
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /daemon token is missing.*End the CodeDroid daemon process/);
      assert.equal(fs.existsSync(daemonTokenPath(home)), false);
    } finally {
      await daemon.close();
    }
  }

  // ── stop fails, saying why, when the daemon refuses this user's token ─
  {
    const owner = sandbox("owner");
    const other = sandbox("other");
    const daemon = await startDaemon({
      port: 0,
      home: owner.home,
      phoneTransportFactory: () => {
        throw new Error("This computer is not paired with a phone.");
      },
    });
    try {
      const stop = await cli([`--port=${daemon.port}`, "stop"], other.env);
      assert.notEqual(stop.code, 0, "a refused stop must fail");
      assert.match(stop.stderr, new RegExp(`port ${daemon.port} \\(pid ${process.pid}\\) refused to stop`));
      assert.doesNotMatch(stop.stdout, /Stopped the daemon/);
      assert.ok(await health(daemon.port), "the daemon is still running, as the message says");
    } finally {
      await daemon.close();
    }
  }

  // ── unpair forgets one phone; a running daemon that serves several keeps going ─
  {
    const { home, env } = sandbox("unpair");
    const pairing = (id, model) => ({ server: "https://orchestrator.example", host_id: `h-${id}`, token: `t-${id}`, device: { id, model } });
    fs.mkdirSync(path.join(home, ".codedroid"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(home, ".codedroid", "host.json"),
      JSON.stringify({ pairings: [pairing("aaaa-1", "XPS Googlebook"), pairing("bbbb-2", "Pixel 9")] }),
      { mode: 0o600 },
    );
    const daemon = await startDaemon({ port: 0, home, phoneTransportFactory: () => { throw new Error("offline"); } });
    try {
      const missing = await cli([`--port=${daemon.port}`, "unpair", "Galaxy"], env);
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /No paired phone is "Galaxy"\. Paired: XPS Googlebook \(aaaa-1\), Pixel 9 \(bbbb-2\)/);
      const removed = await cli([`--port=${daemon.port}`, "unpair", "Pixel", "9"], env);
      assert.equal(removed.code, 0, removed.stderr);
      assert.match(removed.stdout, /Unpaired Pixel 9 \(bbbb-2\)/);
      const saved = JSON.parse(fs.readFileSync(path.join(home, ".codedroid", "host.json"), "utf8"));
      assert.deepEqual(saved.pairings.map((p) => p.device.model), ["XPS Googlebook"]);
      const status = await cli([`--port=${daemon.port}`, "call", "codedroid_status"], env);
      assert.deepEqual(JSON.parse(status.stdout).devices.map((d) => d.model), ["XPS Googlebook"], "the running daemon reads the change");
      assert.ok(await health(daemon.port), "unpairing does not stop a daemon that serves several phones");
    } finally {
      await daemon.close();
    }
  }

  console.log("cli.test.mjs: ALL PASS");
} finally {
  for (const pid of started) {
    try {
      if (pid) process.kill(pid);
    } catch (e) {
      /* already stopped */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
