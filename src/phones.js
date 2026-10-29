/**
 * Phones — every phone this computer is paired with, served to the daemon's sessions as one MCP
 * backend (the client proxy-core forwards to).
 *
 * Each pairing has its own PhoneManager: its own link, reconnects and screen queue, so phones
 * connect and drop independently and calls to different phones run side by side. host.json is
 * read again on every request, so pair and unpair take effect without restarting the daemon.
 *
 * Lists (tools, prompts, resources) merge what every connected phone answers. Anything else goes
 * to one phone, named by the `device` argument added to each phone tool and prompt, or by
 * `?device=<id>` on a resource URI. With one phone paired, naming it is optional.
 */
import { PAIRING_STEPS, describeHost, deviceKey, findHost } from "./host.js";
import { RoutingError, UNQUEUED_TOOLS, within } from "./proxy-core.js";

export const DEVICE_SCHEMA = {
  type: "string",
  description:
    "Which paired phone runs this: its id, or its model or part of it, as codedroid_devices lists them. " +
    "Required when several phones are paired.",
};

const MULTI_PHONE_INSTRUCTIONS =
  "Several phones are paired: pass `device` (an id or model from codedroid_devices) on every phone tool call. " +
  "Each phone has its own screen, tasks and task ids.";

/** List methods, and the field of their result that holds the items. */
const MERGED_LISTS = {
  "tools/list": "tools",
  "prompts/list": "prompts",
  "resources/list": "resources",
  "resources/templates/list": "resourceTemplates",
};

/** [uri] naming one phone: `device=<key>` as its last query parameter, which unqualify strips. */
function qualify(uri, key) {
  return `${uri}${uri.includes("?") ? "&" : "?"}device=${encodeURIComponent(key)}`;
}

/** {uri, device} of a URI qualify made; device is undefined for any other URI. */
function unqualify(uri) {
  const match = /[?&]device=([^&#]*)$/.exec(uri ?? "");
  return match ? { uri: uri.slice(0, match.index), device: decodeURIComponent(match[1]) } : { uri, device: undefined };
}

/** The phone a request names, and the request as that phone expects it. */
function unwrap(method, params = {}) {
  if (method === "tools/call" || method === "prompts/get") {
    const { device, ...rest } = params.arguments ?? {};
    return { device, params: { ...params, arguments: rest } };
  }
  if (method === "completion/complete") {
    if (params.ref?.uri === undefined) return { device: undefined, params };
    const { uri, device } = unqualify(params.ref.uri);
    return { device, params: { ...params, ref: { ...params.ref, uri } } };
  }
  if (params.uri === undefined) return { device: undefined, params };
  const { uri, device } = unqualify(params.uri);
  return { device, params: { ...params, uri } };
}

export class Phones {
  /**
   * @param {object} options
   * @param {() => object[]} options.pairings this computer's pairings (host.js readHosts)
   * @param {(pairing: object) => import("./daemon.js").PhoneManager} options.createManager
   * @param {number} [options.listWaitMs] how long a list waits on a phone that is not connected
   */
  constructor({ pairings, createManager, listWaitMs = 2_000 }) {
    this._pairings = pairings;
    this._createManager = createManager;
    this._listWaitMs = listWaitMs;
    /** deviceKey → {pairing, manager}, in pairing order. */
    this._entries = new Map();
    this._closed = false;
    /** Set by the daemon to fan phone notifications out to sessions. */
    this.onNotification = null;
    /** Set by the daemon: a phone (re)connected, so its tools may be new to a session. */
    this.onConnected = null;
  }

  /** Brings the managers in line with host.json: one per pairing, closing those of removed or replaced pairings. */
  sync() {
    if (this._closed) return [];
    const current = new Set();
    for (const pairing of this._pairings()) {
      const key = deviceKey(pairing);
      current.add(key);
      const entry = this._entries.get(key);
      if (entry?.pairing.token === pairing.token && entry.pairing.server === pairing.server) continue;
      entry?.manager.close();
      const manager = this._createManager(pairing);
      manager.onNotification = (notification) => this.onNotification?.(this._fromPhone(key, notification));
      manager.onConnected = () => this.onConnected?.();
      this._entries.set(key, { pairing, manager });
    }
    for (const [key, entry] of this._entries) {
      if (current.has(key)) continue;
      this._entries.delete(key);
      entry.manager.close();
    }
    return [...this._entries.values()];
  }

  /** The phones [selector] names (host.js findHost), or every paired phone without one. */
  select(selector) {
    const entries = this.sync();
    if (!selector) return entries;
    return [this._entries.get(deviceKey(findHost(entries.map((e) => e.pairing), selector)))];
  }

  /** {paired, connected} counts, and one state for them all as /health shows it. */
  summary() {
    const states = this.sync().map((e) => e.manager.state);
    const state = ["connected", "connecting"].find((s) => states.includes(s)) ?? "disconnected";
    return { state, paired: states.length, connected: states.filter((s) => s === "connected").length };
  }

  /** What a new session waits on: resolves once any phone is connected, rejects when none can be. */
  async connect() {
    const entries = this.sync();
    if (!entries.length) throw new Error(`This computer is not paired with a phone. ${PAIRING_STEPS}`);
    try {
      await Promise.any(entries.map((e) => e.manager.getClient()));
    } catch (e) {
      if (entries.length === 1) throw e.errors[0];
      throw new Error(e.errors.map((err, i) => `${describeHost(entries[i].pairing)}: ${err.message}`).join(" "));
    }
    return this;
  }

  _connected() {
    return [...this._entries.values()].filter((e) => e.manager.current);
  }

  getServerCapabilities() {
    return Object.assign({}, ...this._connected().map((e) => e.manager.current.getServerCapabilities() ?? {}));
  }

  getInstructions() {
    const instructions = this._connected()[0]?.manager.current.getInstructions();
    return instructions && this._entries.size > 1 ? `${instructions}\n\n${MULTI_PHONE_INSTRUCTIONS}` : instructions;
  }

  /** proxy-core's Client.request: a merged list, or one phone's answer. */
  async request(request, resultSchema, options) {
    const entries = this.sync();
    const { method } = request;
    const field = MERGED_LISTS[method];
    if (field) return { [field]: this._merge(method, field, await this._gather(entries, request, resultSchema, options)) };
    if (method === "logging/setLevel") {
      await this._gather(entries, request, resultSchema, options);
      return {};
    }

    const { device, params } = unwrap(method, request.params);
    const entry = this._target(entries, device);
    const send = async () => {
      let client;
      try {
        client = await entry.manager.getClient();
      } catch (e) {
        const which = entries.length > 1 ? describeHost(entry.pairing) : "the phone";
        throw new RoutingError(`CodeDroid on ${which} is not connected: ${e.message}\nCall codedroid_status once it is fixed.`);
      }
      const result = await client.request({ method, params }, resultSchema, options);
      entry.manager.markAlive();
      return result;
    };
    // One queue per screen: calls to different phones do not wait on each other.
    const queued = method === "tools/call" && !UNQUEUED_TOOLS.has(params.name);
    return queued ? entry.manager.runExclusive(send) : send();
  }

  /** The phone a request goes to: the one [device] names, or the only one paired. */
  _target(entries, device) {
    if (device) {
      try {
        return this._entries.get(deviceKey(findHost(entries.map((e) => e.pairing), device)));
      } catch (e) {
        throw new RoutingError(e.message);
      }
    }
    if (entries.length === 1) return entries[0];
    if (!entries.length) {
      throw new RoutingError(`CodeDroid on the phone is not connected: this computer is not paired with a phone. ${PAIRING_STEPS}`);
    }
    throw new RoutingError(
      `${entries.length} phones are paired; say which with the device argument (an id or model): ` +
        `${entries.map((e) => describeHost(e.pairing)).join(", ")}.`,
    );
  }

  /** Every phone's answer to a list request, from those connected within listWaitMs. */
  async _gather(entries, request, resultSchema, options) {
    const outcomes = await Promise.all(
      entries.map(async (entry) => {
        try {
          const client = await within(entry.manager.getClient(), this._listWaitMs);
          if (!client) return null;
          const result = await client.request(request, resultSchema, options);
          entry.manager.markAlive();
          return { entry, result };
        } catch (error) {
          return { error };
        }
      }),
    );
    const answers = outcomes.filter((o) => o?.result);
    const failure = outcomes.find((o) => o?.error);
    if (!answers.length && failure) throw failure.error;
    return answers;
  }

  /** One list from every phone's: tools and prompts once each, taking `device`; resources per phone when there are several. */
  _merge(method, field, answers) {
    const several = this._entries.size > 1;
    const items = new Map();
    for (const { entry, result } of answers) {
      const key = deviceKey(entry.pairing);
      for (const item of result[field] ?? []) {
        let shaped = item;
        if (method === "tools/list") {
          const schema = item.inputSchema ?? { type: "object" };
          shaped = { ...item, inputSchema: { ...schema, properties: { ...schema.properties, device: DEVICE_SCHEMA } } };
        } else if (method === "prompts/list") {
          shaped = { ...item, arguments: [...(item.arguments ?? []), { name: "device", description: DEVICE_SCHEMA.description }] };
        } else if (several) {
          const name = `${item.name} (${entry.pairing.device?.model ?? key})`;
          shaped = item.uri ? { ...item, name, uri: qualify(item.uri, key) } : { ...item, name, uriTemplate: qualify(item.uriTemplate, key) };
        }
        const id = shaped.uri ?? shaped.uriTemplate ?? shaped.name;
        if (!items.has(id)) items.set(id, shaped);
      }
    }
    return [...items.values()];
  }

  /** A phone's notification as sessions see it: a resource it names carries which phone. */
  _fromPhone(key, notification) {
    if (notification.method !== "notifications/resources/updated" || this._entries.size < 2) return notification;
    return { ...notification, params: { ...notification.params, uri: qualify(notification.params.uri, key) } };
  }

  async close() {
    this._closed = true;
    const entries = [...this._entries.values()];
    this._entries.clear();
    await Promise.all(entries.map((e) => e.manager.close()));
  }
}
