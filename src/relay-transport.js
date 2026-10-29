/**
 * RelayPhoneTransport — an MCP SDK `Transport` to CodeDroid on the phone, through the CodeDroid
 * server's relay.
 *
 *   1. Read the pairing it is for (host.js): the server, the host token, the phone.
 *   2. Open ws(s)://<server>/v1/mcp/connect with the token, plus X-CodeDroid-Client and
 *      X-CodeDroid-Bridge, from which the server builds the phone's hello. The phone keeps its own
 *      socket to the server, so neither side needs the other's address.
 *   3. The first frame is the answer: {type:"approved"} (after the user taps Allow, the first time),
 *      {type:"denied", reason}, or, from the server, {type:"unavailable", reason}.
 *   4. Then MCP: one JSON-RPC message per text frame, both ways.
 *
 * A library: failures surface through start() rejecting or onclose/onerror, never process.exit().
 */
import WebSocket from "ws";
import { PAIRING_STEPS, pairedDevice, readHosts } from "./host.js";
import { VERSION } from "./version.js";

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

/** The relay's WebSocket URL for a normalized [server] (host.js): https → wss, http → ws. */
export function connectUrl(server) {
  const url = new URL(`${server}/v1/mcp/connect`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** A socket error's reason. Node leaves the message empty when every address failed (localhost: ::1 and 127.0.0.1). */
function errorText(e) {
  return e.message || e.errors?.map((inner) => inner.message).join("; ") || e.code || String(e);
}

export class RelayPhoneTransport {
  /**
   * @param {object} [options]
   * @param {Record<string, string | undefined>} [options.env]
   * @param {number} [options.approvalTimeoutMs] the first time, a person taps Allow on the phone
   * @param {() => {server: string, host_id: string, token: string, device: {id: string, model: string | null}} | null} [options.host]
   *   the pairing to connect through, null when there is none; this computer's first by default
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options = {}) {
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
    this.device = null;

    this._env = options.env ?? process.env;
    this._approvalTimeoutMs = options.approvalTimeoutMs ?? 130_000;
    this._host = options.host ?? (() => readHosts()[0] ?? null);
    this._log = options.log ?? (() => {});
    this._ws = null;
    this._open = false;
    this._closed = false;
  }

  async start() {
    const host = this._host();
    if (!host) throw new PhoneUnavailableError(`This computer is not paired with a phone. ${PAIRING_STEPS}`);
    this.device = pairedDevice(host);
    this._log(`Phone ${host.device?.id} (${host.device?.model ?? "unknown model"}) through ${host.server}`);
    await this._handshake(host);
    this._log("Approved by the phone");
  }

  _handshake(host) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(connectUrl(host.server), {
        headers: {
          Authorization: `Bearer ${host.token}`,
          // Only what the user set: one daemon serves every MCP client here, so a guess from its
          // environment would name whichever client happened to start it.
          "X-CodeDroid-Client": this._env.CODEDROID_MCP_CLIENT?.trim() ?? "",
          "X-CodeDroid-Bridge": VERSION,
        },
      });
      this._ws = ws;

      // Settles the handshake once: resolves without an error, otherwise drops the socket.
      let pending = true;
      const settle = (error) => {
        if (!pending) return;
        pending = false;
        clearTimeout(timer);
        if (!error) {
          // Before resolving: a frame right behind the answer is already the phone's.
          this._open = true;
          resolve();
          return;
        }
        ws.terminate();
        reject(error);
      };
      const timer = setTimeout(
        () =>
          settle(
            new PhoneUnavailableError(
              `The phone did not answer within ${Math.round(this._approvalTimeoutMs / 1000)} s. If it asked ` +
                "whether to allow this computer, tap Allow, then try again.",
            ),
          ),
        this._approvalTimeoutMs,
      );

      ws.on("unexpected-response", (req, res) => {
        res.resume();
        settle(
          new PhoneUnavailableError(
            res.statusCode === 401 || res.statusCode === 403
              ? `This computer's pairing was removed or is no longer valid. Pair it again. ${PAIRING_STEPS}`
              : `The CodeDroid server at ${host.server} refused the connection (HTTP ${res.statusCode}).`,
          ),
        );
      });
      ws.on("message", (data) => {
        const line = data.toString("utf8");
        if (this._open) return void this._deliver(line);
        if (!pending) return;
        let reply = null;
        try {
          reply = JSON.parse(line);
        } catch (e) {
          // Not a handshake answer: refused below.
        }
        if (reply?.type === "approved") settle(null);
        else if (reply?.type === "denied") settle(new PhoneDeniedError(reply.reason));
        else if (reply?.type === "unavailable") {
          settle(new PhoneUnavailableError(reply.reason || "The phone is not connected to CodeDroid."));
        } else {
          settle(new PhoneUnavailableError("The phone answered something other than a handshake; update codedroid-mcp."));
        }
      });
      ws.on("error", (e) => {
        if (this._open) this.onerror?.(e);
        else settle(new PhoneUnavailableError(`Could not reach the CodeDroid server at ${host.server}: ${errorText(e)}`));
      });
      ws.on("close", () => {
        if (this._open) return void this._handleClosed();
        settle(
          new PhoneUnavailableError(
            "The CodeDroid server closed the connection before the phone answered. Check that CodeDroid is open " +
              "on the phone and online, then try again.",
          ),
        );
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
    const ws = this._ws;
    if (!this._open || ws.readyState !== WebSocket.OPEN) throw new Error("Phone connection is not open");
    await new Promise((resolve, reject) => ws.send(JSON.stringify(message), (e) => (e ? reject(e) : resolve())));
  }

  async close() {
    this._ws?.close(1000);
    this._handleClosed();
  }

  _handleClosed() {
    if (this._closed) return;
    this._closed = true;
    this._open = false;
    this.onclose?.();
  }
}
