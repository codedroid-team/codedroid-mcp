/**
 * This computer as the phone knows it: a random id kept in ~/.codedroid/host.json (the phone's
 * Settings > Computers remembers it once allowed), and its name.
 *
 * Not a secret: only adb reaches the phone's server, so the id only spares the user a second
 * "Allow?" for a computer they already allowed.
 */
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export function hostFilePath(home = os.homedir()) {
  return path.join(home, ".codedroid", "host.json");
}

export function hostIdentity({ home = os.homedir(), hostname = os.hostname() } = {}) {
  const file = hostFilePath(home);
  let id = null;
  try {
    id = JSON.parse(fs.readFileSync(file, "utf8")).id ?? null;
  } catch (e) {
    // First run, or unreadable: a new id.
  }
  if (!id) {
    id = randomUUID();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ id }), { mode: 0o600 });
    } catch (e) {
      // Read-only home: the phone asks again next time, nothing worse.
    }
  }
  return { id, name: hostname.replace(/\.local$/, "") };
}
