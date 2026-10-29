/**
 * The daemon's own tools about the phones, served when no phone can answer:
 *
 *   codedroid_devices — the paired phones and how each link stands now; instant, never connects.
 *   codedroid_status  — connects to each paired phone, then says which are connected and, if not,
 *                       what to do about it (not paired, offline, waiting on Allow).
 */
import { PAIRING_STEPS, describeHost, pairedDevice } from "./host.js";
import { DEVICE_SCHEMA } from "./phones.js";
import { VERSION } from "./version.js";

const DESCRIPTION =
  "Which Android phones are paired with this computer (each one's device id, model and CodeDroid server), " +
  "whether CodeDroid on each is connected, and if not, why and how to fix it. Also retries the connection. " +
  "Once connected it returns the phones' instructions for driving them. Pass device for one phone alone.";

const statusResult = (status) => ({ content: [{ type: "text", text: JSON.stringify(status, null, 2) }], isError: false });

const DEVICES_DESCRIPTION =
  "List the Android phones paired with this computer: each one's id and model (what phone tools take as " +
  "device), its CodeDroid server, and its link now: connected, connecting or disconnected, with the last " +
  "problem. Instant; it does not connect. codedroid_status connects and says how to fix a problem.";

/** @param {import("./phones.js").Phones} phones */
export function createDevicesTool(phones) {
  return {
    definition: {
      name: "codedroid_devices",
      title: "Paired phones",
      description: DEVICES_DESCRIPTION,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async handler() {
      const devices = phones.select().map(({ pairing, manager }) => ({
        ...pairedDevice(pairing),
        state: manager.state,
        ...(manager.state !== "connected" && manager.lastError ? { problem: manager.lastError } : {}),
      }));
      return statusResult({
        devices,
        ...(devices.length ? {} : { problem: `This computer is not paired with a phone. ${PAIRING_STEPS}` }),
      });
    },
  };
}

/** @param {import("./phones.js").Phones} phones */
export function createStatusTool(phones) {
  return {
    definition: {
      name: "codedroid_status",
      title: "CodeDroid connection",
      description: DESCRIPTION,
      inputSchema: { type: "object", properties: { device: DEVICE_SCHEMA } },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async handler({ device } = {}) {
      let entries;
      try {
        entries = phones.select(device);
      } catch (e) {
        return statusResult({ connected: false, bridge: VERSION, devices: [], problem: e.message });
      }
      const devices = await Promise.all(
        entries.map(async ({ pairing, manager }) => {
          try {
            await manager.getClient();
            return { ...pairedDevice(pairing), connected: true };
          } catch (e) {
            return { ...pairedDevice(pairing), connected: false, problem: e.message };
          }
        }),
      );
      const problem = entries.length
        ? devices
            .map((d, i) => d.problem && (devices.length > 1 ? `${describeHost(entries[i].pairing)}: ${d.problem}` : d.problem))
            .filter(Boolean)
            .join(" ")
        : `This computer is not paired with a phone. ${PAIRING_STEPS}`;
      // A session that opened before a phone connected never got these at its handshake.
      const instructions = phones.getInstructions();
      return statusResult({
        connected: devices.length > 0 && devices.every((d) => d.connected),
        bridge: VERSION,
        ...(devices.length === 1 ? { device: pairedDevice(entries[0].pairing) } : {}),
        devices,
        ...(problem ? { problem } : {}),
        ...(instructions ? { instructions } : {}),
      });
    },
  };
}
