/**
 * The phones on this computer's adb, reached over adb itself instead of the CodeDroid server's
 * relay: no server, no sign-in, no network between, so an emulator or a phone on USB works with
 * nothing but CodeDroid on it.
 *
 *   1. LocalPhones lists `adb devices` and asks each one's CodeDroid where its local link listens
 *      (`device/status`, a provider only adb and the app can read): the phone's id, model, the
 *      abstract socket's name and a key. An app from before the local link says nothing of it.
 *   2. LocalPhoneTransport forwards a port to that socket (`adb forward tcp:0 localabstract:<name>`),
 *      writes the hello the relay would have built, and takes `approved` only with the same key: the
 *      key proves the socket is CodeDroid's, not another app's that took the name first.
 *   3. Then MCP: one JSON-RPC message per line, both ways.
 *
 * The phone accepts only adb's connections, and asks nobody: adb's own authorization is the consent.
 */
import net from "net";
import os from "os";
import { pairedDevice } from "./host.js";
import { adbRunner, parseDevices, parseProviderRow } from "./phone-setup.js";
import { PhoneDeniedError, PhoneUnavailableError } from "./relay-transport.js";
import { VERSION } from "./version.js";

const STATUS =
  "content query --user $(am get-current-user) --uri content://com.codedroid.agent/device/status";
/** How long a phone's answer to step 1 stands before LocalPhones asks again. */
export const PROBE_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Where [serial]'s CodeDroid listens for adb: {serial, id, model, socket, key}, or null when it does not. */
export async function probe(adb, serial) {
  const status = parseProviderRow(await adb(["shell", STATUS], { serial, timeout: PROBE_TIMEOUT_MS }));
  const { socket, key } = status?.local ?? {};
  if (!status?.deviceId || !socket || !key) return null;
  return { serial, id: String(status.deviceId), model: status.metadata?.model_name ?? null, socket, key };
}

/** A phone found on adb, as a pairing entry (host.js): no server and no token, only its serial. */
export function localHost(phone) {
  return { local: true, server: null, host_id: null, token: null, device: { id: phone.id, model: phone.model }, serial: phone.serial };
}

/**
 * [hosts] with the phones on adb: an entry for a phone also on adb gets its serial, and a phone
 * only on adb is added.
 */
export function withLocal(hosts, phones) {
  const left = new Map(phones.map((p) => [p.id, p]));
  const merged = hosts.map((host) => {
    const phone = left.get(String(host.device?.id));
    if (!phone) return host;
    left.delete(phone.id);
    return { ...host, serial: phone.serial };
  });
  return [...merged, ...[...left.values()].map(localHost)];
}

/** The phones on this computer's adb whose CodeDroid has a local link, kept by scan(). */
export class LocalPhones {
  constructor({ adb = adbRunner(), now = Date.now, log = () => {} } = {}) {
    this._adb = adb;
    this._now = now;
    this._log = log;
    /** serial → {phone, at}: the last answer to probe, null for no local link. */
    this._probed = new Map();
    this._scanning = null;
  }

  /** The adb it reads, for the transports to the phones it found. */
  get adb() {
    return this._adb;
  }

  /** The phones as last scanned. */
  phones() {
    return [...this._probed.values()].map((p) => p.phone).filter(Boolean);
  }

  /** The serial of phone [id] on adb, or undefined. */
  serialOf(id) {
    return this.phones().find((p) => p.id === String(id))?.serial;
  }

  /** Reads adb again (one scan at a time); never throws: no adb is no phone. */
  scan() {
    this._scanning ??= this._scan().finally(() => {
      this._scanning = null;
    });
    return this._scanning;
  }

  async _scan() {
    let serials;
    try {
      serials = parseDevices(await this._adb(["devices"], { timeout: PROBE_TIMEOUT_MS }))
        .filter(([, state]) => state === "device")
        .map(([serial]) => serial);
    } catch (e) {
      serials = [];
    }
    for (const serial of this._probed.keys()) if (!serials.includes(serial)) this._probed.delete(serial);
    await Promise.all(
      serials.map(async (serial) => {
        const last = this._probed.get(serial);
        if (last && this._now() - last.at < PROBE_MS) return;
        let phone = null;
        try {
          phone = await probe(this._adb, serial);
        } catch (e) {
          // Gone or wedged: no local link until the next probe.
        }
        if (phone && !last?.phone) this._log(`${phone.model ?? serial} is on adb (${serial}): reached over adb`);
        this._probed.set(serial, { phone, at: this._now() });
      }),
    );
    return this.phones();
  }
}

/** An MCP SDK `Transport` to CodeDroid on the phone [serial], over adb. start() may be called more than once. */
export class LocalPhoneTransport {
  /**
   * @param {object} options
   * @param {string} options.serial
   * @param {string} options.hostId  this computer, as the phone's holds and Stop name it
   * @param {(args: string[], opts?: object) => Promise<string>} [options.adb]
   * @param {Record<string, string | undefined>} [options.env]
   * @param {(msg: string) => void} [options.log]
   */
  constructor({ serial, hostId, adb = adbRunner(), env = process.env, log = () => {} }) {
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
    this.device = null;
    this._serial = serial;
    this._hostId = hostId;
    this._adb = adb;
    this._env = env;
    this._log = log;
    this._socket = null;
    this._port = null;
    this._open = false;
    this._closed = false;
    this._started = null;
  }

  start() {
    this._started ??= this._start();
    return this._started;
  }

  async _start() {
    const phone = await probe(this._adb, this._serial).catch(() => null);
    if (!phone) throw new PhoneUnavailableError(`CodeDroid on ${this._serial} is not listening for adb: update it, and check that its Accessibility is on.`);
    const forwarded = await this._adb(["forward", "tcp:0", `localabstract:${phone.socket}`], { serial: this._serial, timeout: PROBE_TIMEOUT_MS });
    const port = /^(\d+)\s*$/m.exec(forwarded)?.[1];
    if (!port) throw new PhoneUnavailableError(`adb could not forward to ${this._serial}: ${forwarded.trim()}`);
    this._port = port;
    this.device = { ...pairedDevice(localHost(phone)), adb: this._serial };
    try {
      await this._handshake(Number(port), phone.key);
    } catch (e) {
      this._unforward();
      throw e;
    }
    this._log(`Connected over adb (${this._serial})`);
  }

  _handshake(port, key) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      this._socket = socket;
      let pending = true;
      let buffered = "";
      const settle = (error) => {
        if (!pending) return;
        pending = false;
        clearTimeout(timer);
        if (!error) {
          this._open = true;
          return resolve();
        }
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => settle(new PhoneUnavailableError(`CodeDroid on ${this._serial} did not answer over adb.`)), HANDSHAKE_TIMEOUT_MS);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        const hello = {
          type: "hello",
          host_id: this._hostId,
          host: os.hostname(),
          client: this._env.CODEDROID_MCP_CLIENT?.trim() ?? "",
          platform: os.platform(),
          bridge: VERSION,
        };
        socket.write(`${JSON.stringify(hello)}\n`);
      });
      socket.on("data", (chunk) => {
        buffered += chunk;
        let end;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (this._open) {
            this._deliver(line);
            continue;
          }
          if (!pending) return;
          let reply = null;
          try {
            reply = JSON.parse(line);
          } catch (e) {
            // Not a handshake answer: refused below.
          }
          if (reply?.type === "approved" && reply.key === key) settle(null);
          else if (reply?.type === "denied") settle(new PhoneDeniedError(reply.reason));
          else settle(new PhoneUnavailableError(`Something other than CodeDroid answered on ${this._serial}'s local link.`));
        }
      });
      socket.on("error", (e) => {
        if (this._open) this.onerror?.(e);
        else settle(new PhoneUnavailableError(`Could not reach CodeDroid on ${this._serial} over adb: ${e.message}`));
      });
      socket.on("close", () => {
        if (this._open) return void this._handleClosed();
        settle(new PhoneUnavailableError(`CodeDroid on ${this._serial} closed its local link before answering. Check that its Accessibility is on.`));
      });
    });
  }

  _deliver(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      this.onerror?.(new Error(`Failed to parse a line from the phone: ${e.message}`));
      return;
    }
    this.onmessage?.(message);
  }

  /** @param {import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage} message */
  async send(message) {
    const socket = this._socket;
    if (!this._open || socket.destroyed) throw new Error("Phone connection is not open");
    await new Promise((resolve, reject) => socket.write(`${JSON.stringify(message)}\n`, (e) => (e ? reject(e) : resolve())));
  }

  async close() {
    this._socket?.end();
    this._handleClosed();
  }

  _handleClosed() {
    if (this._closed) return;
    this._closed = true;
    this._open = false;
    this._socket?.destroy();
    this._unforward();
    this.onclose?.();
  }

  _unforward() {
    const port = this._port;
    this._port = null;
    if (port) this._adb(["forward", "--remove", `tcp:${port}`], { serial: this._serial }).catch(() => {});
  }
}
