/**
 * get_screen text filtered on this computer: interactive_only, max_depth, diff, and the element
 * lookup the recorder uses.
 *
 * Run: node test/screen-text.test.mjs
 */
import assert from "node:assert/strict";
import { ScreenOptions, diffScreen, elementByNode, filterScreen, parseScreen, screenSizeOf } from "../src/screen-text.js";

const SCREEN = [
  "app: Settings (com.android.settings) 1080x2400 keyboard: hidden",
  "[1] FrameLayout (540,1200)",
  "  [2] LinearLayout id=com.android.settings:id/content (540,1200)",
  '    [3] TextView "Display" clickable (540,240)',
  '      [4] Switch desc="Dark theme" id=com.android.settings:id/switch_widget checkable checked (900,240)',
  '    [5] TextView "Brightness level" (540,400)',
  '    [6] EditText "Search settings" editable focused (540,100)',
  "    [7] RecyclerView scrollable (540,1400)",
  '      [8] TextView "Sound" clickable (540,600)',
].join("\n");

// ── Parsing: header, nesting, flags ─────────────────────────────────────────
{
  const { header, elements } = parseScreen(SCREEN);
  assert.deepEqual(header, [SCREEN.split("\n")[0]]);
  assert.equal(elements.length, 8);
  assert.deepEqual(elements.map((e) => e.depth), [1, 2, 3, 4, 3, 3, 3, 4]);
  assert.deepEqual(elements[3].flags, ["checkable", "checked"], "quoted text and attributes are not flags");
  assert.deepEqual(elements[1].flags, []);
}

// ── No options: the text is the phone's, byte for byte ──────────────────────
assert.equal(filterScreen(SCREEN, {}), SCREEN);
assert.equal(filterScreen(SCREEN, { interactive_only: false }), SCREEN);

// ── interactive_only keeps the header, the actionable elements and their numbers ──
{
  const shown = filterScreen(SCREEN, { interactive_only: true });
  const lines = shown.split("\n");
  assert.equal(lines[0], SCREEN.split("\n")[0]);
  assert.deepEqual(
    lines.slice(1, -1).map((l) => /\[(\d+)\]/.exec(l)[1]),
    ["3", "4", "6", "7", "8"],
    "clickable, checkable, editable, scrollable stay; layouts and plain labels go",
  );
  assert.match(lines.at(-1), /^\(5 of 8 elements shown; read without the options for the rest\)$/);
  assert.ok(lines[1].startsWith('    [3] TextView "Display"'), "indentation is kept");
}

// ── interactive_only keeps the label of a clickable row, which is often its child ──
{
  const row = [
    "app: Settings 1080x2388",
    "[2] RecyclerView scrollable (540,1600)",
    '  [3] TextView "Settings" id=title (280,474)',
    "  [14] LinearLayout clickable (540,1090)",
    "    [15] ImageView (60,1090)",
    '    [16] TextView "Google" id=title (262,1068)',
    '    [17] FrameLayout desc="More" (900,1090)',
  ].join("\n");
  const kept = filterScreen(row, { interactive_only: true }).split("\n").slice(1, -1).map((l) => /\[(\d+)\]/.exec(l)[1]);
  assert.deepEqual(kept, ["2", "3", "14", "16", "17"], "labels inside an interactive element stay; an unlabelled image goes");
}

// ── max_depth cuts below a level ────────────────────────────────────────────
{
  const lines = filterScreen(SCREEN, { max_depth: 3 }).split("\n");
  assert.deepEqual(lines.slice(1, -1).map((l) => /\[(\d+)\]/.exec(l)[1]), ["1", "2", "3", "5", "6", "7"]);
  assert.equal(filterScreen(SCREEN, { max_depth: 0 }), SCREEN, "an invalid depth changes nothing");
}

// ── Both together ───────────────────────────────────────────────────────────
assert.deepEqual(
  filterScreen(SCREEN, { interactive_only: true, max_depth: 3 }).split("\n").slice(1, -1).map((l) => /\[(\d+)\]/.exec(l)[1]),
  ["3", "6", "7"],
);

// ── A screen with nothing parseable passes through ──────────────────────────
assert.equal(filterScreen("Nothing on screen passed the visibility filter", { interactive_only: true }), "Nothing on screen passed the visibility filter");

// ── diff: renumbering is no change; content is ───────────────────────────────
{
  const renumbered = SCREEN.replace("[8] TextView", "[9] TextView");
  assert.match(diffScreen(SCREEN, renumbered), /^app: Settings.*\nScreen unchanged since your last get_screen: 8 elements\. Read without diff to list them\.$/);
  const changed = SCREEN.replace('[5] TextView "Brightness level" (540,400)', '[5] TextView "Brightness" (540,400)').replace("checkable checked", "checkable unchecked") + '\n      [10] TextView "Vibration" clickable (540,800)';
  const diff = diffScreen(SCREEN, changed);
  const lines = diff.split("\n");
  assert.equal(lines[1], "3 added, 2 removed, 6 unchanged:");
  assert.deepEqual(lines.filter((l) => l.startsWith("+ ")).map((l) => l.slice(2)), [
    '[4] Switch desc="Dark theme" id=com.android.settings:id/switch_widget checkable unchecked (900,240)',
    '[5] TextView "Brightness" (540,400)',
    '[10] TextView "Vibration" clickable (540,800)',
  ]);
  assert.deepEqual(lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2)), [
    'Switch desc="Dark theme" id=com.android.settings:id/switch_widget checkable checked (900,240)',
    'TextView "Brightness level" (540,400)',
  ]);
}

// ── ScreenOptions: per device, first read full, then diffs; images untouched ──
{
  const options = new ScreenOptions();
  const result = (text) => ({ content: [{ type: "text", text }, { type: "image", data: "abc", mimeType: "image/jpeg" }] });
  assert.deepEqual(ScreenOptions.split({ screenshot: true, diff: true, device: "Pixel", max_depth: 2 }), {
    options: { diff: true, max_depth: 2 },
    phoneArgs: { screenshot: true, device: "Pixel" },
  });
  const first = options.apply("", { diff: true }, result(SCREEN));
  assert.equal(first.content[0].text, SCREEN, "the first read in a session is the full screen");
  assert.equal(first.content[1].type, "image");
  const second = options.apply("", { diff: true }, result(SCREEN.replace("[8] TextView", "[9] TextView")));
  assert.match(second.content[0].text, /Screen unchanged/);
  assert.equal(second.content[1].data, "abc");
  const other = options.apply("Pixel", { diff: true }, result(SCREEN));
  assert.equal(other.content[0].text, SCREEN, "another phone has its own first read");
  // interactive_only with diff: the diff is between the filtered reads.
  const third = options.apply("", { diff: true, interactive_only: true }, result(SCREEN.replace('[5] TextView "Brightness level"', '[5] TextView "Brightness"')));
  assert.match(third.content[0].text, /Screen unchanged since your last get_screen: 5 elements/, "a label that is not interactive does not show in an interactive diff");
  assert.equal(options.last(""), SCREEN.replace('[5] TextView "Brightness level"', '[5] TextView "Brightness"'), "the full text is what is kept");
  const error = { content: [{ type: "text", text: '{"error":"locked"}' }], isError: true };
  assert.equal(options.apply("", { diff: true }, error), error, "an error passes through and is not kept as a screen");
  assert.equal(options.last(""), SCREEN.replace('[5] TextView "Brightness level"', '[5] TextView "Brightness"'));
}

// ── elementByNode and the screen size ───────────────────────────────────────
assert.deepEqual(elementByNode(SCREEN, 4), {
  node: 4,
  className: "Switch",
  text: undefined,
  id: "com.android.settings:id/switch_widget",
  desc: "Dark theme",
  x: 900,
  y: 240,
  flags: ["checkable", "checked"],
});
assert.equal(elementByNode(SCREEN, 3).text, "Display");
assert.equal(elementByNode(SCREEN, 99), null);
assert.equal(elementByNode('[1] Button "Say \\"hi\\"" clickable (1,2)', 1).text, 'Say "hi"');
assert.deepEqual(screenSizeOf(SCREEN), { width: 1080, height: 2400 });
assert.equal(screenSizeOf("app: X"), null);

console.log("screen-text.test.mjs: ALL PASS");
