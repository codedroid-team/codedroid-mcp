/**
 * The viewer against a fake daemon client: the page, the screenshot with the screen size, taps
 * from the page, and what it refuses (other origins, a wrong path, tools a person should not run
 * from a page).
 *
 * Run: node test/viewer.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { startViewer } from "../src/viewer.js";

const calls = [];
const SCREEN = "app: Settings (com.android.settings) 1080x2400 keyboard: hidden\n[1] View (1,1)";
const callTool = async (name, args) => {
  calls.push({ name, args });
  if (name === "get_screen") {
    if (args.device === "offline") return { isError: true, content: [{ type: "text", text: "CodeDroid on the phone is not connected" }] };
    return { content: [{ type: "text", text: SCREEN }, { type: "image", data: Buffer.from("jpeg-bytes").toString("base64"), mimeType: "image/jpeg" }] };
  }
  if (name === "tap" && args.x === 1) return { isError: true, content: [{ type: "text", text: '{"error":"locked","message":"The phone is locked."}' }] };
  return { content: [{ type: "text", text: `${name} ok\n{"after":{}}` }] };
};

const viewer = await startViewer({ callTool, device: "Pixel", intervalMs: 1234 });
try {
  const base = viewer.url.replace(/\/$/, "");
  assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);

  // The page, with the interval and device baked in.
  const page = await fetch(viewer.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /CodeDroid viewer/);
  assert.match(html, /const interval = 1234;/);
  assert.match(html, /const device = "Pixel";/);

  // A screenshot, with the screen size for scaling clicks; the device from the URL wins.
  const shot = await fetch(`${base}/shot?device=Pixel`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get("content-type"), "image/jpeg");
  assert.equal(shot.headers.get("x-screen-width"), "1080");
  assert.equal(shot.headers.get("x-screen-height"), "2400");
  assert.equal(Buffer.from(await shot.arrayBuffer()).toString(), "jpeg-bytes");
  assert.deepEqual(calls.at(-1), { name: "get_screen", args: { screenshot: true, device: "Pixel" } });
  const offline = await fetch(`${base}/shot?device=offline`);
  assert.equal(offline.status, 503);
  assert.match(await offline.text(), /not connected/);

  // Acting from the page.
  const tap = await fetch(`${base}/act`, { method: "POST", body: JSON.stringify({ tool: "tap", arguments: { x: 540, y: 900, device: "Pixel" } }) });
  assert.equal(tap.status, 200);
  assert.equal(await tap.text(), 'tap ok\n{"after":{}}');
  assert.deepEqual(calls.at(-1), { name: "tap", args: { x: 540, y: 900, device: "Pixel" } });
  const locked = await fetch(`${base}/act`, { method: "POST", body: JSON.stringify({ tool: "tap", arguments: { x: 1, y: 1 } }) });
  assert.equal(locked.status, 500);
  const refused = await fetch(`${base}/act`, { method: "POST", body: JSON.stringify({ tool: "install_apk", arguments: { path: "/x" } }) });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /can only tap, long_press, press_key, type_text, swipe, cancel_task, open_app/);
  assert.ok(!calls.some((c) => c.name === "install_apk"));
  assert.equal((await fetch(`${base}/act`, { method: "POST", body: "{" })).status, 400);

  // What it refuses.
  assert.equal((await fetch(`http://127.0.0.1:${viewer.port}/${"0".repeat(32)}/`)).status, 404, "a wrong path");
  assert.equal((await fetch(`http://127.0.0.1:${viewer.port}/`)).status, 404);
  assert.equal((await fetch(viewer.url, { headers: { Origin: "https://evil.example" } })).status, 403, "a cross-origin page");
  assert.equal((await fetch(viewer.url, { headers: { Origin: "null" } })).status, 403, "an opaque origin");
  assert.equal((await fetch(viewer.url, { headers: { Origin: `http://127.0.0.1:${viewer.port}` } })).status, 200, "the page itself");
  // fetch will not send another Host, so a raw request stands in for a DNS-rebinding page.
  const rebound = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: viewer.port, path: new URL(viewer.url).pathname, headers: { Host: "example.com" } }, (res) => resolve(res.statusCode)).on("error", reject);
  });
  assert.equal(rebound, 403, "DNS rebinding");
  assert.equal((await fetch(`${base}/shot`, { method: "POST" })).status, 405);

  console.log("viewer.test.mjs: ALL PASS");
} finally {
  await viewer.close();
}
