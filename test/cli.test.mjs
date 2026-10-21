/**
 * The CLI against real daemons it starts itself — no phone required.
 *
 * A client's adb setting (flag or env) must reach the daemon it starts, and `stop` must say so when
 * a daemon refuses it rather than claim it stopped. Every CLI run gets a home and temp directory of
 * its own, so this never touches the real ~/.codedroid or a running daemon.
 *
 * Run: node test/cli.test.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../src/daemon.js";

const indexPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-cli-"));

/** A home of its own, with its own temp directory for the token's read-only fallback. */
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
    await cli(["--adb", `--port=${port}`, "call", "codedroid_status"], env);
    const running = await health(port);
    started.push(running?.pid);
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
    await cli(["--no-adb", `--port=${port}`, "call", "codedroid_status"], { ...env, CODEDROID_MCP_ADB: "1" });
    const running = await health(port);
    started.push(running?.pid);
    assert.equal(running?.adbToolEnabled, false, "--no-adb must reach the daemon the client starts");
    await cli([`--port=${port}`, "stop"], env);
  }

  // ── stop fails, saying why, when the daemon refuses this user's token ─
  {
    const owner = sandbox("owner");
    const other = sandbox("other");
    process.env.TMPDIR = path.join(owner.home, "tmp");
    delete process.env.XDG_RUNTIME_DIR;
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
