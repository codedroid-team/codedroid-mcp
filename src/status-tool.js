/**
 * codedroid_status — whether CodeDroid on the phone is connected, and if not, what to do about it.
 *
 * Served by the daemon itself, so it answers when the phone cannot: the one tool an agent can
 * call to learn that this computer is not paired, the phone is offline, or the user has not
 * tapped Allow yet. Calling it also tries to connect again.
 */
import { pairedDevice, readHost } from "./host.js";
import { VERSION } from "./version.js";

const DESCRIPTION =
  "Whether CodeDroid on the Android phone is connected to this computer (the phone's device id and model, " +
  "the CodeDroid server), and if not, why and how to fix it. Also retries the connection. Once connected " +
  "it returns the phone's instructions for driving it.";

/**
 * @param {import("./daemon.js").PhoneManager} phoneManager
 * @param {{host?: () => object | null}} [deps] this computer's pairing, for the phone it points at
 */
export function createStatusTool(phoneManager, { host = readHost } = {}) {
  return {
    definition: {
      name: "codedroid_status",
      title: "CodeDroid connection",
      description: DESCRIPTION,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async handler() {
      let error = null;
      let client = null;
      try {
        client = await phoneManager.getClient();
      } catch (e) {
        error = e.message;
      }
      const status = {
        connected: !error,
        bridge: VERSION,
        // Not connected: the phone this computer is paired with now, which a new pairing may have changed.
        device: client ? phoneManager.device : pairedDevice(host()),
        ...(error ? { problem: error } : {}),
        // A session that opened before the phone connected never got these at its handshake.
        ...(client?.getInstructions() ? { instructions: client.getInstructions() } : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], isError: false };
    },
  };
}
