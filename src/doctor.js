/**
 * doctor — one line per thing that can be wrong between a coding client and the phone, with what
 * to do about it: Node, adb, this computer's credentials, the pairings, the daemon, each phone's
 * link, and which coding clients have CodeDroid. Changes nothing.
 *
 * collectDoctorReport takes every probe as a function, so the report is tested without a phone,
 * an adb or a daemon; the CLI wires the real ones in (index.js).
 */
import os from "os";
import { adbLocations } from "./adb-tool.js";
import { LOGIN_STEP, NO_ACCOUNT_PHONE, PAIRING_STEPS, describeHost, readAccount, readDaemonToken, readHosts } from "./host.js";
import { clients } from "./setup.js";
import { checkForUpdate, compareVersions } from "./update-check.js";
import { VERSION } from "./version.js";

const MIN_NODE = 20;

const ok = (name, detail) => ({ name, ok: true, detail });
const fix = (name, detail, how) => ({ name, ok: false, detail, fix: how });

/**
 * @param {object} probes
 * @param {string} probes.nodeVersion  process.version
 * @param {() => Promise<{ok: boolean, output: string, where?: string}>} probes.adbDevices  `adb devices -l`
 * @param {() => string|null} probes.daemonToken  host.js readDaemonToken; throws when the file is bad
 * @param {() => object|null} [probes.account]  host.js readAccount: the account this computer is signed in with
 * @param {() => object[]} probes.pairings  host.js readHosts: the account's phones and the pairings
 * @param {() => Promise<string|null>} [probes.latestVersion]  the newest version on npm, asked now
 * @param {() => Promise<object|null>} probes.daemonHealth  the running daemon's /health
 * @param {() => Promise<object|null>} probes.phoneStatus  codedroid_status's result, connecting; null when it cannot run
 * @param {() => Array<{name: string, installed: () => boolean, check?: () => {status: string, detail: string}}>} probes.clients
 * @returns {Promise<{checks: Array<{name, ok, detail, fix?}>, ok: boolean}>}
 */
export async function collectDoctorReport(probes) {
  const checks = [];
  const push = (check) => checks.push(check);

  // Node
  const major = Number(/^v?(\d+)/.exec(probes.nodeVersion ?? "")?.[1] ?? 0);
  push(major >= MIN_NODE ? ok("Node.js", probes.nodeVersion) : fix("Node.js", `${probes.nodeVersion} is too old`, `Install Node.js ${MIN_NODE} or later.`));

  // This release against npm
  if (probes.latestVersion) {
    let latest = null;
    try {
      latest = await probes.latestVersion();
    } catch (e) {
      latest = null;
    }
    if (!latest) push(ok("Version", `${VERSION} (could not ask npm for the newest)`));
    else if (compareVersions(latest, VERSION) > 0) {
      push(fix("Version", `${VERSION}, and ${latest} is on npm`, "Coding clients launch @latest: restart the client. The daemon moves a config pinned to an older release when it next starts."));
    } else push(ok("Version", `${VERSION}, the newest on npm`));
  }

  // adb
  try {
    const adb = await probes.adbDevices();
    if (!adb.ok) {
      push(fix("adb", "not found", "The adb tool and setup over USB need Android platform-tools on PATH, or ADB=<path to adb>. Everything else works without it."));
    } else {
      const devices = adb.output
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("*"));
      const unauthorized = devices.filter((d) => /\sunauthorized\b/.test(d)).length;
      const detail = `${adb.where ?? "adb"}: ${devices.length} device${devices.length === 1 ? "" : "s"}${unauthorized ? `, ${unauthorized} unauthorized` : ""}`;
      push(unauthorized ? fix("adb", detail, "Tap Allow on the phone's USB debugging prompt.") : ok("adb", detail));
    }
  } catch (e) {
    push(fix("adb", e.message, "Check the adb installation (adb devices -l)."));
  }

  // Credentials and pairings
  let pairings = [];
  try {
    const token = probes.daemonToken();
    push(token ? ok("Daemon token", "~/.codedroid/daemon-token is valid") : ok("Daemon token", "not created yet: the daemon makes it on its first start"));
  } catch (e) {
    push(fix("Daemon token", e.message.split("\n")[0], "End every CodeDroid daemon process, delete ~/.codedroid/daemon-token, and reconnect."));
  }
  const account = probes.account?.() ?? null;
  push(
    account
      ? ok("Account", `signed in as ${account.email ?? "an account"}${account.fromEnv ? " (CODEDROID_TOKEN)" : ""} at ${account.server}`)
      : fix("Account", "not signed in", LOGIN_STEP),
  );
  try {
    pairings = probes.pairings();
    const own = pairings.filter((h) => h.account);
    const paired = pairings.filter((h) => !h.account);
    const detail = [
      own.length ? `${own.length} on the account: ${own.map(describeHost).join(", ")}` : "",
      paired.length ? `paired: ${paired.map(describeHost).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    push(
      pairings.length
        ? ok("Known phones", detail)
        : fix("Known phones", account ? "no phone is on the account, and none is paired" : "this computer is not paired with a phone", account ? NO_ACCOUNT_PHONE : PAIRING_STEPS),
    );
  } catch (e) {
    push(fix("Known phones", e.message.split("\n")[0], "Fix or delete ~/.codedroid/host.json, then sign in or pair again."));
  }

  // Asking the phones starts the daemon when it is not running, so the daemon is checked after.
  let phoneStatus = null;
  if (pairings.length) {
    try {
      phoneStatus = { status: await probes.phoneStatus() };
    } catch (e) {
      phoneStatus = { error: e };
    }
  }

  // Daemon
  let health = null;
  try {
    health = await probes.daemonHealth();
  } catch (e) {
    health = null;
  }
  if (!health) {
    push(ok("Daemon", "not running (a client starts it when it connects)"));
  } else if (health.version !== VERSION) {
    push(ok("Daemon", `v${health.version} on port ${health.port ?? "?"}, this CLI is ${VERSION}: the next client of ${VERSION} replaces it`));
  } else {
    push(ok("Daemon", `v${health.version}, ${health.sessions} session${health.sessions === 1 ? "" : "s"}, adb tool ${health.adbToolEnabled ? "on" : "off"}`));
  }

  // Phones
  if (phoneStatus?.error) {
    push(fix("Phones", phoneStatus.error.message.split("\n")[0], "Run npx -y @codedroid/mcp status for the error."));
  } else if (phoneStatus) {
    const { status } = phoneStatus;
    if (!status) push(fix("Phones", "could not ask the daemon", "Run npx -y @codedroid/mcp status for the error."));
    else {
      for (const device of status.devices ?? []) {
        const name = `Phone ${device.model ?? device.id}`;
        push(device.connected ? ok(name, "connected") : fix(name, device.problem ?? "not connected", "Open CodeDroid on the phone, signed in and online, with Allow computers to connect on; tap Allow when it asks."));
      }
      if (!status.devices?.length && status.problem) push(fix("Phones", status.problem, PAIRING_STEPS));
    }
  }

  // Coding clients
  let any = false;
  for (const client of probes.clients()) {
    let installed = false;
    try {
      installed = client.installed();
    } catch (e) {
      installed = false;
    }
    if (!installed) continue;
    any = true;
    if (!client.check) {
      push(ok(client.name, "installed"));
      continue;
    }
    let result;
    try {
      result = client.check();
    } catch (e) {
      result = { status: "other", detail: e.message };
    }
    if (result.status === "present") push(ok(client.name, result.detail));
    else if (result.status === "other") push(ok(client.name, `${result.detail}; setup leaves it alone`));
    else push(fix(client.name, result.detail, `Run npx -y @codedroid/mcp setup --client=${client.id}.`));
  }
  if (!any) push(ok("Coding clients", "none of the supported clients found on this computer"));

  return { checks, ok: checks.every((c) => c.ok) };
}

/** The report as lines for the terminal. */
export function formatDoctorReport({ checks, ok: allOk }) {
  const lines = checks.map((c) => `${c.ok ? "ok  " : "fix "} ${c.name}: ${c.detail}${c.fix ? `\n       ${c.fix}` : ""}`);
  lines.push(allOk ? "Everything looks right." : `${checks.filter((c) => !c.ok).length} thing${checks.filter((c) => !c.ok).length === 1 ? "" : "s"} to fix.`);
  return lines;
}

/** The real probes for the CLI. [daemonHealth] and [phoneStatus] come from index.js, which owns the daemon client. */
export function realProbes({ daemonHealth, phoneStatus, env = process.env, run }) {
  return {
    nodeVersion: process.version,
    adbDevices: async () => {
      const { execFile } = await import("child_process");
      const exec = run ?? ((file, args) => new Promise((resolve) => execFile(file, args, { timeout: 15_000 }, (error, stdout) => resolve({ error, stdout: String(stdout ?? "") }))));
      for (const file of adbLocations(env)) {
        const { error, stdout } = await exec(file, ["devices", "-l"]);
        if (!error) return { ok: true, output: stdout, where: file };
        if (error.code !== "ENOENT") return { ok: true, output: "", where: file };
      }
      return { ok: false, output: "" };
    },
    daemonToken: () => readDaemonToken({ home: os.homedir() }),
    account: () => readAccount(),
    latestVersion: async () => (await checkForUpdate({ env, ttlMs: 0 }))?.latest ?? null,
    pairings: () => readHosts(),
    daemonHealth,
    phoneStatus,
    clients: () => clients(),
  };
}
