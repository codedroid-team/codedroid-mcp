/**
 * The CLI against real daemons it starts itself — no phone required.
 *
 * A client's adb setting (flag or env) must reach the daemon it starts, and `stop` must say so when
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

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [indexPath, ...args], { env, timeout: 60_000 }, (error, stdout, stderr) => {
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
  // ── --adb reaches the daemon a client starts, and stop stops it ─────
  {
    const { env } = sandbox("flag");
    const port = await freePort();
    const result = await cli(["--adb", `--port=${port}`, "call", "codedroid_status"], env);
    const running = await health(port);
    started.push(running?.pid);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).connected, false);
    assert.equal(running?.adbToolEnabled, true, "--adb must reach the daemon the client starts");
    const stop = await cli([`--port=${port}`, "stop"], env);
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /Stopped the daemon/);
    assert.equal(await health(port), null, "and stop must really stop it");
  }

  // ── --no-adb wins over an inherited CODEDROID_MCP_ADB=1 ──────────────
  {
    const { env } = sandbox("no-adb");
    const port = await freePort();
    const result = await cli(["--no-adb", `--port=${port}`, "call", "codedroid_status"], { ...env, CODEDROID_MCP_ADB: "1" });
    const running = await health(port);
    started.push(running?.pid);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).connected, false);
    assert.equal(running?.adbToolEnabled, false, "--no-adb must reach the daemon the client starts");
    const stop = await cli([`--port=${port}`, "stop"], env);
    assert.equal(stop.code, 0, stop.stderr);
  }

  // Conflicting flags leave adb off, regardless of argv order.
  for (const flags of [["--adb", "--no-adb"], ["--no-adb", "--adb"]]) {
    const { env } = sandbox(`conflict-${flags[0]}`);
    const port = await freePort();
    const result = await cli([...flags, `--port=${port}`, "call", "codedroid_status"], env);
    const running = await health(port);
    started.push(running?.pid);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).connected, false);
    assert.equal(running?.adbToolEnabled, false);
    const stop = await cli([`--port=${port}`, "stop"], env);
    assert.equal(stop.code, 0, stop.stderr);
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
