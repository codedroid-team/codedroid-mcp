/**
 * viewer — a page on this computer that shows the phone's screen while an agent drives it, and
 * lets the person take over: tap the picture, press Back or Home, type, and cancel a task.
 *
 * It is a client of the daemon like any other, so its screenshots queue with the agent's calls and
 * never interleave with them. It polls only while the tab is visible, every few seconds, and the
 * page can pause it. Loopback only, a random path nobody else on the computer can guess, and no
 * cross-origin page can reach it.
 */
import { randomBytes } from "crypto";
import http from "http";
import { VERSION } from "./version.js";

/** What the page may call: a person taking over, nothing that installs or reads files. */
const ALLOWED_ACTIONS = new Set(["tap", "long_press", "press_key", "type_text", "swipe", "cancel_task", "open_app"]);
const DEFAULT_INTERVAL_MS = 3_000;
const MAX_BODY = 64 * 1024;

function page({ token, intervalMs, device }) {
  return `<!doctype html>
<meta charset="utf-8">
<title>CodeDroid viewer</title>
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; background: #111; color: #ddd; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px; }
  #bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
  button, input { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #555; background: #222; color: #eee; }
  button:hover { background: #333; }
  #shot { max-height: 85vh; max-width: 95vw; border-radius: 12px; cursor: crosshair; background: #000; }
  #status { color: #999; min-height: 1.2em; }
</style>
<div id="bar">
  <strong>CodeDroid viewer</strong>
  <button id="pause">Pause</button>
  <button data-key="back">Back</button>
  <button data-key="home">Home</button>
  <button data-key="recents">Recents</button>
  <input id="text" placeholder="Type into the focused field" size="28">
  <button id="type">Type</button>
  <input id="task" placeholder="task id" size="10"><button id="cancel">Cancel task</button>
</div>
<img id="shot" alt="The phone's screen">
<div id="status">Loading</div>
<script>
  const base = ${JSON.stringify(`/${token}`)};
  const device = ${JSON.stringify(device ?? null)};
  const interval = ${Number(intervalMs)};
  const shot = document.getElementById("shot");
  const status = document.getElementById("status");
  let paused = false;
  let busy = false;
  async function refresh() {
    if (paused || busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      const res = await fetch(base + "/shot" + (device ? "?device=" + encodeURIComponent(device) : ""), { cache: "no-store" });
      if (!res.ok) { status.textContent = await res.text(); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      shot.onload = () => URL.revokeObjectURL(url);
      shot.src = url;
      shot.dataset.width = res.headers.get("x-screen-width") || "";
      shot.dataset.height = res.headers.get("x-screen-height") || "";
      status.textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (e) {
      status.textContent = "Could not reach the viewer: " + e.message;
    } finally {
      busy = false;
    }
  }
  async function act(tool, args) {
    status.textContent = tool + "...";
    const res = await fetch(base + "/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, arguments: device ? { ...args, device } : args }) });
    status.textContent = (await res.text()).split("\\n")[0].slice(0, 200);
    setTimeout(refresh, 400);
  }
  shot.addEventListener("click", (event) => {
    const rect = shot.getBoundingClientRect();
    const width = Number(shot.dataset.width) || shot.naturalWidth;
    const height = Number(shot.dataset.height) || shot.naturalHeight;
    const x = Math.round((event.clientX - rect.left) / rect.width * width);
    const y = Math.round((event.clientY - rect.top) / rect.height * height);
    act("tap", { x, y });
  });
  for (const button of document.querySelectorAll("[data-key]")) button.addEventListener("click", () => act("press_key", { key: button.dataset.key }));
  document.getElementById("type").addEventListener("click", () => act("type_text", { text: document.getElementById("text").value, clear: false }));
  document.getElementById("cancel").addEventListener("click", () => act("cancel_task", { task_id: document.getElementById("task").value }));
  document.getElementById("pause").addEventListener("click", (event) => { paused = !paused; event.target.textContent = paused ? "Resume" : "Pause"; if (!paused) refresh(); });
  document.addEventListener("visibilitychange", refresh);
  refresh();
  setInterval(refresh, interval);
</script>
`;
}

function isLoopback(hostHeader) {
  const host = String(hostHeader ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function originAllowed(origin, hostHeader) {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return isLoopback(url.host) && url.host === String(hostHeader);
  } catch (e) {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {object} options
 * @param {(name: string, args: object) => Promise<object>} options.callTool  a daemon client's tool call
 * @param {string} [options.device]
 * @param {number} [options.port]  0 = any free port
 * @param {number} [options.intervalMs]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export async function startViewer({ callTool, device, port = 0, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const token = randomBytes(16).toString("hex");
  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.headers.host) || !originAllowed(req.headers.origin, req.headers.host)) {
        res.writeHead(403).end("localhost only");
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const [, got, action] = /^\/([0-9a-f]{32})(?:\/([a-z]+))?\/?$/.exec(url.pathname) ?? [];
      if (got !== token) {
        res.writeHead(404).end("not found");
        return;
      }
      if (!action && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page({ token, intervalMs, device }));
        return;
      }
      if (action === "shot" && req.method === "GET") {
        const chosen = url.searchParams.get("device") ?? device;
        const result = await callTool("get_screen", { screenshot: true, ...(chosen ? { device: chosen } : {}) });
        const image = result.content?.find((item) => item.type === "image");
        if (result.isError || !image) {
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(result.content?.find((i) => i.type === "text")?.text ?? "no screenshot");
          return;
        }
        const header = result.content.find((item) => item.type === "text")?.text?.split("\n")[0] ?? "";
        const size = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(header);
        res.writeHead(200, {
          "content-type": image.mimeType ?? "image/jpeg",
          "cache-control": "no-store",
          ...(size ? { "x-screen-width": size[1], "x-screen-height": size[2] } : {}),
        }).end(Buffer.from(image.data, "base64"));
        return;
      }
      if (action === "act" && req.method === "POST") {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          res.writeHead(400).end("bad body");
          return;
        }
        if (!ALLOWED_ACTIONS.has(body?.tool)) {
          res.writeHead(400).end(`the viewer can only ${[...ALLOWED_ACTIONS].join(", ")}`);
          return;
        }
        const result = await callTool(body.tool, body.arguments ?? {});
        res.writeHead(result.isError ? 500 : 200, { "content-type": "text/plain; charset=utf-8" }).end(result.content?.find((i) => i.type === "text")?.text ?? "");
        return;
      }
      res.writeHead(405).end("method not allowed");
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(e.message);
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const bound = server.address().port;
  return {
    url: `http://127.0.0.1:${bound}/${token}/`,
    port: bound,
    version: VERSION,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
