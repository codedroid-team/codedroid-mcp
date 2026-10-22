/** Real processes exercise credential publication, shared use, and startup cleanup. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startDaemon } from "../src/daemon.js";
import { daemonTransport } from "../src/daemon-transport.js";
import { daemonTokenPath, readDaemonToken } from "../src/host.js";

if (process.argv[2] === "child") {
  const home = process.argv[3];
  const barrier = process.argv[4];
  const mkdir = fs.mkdirSync;
  let waited = false;
  // Hold both starters after observing the missing token and before publishing anything.
  // This filesystem barrier makes the formerly racy failure deterministic across processes.
  fs.mkdirSync = (dir, ...args) => {
    const result = mkdir(dir, ...args);
    if (dir === path.dirname(daemonTokenPath(home)) && !waited) {
      waited = true;
      fs.writeFileSync(path.join(barrier, `ready-${process.pid}`), "");
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(path.join(barrier, "release"))) {
        if (Date.now() > deadline) throw new Error("Startup barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return result;
  };
  const daemon = await startDaemon({
    port: 0,
    home,
    phoneTransportFactory: () => { throw new Error("No phone in startup test"); },
  });
  fs.mkdirSync = mkdir;
  process.on("message", async () => {
    await daemon.close();
    process.disconnect();
  });
  process.send({ port: daemon.port, token: daemon.authToken });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codedroid-startup-"));
  const children = [];
  try {
    const home = path.join(root, "shared-home");
    const barrier = path.join(root, "barrier");
    fs.mkdirSync(home);
    fs.mkdirSync(barrier);
    const messages = Array.from({ length: 2 }, () => new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ["child", home, barrier], {
        env: { ...process.env, HOME: home, TMPDIR: home, XDG_RUNTIME_DIR: "" },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Starter exited before replying: ${code}`)));
    }));
    const starters = Promise.all(messages);
    // Observe failures immediately even while waiting for the filesystem barrier.
    starters.catch(() => {});
    const deadline = Date.now() + 10_000;
    while (fs.readdirSync(barrier).length < 2) {
      if (Date.now() > deadline) throw new Error("Children did not reach the startup barrier");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(path.join(barrier, "release"), "");
    const daemons = await starters;
    assert.notEqual(daemons[0].port, daemons[1].port);
    assert.equal(daemons[0].token, daemons[1].token, "concurrent starters must adopt one credential");
    const token = readDaemonToken({ home });
    assert.equal(token, daemons[0].token);
    for (const { port } of daemons) {
      const client = new Client({ name: "startup-test", version: "0" });
      try {
        await client.connect(daemonTransport(port, token));
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["codedroid_status"],
          "adb must be absent by default");
        const result = await client.callTool({ name: "codedroid_status", arguments: {} });
        assert.equal(JSON.parse(result.content[0].text).connected, false);
        assert.equal(result.isError, false, "both daemons must accept authenticated tool calls");
      } finally {
        await client.close();
      }
    }
    await Promise.all(children.map((child) => new Promise((resolve) => {
      child.once("exit", resolve);
      child.send("close");
    })));

    const badHome = path.join(root, "invalid-home");
    fs.mkdirSync(path.dirname(daemonTokenPath(badHome)), { recursive: true });
    fs.writeFileSync(daemonTokenPath(badHome), "invalid", { mode: 0o600 });
    const socket = net.createServer();
    await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    await assert.rejects(startDaemon({ port, home: badHome }), /invalid token contents/);
    // A rejected start must release its port before control returns to the caller.
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => socket.close(resolve));

    const owner = await startDaemon({ port: 0, home });
    try {
      const losingHome = path.join(root, "loser");
      await assert.rejects(startDaemon({ port: owner.port, home: losingHome }), { code: "EADDRINUSE" });
      assert.equal(readDaemonToken({ home: losingHome }), null, "a bind loser must not create credentials");
    } finally {
      await owner.close();
    }
    console.log("daemon-startup.test.mjs: ALL PASS");
  } finally {
    await Promise.all(children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGKILL");
      });
    }));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
