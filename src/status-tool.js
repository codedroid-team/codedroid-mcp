/**
 * The daemon's own tools about the phones, served when no phone can answer:
 *
 *   codedroid_devices — the paired phones and how each link stands now; instant, never connects.
 *   codedroid_status  — connects to each paired phone, then says which are connected and, if not,
 *                       what to do about it (not paired, offline, waiting on Allow).
 */
import { NO_ACCOUNT_PHONE, PAIRING_STEPS, describeHost, pairedDevice, readAccount } from "./host.js";
import { DEVICE_SCHEMA } from "./phones.js";
import { VERSION } from "./version.js";

// How long a status tool waits on the server for the account's phone list before going with the last.
const ACCOUNT_REFRESH_WAIT_MS = 5_000;

/** The account this computer is signed in with, as the tools show it; null when none. */
function accountSummary() {
  const account = readAccount();
  return account ? { email: account.email ?? null, server: account.server } : null;
}

/** Reads the account's phones again, within a bound, so a phone signed in since shows up. */
async function refreshAccount(phones) {
  if (!phones.refreshAccount || !readAccount()) return;
  await Promise.race([phones.refreshAccount(), new Promise((resolve) => setTimeout(resolve, ACCOUNT_REFRESH_WAIT_MS).unref?.())]);
}

/** Why there is no phone: not signed in and not paired, or signed in with no phone on the account. */
function noPhoneProblem(account) {
  return account ? NO_ACCOUNT_PHONE : `This computer is not signed in or paired with a phone. ${PAIRING_STEPS}`;
}

const DESCRIPTION =
  "Which Android phones are paired with this computer (each one's device id, model and CodeDroid server), " +
  "whether CodeDroid on each is connected, and if not, why and how to fix it. Also retries the connection. " +
  "Once connected it returns the phones' instructions for driving them. Pass device for one phone alone.";

export const FORGET = "A phone this computer no longer uses stays paired until you forget it: npx -y @codedroid/mcp unpair <its id>.";

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
      _meta: { "anthropic/alwaysLoad": true },
    },
    async handler() {
      await refreshAccount(phones);
      const account = accountSummary();
      const devices = phones.select().map(({ pairing, manager }) => ({
        ...pairedDevice(pairing),
        state: manager.state,
        ...(manager.state !== "connected" && manager.lastError ? { problem: manager.lastError } : {}),
      }));
      return statusResult({
        ...(account ? { account } : {}),
        devices,
        ...(devices.length ? {} : { problem: noPhoneProblem(account) }),
      });
    },
  };
}

/**
 * @param {import("./phones.js").Phones} phones
 * @param {object} [options]
 * @param {() => object | null} [options.update] a newer release on npm, as update-check.js describes it
 */
export function createStatusTool(phones, { update = () => null } = {}) {
  return {
    definition: {
      name: "codedroid_status",
      title: "CodeDroid connection",
      description: DESCRIPTION,
      inputSchema: { type: "object", properties: { device: DEVICE_SCHEMA } },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { "anthropic/alwaysLoad": true },
    },
    async handler({ device } = {}) {
      await refreshAccount(phones);
      const account = accountSummary();
      let entries;
      try {
        entries = phones.select(device);
      } catch (e) {
        return statusResult({ connected: false, bridge: VERSION, ...(account ? { account } : {}), devices: [], problem: e.message });
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
      // A phone set up again (reset, reinstalled) is a new pairing, and the old one stays offline.
      const forget = devices.length > 1 && devices.some((d) => !d.connected) ? FORGET : null;
      const problem = entries.length
        ? [...devices.map((d, i) => d.problem && (devices.length > 1 ? `${describeHost(entries[i].pairing)}: ${d.problem}` : d.problem)), forget]
            .filter(Boolean)
            .join(" ")
        : noPhoneProblem(account);
      // A session that opened before a phone connected never got these at its handshake.
      const instructions = phones.getInstructions();
      const newer = update();
      return statusResult({
        connected: devices.length > 0 && devices.every((d) => d.connected),
        bridge: VERSION,
        ...(account ? { account } : {}),
        ...(newer ? { update: newer } : {}),
        ...(devices.length === 1 ? { device: pairedDevice(entries[0].pairing) } : {}),
        devices,
        ...(problem ? { problem } : {}),
        ...(instructions ? { instructions } : {}),
      });
    },
  };
}
