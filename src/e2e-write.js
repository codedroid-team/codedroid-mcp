// The safe-write rule shared by the e2e commands that write into an app's e2e folder.
import fs from "node:fs";
import path from "node:path";

/** True when writing `full` (under the real root) would go through a link or land outside the folder. */
export function escapesRoot(root, full) {
  let at = path.dirname(full);
  while (!fs.existsSync(at)) at = path.dirname(at); // the nearest folder that exists; the rest is made below it
  const real = fs.realpathSync(at);
  if (real !== root && !real.startsWith(root + path.sep)) return true;
  try { return fs.lstatSync(full).isSymbolicLink(); } catch { return false; /* not there yet */ }
}
