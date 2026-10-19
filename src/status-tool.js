/**
 * codedroid_status — whether CodeDroid on the phone is connected, and if not, what to do about it.
 *
 * Served by the daemon itself, so it answers when the phone cannot: the one tool an agent can
 * call to learn that the app is not installed, its accessibility service is off, or the user
 * has not tapped Allow yet. Calling it also tries to connect again.
 */
import { VERSION } from "./version.js";

const DESCRIPTION =
  "Whether CodeDroid on the Android phone is connected to this computer (device serial, Android user), " +
  "and if not, why and how to fix it. Also retries the connection. Once connected it returns the phone's " +
  "instructions for driving it.";

/** @param {import("./daemon.js").PhoneManager} phoneManager */
export function createStatusTool(phoneManager) {
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
        device: phoneManager.device,
        ...(error ? { problem: error } : {}),
        // A session that opened before the phone connected never got these at its handshake.
        ...(client?.getInstructions() ? { instructions: client.getInstructions() } : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], isError: false };
    },
  };
}
