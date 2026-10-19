/**
 * AdbPhoneTransport — an MCP SDK `Transport` to CodeDroid's server on the phone, over adb.
 *
 *   1. Pick the device and the Android user in front (adb.js).
 *   2. `adb forward tcp:0 localabstract:codedroid-mcp-<user>`: adb picks a free port on this
 *      computer and carries the bytes to the app's socket. Only adb can reach that socket; the
 *      app accepts the shell user it arrives as, and no other app.
 *   3. One hello line: {type:"hello", proto, bridge, host_id, host, platform, client}. The phone
 *      answers {type:"approved"} -- after the user taps Allow, the first time this computer
 *      connects -- or {type:"denied", reason}.
 *   4. Then MCP: newline-delimited JSON-RPC both ways.
 *
 * A connection the phone closes before answering means nothing is listening there: the bridge
 * then asks adb why (diagnose) and says so.
 *
 * This module is a library: it never calls process.exit(); failures surface through start()
 * rejection or the onclose/onerror callbacks.
 */
import net from "net";
import os from "os";
import { currentUser, diagnose, makeAdb, pickDevice } from "./adb.js";
import { hostIdentity } from "./host.js";
import { VERSION } from "./version.js";

export const PROTOCOL = 1;

export class PhoneUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "PhoneUnavailableError";
  }
}

export class PhoneDeniedError extends Error {
  constructor(reason) {
    super(`The phone refused this computer${reason ? `: ${reason}` : "."}`);
    this.name = "PhoneDeniedError";
  }
}

/**
 * What the phone calls this computer's agent, after the computer's name: CODEDROID_MCP_CLIENT, or
 * nothing. Not guessed from the environment: one daemon serves every MCP client on this computer,
 * and it inherits the environment of whichever started it, so a guess would name the wrong one.
 */
export function clientName(env = process.env) {
  return env.CODEDROID_MCP_CLIENT?.trim() ?? "";
}

export class AdbPhoneTransport {
  /**
   * @param {object} [options]
   * @param {(args: string[], opts?: object) => Promise<string>} [options.adb]
   * @param {(port: number) => import("net").Socket} [options.connect]
   * @param {Record<string, string | undefined>} [options.env]
   * @param {number} [options.approvalTimeoutMs] the first time, a person taps Allow on the phone
   * @param {() => {id: string, name: string}} [options.identity] this computer, as the phone knows it
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options = {}) {
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;

    this._env = options.env ?? process.env;
    this._adb = options.adb ?? makeAdb({ env: this._env });
    this._connect = options.connect ?? ((port) => net.connect(port, "127.0.0.1"));
    this._approvalTimeoutMs = options.approvalTimeoutMs ?? 130_000;
    this._identity = options.identity ?? hostIdentity;
    this._log = options.log ?? (() => {});
    this._socket = null;
    this._forward = null;
    this._buffer = "";
    this._closed = false;
    this.device = null;
  }

  async start() {
    const serial = await pickDevice(this._adb, this._env);
    const user = await currentUser(this._adb, serial);
    const socketName = `codedroid-mcp-${user}`;
    const port = Number((await this._adb(["-s", serial, "forward", "tcp:0", `localabstract:${socketName}`])).trim());
    if (!Number.isInteger(port) || port <= 0) throw new PhoneUnavailableError("adb forward did not return a port.");
    this._forward = { serial, port };
    this.device = { serial, user, socket: socketName };
    this._log(`Phone ${serial}, user ${user}: localabstract:${socketName} on tcp:${port}`);

    try {
      await this._handshake(port);
    } catch (e) {
      await this._removeForward();
      if (e instanceof PhoneUnavailableError && !e.diagnosed) {
        throw new PhoneUnavailableError(await diagnose(this._adb, serial, user));
      }
      throw e;
    }
    this._log("Approved by the phone");
  }

  _handshake(port) {
    return new Promise((resolve, reject) => {
      const socket = this._connect(port);
      this._socket = socket;
      let answered = false;
      const timer = setTimeout(() => {
        if (answered) return;
        answered = true;
        socket.destroy();
        const e = new PhoneUnavailableError(
          "The phone did not answer within " + Math.round(this._approvalTimeoutMs / 1000) + " s. If it asked " +
            "whether to allow this computer, tap Allow, then try again.",
        );
        e.diagnosed = true;
        reject(e);
      }, this._approvalTimeoutMs);

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        const { id, name } = this._identity();
        socket.write(
          JSON.stringify({
            type: "hello",
            proto: PROTOCOL,
            bridge: VERSION,
            host_id: id,
            host: name,
            platform: os.platform(),
            client: clientName(this._env),
          }) + "\n",
        );
      });
      socket.on("data", (chunk) => {
        this._buffer += chunk;
        let newline;
        while ((newline = this._buffer.indexOf("\n")) !== -1) {
          const line = this._buffer.slice(0, newline);
          this._buffer = this._buffer.slice(newline + 1);
          if (!line.trim()) continue;
          if (!answered) {
            answered = true;
            clearTimeout(timer);
            let reply;
            try {
              reply = JSON.parse(line);
            } catch (e) {
              socket.destroy();
              reject(new PhoneUnavailableError("The phone answered something other than a handshake; update codedroid-mcp."));
              return;
            }
            if (reply.type === "approved") {
              resolve();
            } else {
              socket.destroy();
              const denied = new PhoneDeniedError(reply.reason);
              reject(denied);
            }
            continue;
          }
          this._deliver(line);
        }
      });
      socket.on("error", (e) => {
        if (!answered) {
          answered = true;
          clearTimeout(timer);
          reject(new PhoneUnavailableError(e.message));
          return;
        }
        this.onerror?.(e);
      });
      socket.on("close", () => {
        if (!answered) {
          answered = true;
          clearTimeout(timer);
          reject(new PhoneUnavailableError("closed before answering"));
          return;
        }
        this._handleClosed();
      });
    });
  }

  _deliver(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      this.onerror?.(new Error(`Failed to parse a frame from the phone: ${e.message}`));
      return;
    }
    this.onmessage?.(message);
  }

  /** @param {import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage} message */
  async send(message) {
    const socket = this._socket;
    if (!socket || socket.destroyed) throw new Error("Phone connection is not open");
    await new Promise((resolve, reject) =>
      socket.write(JSON.stringify(message) + "\n", (e) => (e ? reject(e) : resolve())),
    );
  }

  async close() {
    this._socket?.destroy();
    await this._removeForward();
    this._handleClosed();
  }

  async _removeForward() {
    const forward = this._forward;
    this._forward = null;
    if (!forward) return;
    await this._adb(["-s", forward.serial, "forward", "--remove", `tcp:${forward.port}`]).catch(() => {});
  }

  _handleClosed() {
    if (this._closed) return;
    this._closed = true;
    this._removeForward();
    this.onclose?.();
  }
}
