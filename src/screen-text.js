/**
 * screen-text — the phone's get_screen text, filtered on this computer.
 *
 * The phone writes one line per element, nested by indentation, after one or more header lines:
 *
 *   app: Settings (com.android.settings) 1080x2400 keyboard: hidden
 *   [1] FrameLayout (540,1200)
 *     [3] TextView "Display" clickable (540,240)
 *       [4] Switch "Dark theme" id=switch checkable checked (900,240)
 *
 * The daemon offers three options the phone does not have, applied here to the phone's reply:
 * interactive_only, max_depth and diff. Node numbers are the phone's own, so a tap by node after a
 * filtered read still lands. A line that is not an element is kept as it is.
 */

/** Flags that mean a person could act on the element. `checked` and `unchecked` imply checkable. */
const INTERACTIVE_FLAGS = new Set([
  "clickable",
  "long-clickable",
  "long_clickable",
  "editable",
  "checkable",
  "checked",
  "unchecked",
  "scrollable",
  "focused",
  "selected",
]);

const ELEMENT_LINE = /^(\s*)\[(\d+)\] (.*)$/;

/** Schema of the options, merged into the phone's get_screen by the daemon (phones.js). */
export const GET_SCREEN_OPTIONS = {
  interactive_only: {
    type: "boolean",
    description:
      "Only the elements you could act on (clickable, editable, checkable, scrollable, focused, selected), the labels inside them, and the header. " +
      "Node numbers stay the phone's. Use it on long screens; read without it when a label you expect is missing.",
  },
  max_depth: {
    type: "integer",
    minimum: 1,
    description: "Leave out elements nested deeper than this many levels.",
  },
  diff: {
    type: "boolean",
    description:
      "Only what changed since your last get_screen on this phone: + added lines, - removed lines, and the count unchanged. " +
      "An unchanged screen is one line. Your first read in a session is always the full screen.",
  },
};

export const GET_SCREEN_OPTION_NAMES = Object.keys(GET_SCREEN_OPTIONS);

/** Words outside the quoted text and the key=value attributes: the element's flags. */
function flagsOf(rest) {
  const withoutText = rest.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  return withoutText
    .split(/\s+/)
    .slice(1) // the class name
    .filter((word) => word && !word.includes("=") && !/^\(\d+,\d+\)$/.test(word));
}

/**
 * Parses get_screen text: {header: string[], elements: [{indent, node, rest, line, depth}]}.
 * Lines after the first element that are not elements are kept as elements with node null.
 */
export function parseScreen(text) {
  const lines = String(text ?? "").split("\n");
  const header = [];
  const elements = [];
  for (const line of lines) {
    const match = ELEMENT_LINE.exec(line);
    if (!match) {
      if (!elements.length) header.push(line);
      else elements.push({ indent: 0, node: null, rest: line, line, depth: 0, flags: [] });
      continue;
    }
    const [, indentation, node, rest] = match;
    elements.push({ indent: indentation.length, node: Number(node), rest, line, depth: 0, flags: flagsOf(rest) });
  }
  // Depth from indentation: each distinct indent width seen, in order, is one level deeper.
  const widths = [...new Set(elements.filter((e) => e.node !== null).map((e) => e.indent))].sort((a, b) => a - b);
  for (const element of elements) element.depth = element.node === null ? 0 : widths.indexOf(element.indent) + 1;
  return { header, elements };
}

function isInteractive(element) {
  return element.flags.some((flag) => INTERACTIVE_FLAGS.has(flag));
}

/** Whether the element shows a label: quoted text or a content description. */
function isLabelled(element) {
  return /^\S+ "/.test(element.rest) || /(^|\s)desc=/.test(element.rest);
}

/** Marks each element inside an interactive one: a clickable row's label is often its child. */
function markInsideInteractive(elements) {
  const ancestors = [];
  for (const element of elements) {
    if (element.node === null) continue;
    while (ancestors.length && ancestors.at(-1).indent >= element.indent) ancestors.pop();
    element.insideInteractive = ancestors.some((a) => a.interactive);
    ancestors.push({ indent: element.indent, interactive: isInteractive(element) });
  }
}

/** The text with the options applied; the same text when none is set. */
export function filterScreen(text, { interactive_only = false, max_depth } = {}) {
  if (!interactive_only && !(Number.isInteger(max_depth) && max_depth >= 1)) return text;
  const { header, elements } = parseScreen(text);
  if (interactive_only) markInsideInteractive(elements);
  const kept = elements.filter((element) => {
    if (element.node === null) return true;
    if (interactive_only && !isInteractive(element) && !(element.insideInteractive && isLabelled(element))) return false;
    if (Number.isInteger(max_depth) && max_depth >= 1 && element.depth > max_depth) return false;
    return true;
  });
  const shown = kept.filter((e) => e.node !== null).length;
  const total = elements.filter((e) => e.node !== null).length;
  const note = shown < total ? [`(${shown} of ${total} elements shown; read without the options for the rest)`] : [];
  return [...header, ...kept.map((e) => e.line), ...note].join("\n");
}

/** An element's line without its node number and indentation: the same element on two reads. */
function identity(element) {
  return element.rest.trim();
}

/**
 * [text] against [previous] (both get_screen texts): what to show the model. The header is the
 * new one. Elements are matched by their content, not their number, so renumbering is no change.
 */
export function diffScreen(previous, text) {
  const before = parseScreen(previous).elements.filter((e) => e.node !== null);
  const now = parseScreen(text);
  const after = now.elements.filter((e) => e.node !== null);
  const counts = new Map();
  for (const element of before) counts.set(identity(element), (counts.get(identity(element)) ?? 0) + 1);
  const added = [];
  for (const element of after) {
    const key = identity(element);
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    else added.push(element);
  }
  const removed = [];
  for (const [key, left] of counts) for (let i = 0; i < left; i++) removed.push(key);
  const unchanged = after.length - added.length;
  if (!added.length && !removed.length) {
    return [...now.header, `Screen unchanged since your last get_screen: ${after.length} elements. Read without diff to list them.`].join("\n");
  }
  return [
    ...now.header,
    `${added.length} added, ${removed.length} removed, ${unchanged} unchanged:`,
    ...added.map((e) => `+ ${e.line.trim()}`),
    ...removed.map((key) => `- ${key}`),
  ].join("\n");
}

/**
 * Keeps the last full screen per device for one session, and applies the options to a reply.
 * The phone's reply is the first text item of a get_screen result; images and other items pass.
 */
export class ScreenOptions {
  constructor() {
    /** device key → last get_screen text the phone sent. */
    this._last = new Map();
  }

  /** Splits a get_screen call's arguments into the phone's and this computer's. */
  static split(args = {}) {
    const options = {};
    const phoneArgs = {};
    for (const [key, value] of Object.entries(args)) {
      if (GET_SCREEN_OPTION_NAMES.includes(key)) options[key] = value;
      else phoneArgs[key] = value;
    }
    return { options, phoneArgs };
  }

  /** The result as the model should see it, given the options; records the full screen. */
  apply(deviceKey, options, result) {
    const first = result?.content?.findIndex((item) => item.type === "text") ?? -1;
    if (result?.isError || first < 0) return result;
    const text = result.content[first].text;
    const previous = this._last.get(deviceKey ?? "");
    this._last.set(deviceKey ?? "", text);
    let shown = filterScreen(text, options);
    if (options.diff && previous !== undefined) shown = diffScreen(filterScreen(previous, options), shown);
    if (shown === text) return result;
    const content = result.content.slice();
    content[first] = { ...content[first], text: shown };
    return { ...result, content };
  }

  /** The last full screen the phone sent for [deviceKey], or undefined. */
  last(deviceKey) {
    return this._last.get(deviceKey ?? "");
  }
}

/**
 * The element numbered [node] in a get_screen text, as {node, className, text, id, desc, x, y,
 * flags}, or null. Quoted values may hold escaped quotes; bare ones end at the next space.
 */
export function elementByNode(text, node) {
  const element = parseScreen(text).elements.find((e) => e.node === node);
  if (!element) return null;
  const rest = element.rest;
  const quoted = /^"((?:[^"\\]|\\.)*)"/;
  const unquote = (value) => value.replace(/\\(.)/g, "$1");
  const attribute = (key) => {
    const at = rest.search(new RegExp(`(^|\\s)${key}=`));
    if (at < 0) return undefined;
    const value = rest.slice(rest.indexOf("=", at) + 1);
    const match = quoted.exec(value);
    return match ? unquote(match[1]) : value.split(/\s/)[0];
  };
  const className = rest.split(/\s/)[0];
  const afterClass = rest.slice(className.length).trim();
  const textMatch = quoted.exec(afterClass);
  const point = /\((\d+),(\d+)\)\s*$/.exec(rest);
  return {
    node,
    className,
    text: textMatch ? unquote(textMatch[1]) : undefined,
    id: attribute("id"),
    desc: attribute("desc"),
    x: point ? Number(point[1]) : undefined,
    y: point ? Number(point[2]) : undefined,
    flags: element.flags,
  };
}

/** The screen size a get_screen header names, as {width, height}, or null. */
export function screenSizeOf(text) {
  const match = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(parseScreen(text).header.join(" "));
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}
