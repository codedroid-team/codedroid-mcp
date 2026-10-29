/**
 * proxy-core — builds an MCP Server that transparently forwards requests to a
 * backend MCP Client (the single phone connection).
 *
 * A session still opens when the phone cannot be reached, serving the local tools
 * (adb, codedroid_status) and saying why in its instructions. tools/list keeps
 * trying the phone.
 *
 * Used twice:
 *   - daemon: one proxy Server per HTTP client session → phone client
 *   - stdio shim: one proxy Server on stdio → daemon client
 *
 * The proxy advertises exactly the backend's capabilities and instructions,
 * so downstream agents get the same tool context at handshake as a direct
 * connection would give them.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  CompleteResultSchema,
  EmptyResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** Device tools drive a real screen — give them a generous budget and let
 *  progress notifications keep the clock alive. */
const CALL_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Phone tools that never touch the screen, so need not wait behind the calls that do: get_task
 * alone can wait 55 s for a task, and holding cancel_task behind it would defeat the point.
 */
export const UNQUEUED_TOOLS = new Set(["get_task", "cancel_task", "device_info"]);

/** The request never reached the phone: the link was already down when it was sent. */
const NEVER_SENT = /not open|not connected/i;
/** The link dropped with the request in flight: it may or may not have run. */
const DROPPED = /connection closed/i;

/** A request that could not be sent to any phone; its message says why, for the model to read. */
export class RoutingError extends Error {
  constructor(message) {
    super(message);
    this.name = "RoutingError";
  }
}

/** [promise]'s value, or null if it takes longer than [ms]; its rejection still rejects. */
export function within(promise, ms) {
  if (!Number.isFinite(ms)) return promise;
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * @param {object} options
 * @param {() => Promise<import("@modelcontextprotocol/sdk/client/index.js").Client>} options.getClient
 *   Resolves the live backend client (reconnecting if needed). Called per
 *   request so a phone reconnect is picked up transparently.
 * @param {() => Promise<import("@modelcontextprotocol/sdk/client/index.js").Client>} [options.connect]
 *   What the session waits on as it opens, for the backend's capabilities and instructions;
 *   getClient by default.
 * @param {(fn: () => Promise<any>) => Promise<any>} [options.runExclusive]
 *   Serializer for tool calls — there is one physical screen, so concurrent
 *   tool calls from different sessions must queue, not interleave.
 * @param {() => void} [options.onBackendAlive]
 *   Called after every successful backend round-trip — lets the connection
 *   manager treat real traffic as proof of liveness (fewer health pings).
 * @param {string} options.name
 * @param {string} options.version
 * @param {Array<{definition: object, handler: (args: object) => Promise<object>, instructions?: string}>} [options.localTools]
 *   Tools served entirely by THIS process — never forwarded to the phone.
 *   Merged into tools/list alongside the backend's tools; tools/call for one
 *   of these names short-circuits before touching the phone connection at
 *   all. Used for machine-local capabilities (e.g. `adb`) that make no
 *   sense to relay over the WebRTC link. Pass only where the tool should
 *   actually execute (the daemon — see daemon.js); the stdio shim leaves this
 *   empty and transparently forwards such calls through to the daemon.
 *   An optional `instructions` string on a local tool is appended to the
 *   backend's handshake instructions, since the backend cannot describe a tool
 *   it never sees.
 * @param {number} [options.connectWaitMs] how long a new session waits for the backend before
 *   opening with the local tools alone
 * @param {number} [options.listWaitMs] in such a session, how long tools/list waits for it
 */
export async function buildProxyServer({
  getClient,
  connect = getClient,
  runExclusive = (fn) => fn(),
  onBackendAlive = () => {},
  name,
  version,
  localTools = [],
  connectWaitMs = Infinity,
  listWaitMs = connectWaitMs,
}) {
  const localToolsByName = new Map(localTools.map((t) => [t.definition.name, t]));
  let backend = null;
  let backendError = null;
  try {
    // The first connect can wait on a person tapping Allow on the phone, longer than clients
    // wait for a server to start: past connectWaitMs the session opens without the phone, and
    // the daemon announces its tools (tools/list_changed) once it connects.
    backend = await within(connect(), connectWaitMs);
    if (!backend) throw new Error("Waiting for the phone: if it asks whether to allow this computer, tap Allow.");
  } catch (e) {
    // With nothing of our own to serve, a session without the phone is no session.
    if (localToolsByName.size === 0) throw e;
    backendError = e;
  }
  const backendCaps = backend?.getServerCapabilities() ?? {};

  // Local tools are invisible to the phone, so the phone's instructions can't
  // mention them. Append their own guidance after it — a tool description is
  // only read once a model is already picking a tool, whereas instructions
  // shape strategy before the first call. Phone text stays first and unedited:
  // it owns the safety doctrine, and these sections defer to it.
  const unreachable = backendError
    ? `CodeDroid on the phone is not connected yet: ${String(backendError.message).split("\n")[0]} ` +
      "Call codedroid_status for what to do; once it connects, its tools appear and codedroid_status " +
      "returns the phone's own instructions: read them before driving the phone."
    : null;
  const instructions = [
    backend?.getInstructions() ?? unreachable,
    ...[...localToolsByName.values()].map((t) => t.instructions).filter(Boolean),
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim() || undefined;

  // Only advertise what we actually forward (and what the phone declared).
  const capabilities = {};
  if (backendCaps.tools || localToolsByName.size > 0) {
    // listChanged: the phone's tools can arrive after the session opened (see connectWaitMs).
    capabilities.tools = { ...(backendCaps.tools ?? {}), listChanged: localToolsByName.size > 0 || !!backendCaps.tools?.listChanged };
  }
  if (backendCaps.prompts) capabilities.prompts = backendCaps.prompts;
  if (backendCaps.resources) capabilities.resources = backendCaps.resources;
  if (backendCaps.logging) capabilities.logging = backendCaps.logging;
  if (backendCaps.completions) capabilities.completions = backendCaps.completions;

  const server = new Server({ name, version }, { capabilities, instructions });

  const forward = (requestSchema, resultSchema, options = {}) => {
    server.setRequestHandler(requestSchema, async (request) => {
      const call = async () => {
        const client = await getClient();
        return client.request(
          { method: request.method, params: request.params },
          resultSchema,
          {
            timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
            resetTimeoutOnProgress: true,
          },
        );
      };
      const run = () => (options.exclusive ? runExclusive(call) : call());
      let result;
      try {
        result = await run();
      } catch (e) {
        // "Connection closed" = the request never completed against a link
        // that is now provably dead; getClient() will reconnect. Retry once —
        // but never for tool calls: a lost RESPONSE still moved real pixels,
        // and replaying a tap is worse than surfacing the error.
        const message = e?.message ?? "";
        if (!(NEVER_SENT.test(message) || DROPPED.test(message)) || options.exclusive) throw e;
        result = await run();
      }
      onBackendAlive();
      return result;
    });
  };

  if (backendCaps.tools || localToolsByName.size > 0) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const backendResult = backendCaps.tools || backendError
        ? await (async () => {
            // A session that opened without the phone does not wait on it here either: the
            // phone's tools follow in a tools/list_changed once it connects.
            const client = backendError ? await within(getClient(), listWaitMs) : await getClient();
            if (!client) return { tools: [] };
            const result = await client.request(
              { method: request.method, params: request.params },
              ListToolsResultSchema,
              { timeout: DEFAULT_TIMEOUT_MS, resetTimeoutOnProgress: true },
            );
            onBackendAlive();
            return result;
          })().catch((e) => {
            // Without local tools a failed list is the client's to see.
            if (localToolsByName.size === 0) throw e;
            return { tools: [] };
          })
        : { tools: [] };
      return {
        ...backendResult,
        tools: [
          ...backendResult.tools,
          ...[...localToolsByName.values()].map((t) => t.definition),
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Local tools never touch the phone connection — no need for the
      // exclusive queue, which exists only to serialize against the one
      // physical screen.
      const local = localToolsByName.get(request.params.name);
      if (local) return local.handler(request.params.arguments ?? {});

      // A failure comes back as a tool error, not a protocol one, so the model reads why. Only a
      // call that never left is tried again: a tap whose answer was lost still happened, and
      // replaying it is worse than saying so.
      const call = async () => {
        let client;
        try {
          client = await getClient();
        } catch (e) {
          return { unreachable: e };
        }
        return client.request(
          { method: request.method, params: request.params },
          CallToolResultSchema,
          { timeout: CALL_TOOL_TIMEOUT_MS, resetTimeoutOnProgress: true },
        );
      };
      const name = request.params.name;
      const run = UNQUEUED_TOOLS.has(name) ? call : () => runExclusive(call);
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await run();
          break;
        } catch (e) {
          if (e instanceof RoutingError) return toolError(e.message);
          const message = e?.message ?? String(e);
          if (NEVER_SENT.test(message) && attempt === 0) continue;
          if (NEVER_SENT.test(message)) return toolError(`CodeDroid on the phone is not connected: ${message} Call codedroid_status.`);
          return toolError(
            `The link to the phone failed during ${name} (${message}). It may or may not have happened on the ` +
              "phone: read the screen with get_screen before trying again. If calls keep failing, call codedroid_status.",
          );
        }
      }
      if (result.unreachable) {
        return toolError(`CodeDroid on the phone is not connected: ${result.unreachable.message}\nCall codedroid_status once it is fixed.`);
      }
      onBackendAlive();
      return result;
    });
  }
  if (backendCaps.prompts) {
    forward(ListPromptsRequestSchema, ListPromptsResultSchema);
    forward(GetPromptRequestSchema, GetPromptResultSchema);
  }
  if (backendCaps.resources) {
    forward(ListResourcesRequestSchema, ListResourcesResultSchema);
    forward(ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema);
    forward(ReadResourceRequestSchema, ReadResourceResultSchema);
  }
  if (backendCaps.completions) {
    forward(CompleteRequestSchema, CompleteResultSchema);
  }
  if (backendCaps.logging) {
    forward(SetLevelRequestSchema, EmptyResultSchema);
  }

  return server;
}

/**
 * Forward a notification from the backend to a set of live proxy servers.
 * Sessions that can't take it (closing, capability mismatch) are skipped —
 * a notification must never take a session down.
 */
export async function broadcastNotification(servers, notification) {
  for (const server of servers) {
    try {
      await server.notification(notification);
    } catch (e) {
      // Best-effort fan-out.
    }
  }
}
