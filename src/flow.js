/**
 * flow — a phone session recorded as a Maestro flow, and a Maestro flow replayed on a phone.
 *
 * The file format is Maestro's YAML (https://docs.maestro.dev), the subset below, so a flow
 * recorded here runs in Maestro on an emulator, and a team's existing flows run on a CodeDroid
 * phone with no cable. One extension, `codedroidTask`, hands CodeDroid's own agent a goal; Maestro
 * does not know it, and the file header says so.
 *
 * Recording turns each successful phone tool call into a step. A tap by node becomes a tap by what
 * that node showed (text, then resource id, then content description, then its point), so the
 * flow does not depend on node numbers, which change on every read.
 *
 * Replay runs the steps through tool calls, one at a time, and stops at the first failure. A step
 * marked `optional: true` only warns. Commands outside the subset fail the run where they are:
 * a flow that silently skipped them would say "passed" about what it never checked.
 */
import fs from "fs";
import path from "path";
import YAML from "yaml";
import { elementByNode, screenSizeOf } from "./screen-text.js";
import { VERSION } from "./version.js";

/** Maestro waits this long for an assertion before failing it. */
export const ASSERT_TIMEOUT_MS = 7_000;
/** wait_for's own limit per call; longer waits loop. */
const WAIT_FOR_MAX_MS = 30_000;
const SCROLL_UNTIL_MAX_SWIPES = 20;
const TASK_WAIT_S = 50;

export const SUPPORTED_COMMANDS = [
  "launchApp",
  "tapOn",
  "longPressOn",
  "inputText",
  "eraseText",
  "pressKey",
  "back",
  "swipe",
  "scroll",
  "scrollUntilVisible",
  "assertVisible",
  "assertNotVisible",
  "extendedWaitUntil",
  "waitForAnimationToEnd",
  "takeScreenshot",
  "hideKeyboard",
  "openLink",
  "runFlow",
  "repeat",
  "codedroidTask",
];

const MAESTRO_KEYS = { enter: "Enter", home: "Home", back: "Back", recents: "Recents" };
const CODEDROID_KEYS = Object.fromEntries(Object.entries(MAESTRO_KEYS).map(([ours, theirs]) => [theirs.toLowerCase(), ours]));

export class FlowError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlowError";
  }
}

/** The text of a tool result, or "". */
export function textOf(result) {
  return result?.content?.find((item) => item.type === "text")?.text ?? "";
}

/** A tool error's {error, message, hint}, parsed when the phone wrote JSON, or {message}. */
export function errorOf(result) {
  const text = textOf(result);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (e) {
    /* plain text */
  }
  return { message: text.split("\n")[0] };
}

/** The `after` observation an acting tool returns on its last line, or null. */
export function afterOf(result) {
  const last = textOf(result).trim().split("\n").at(-1);
  try {
    return JSON.parse(last)?.after ?? null;
  } catch (e) {
    return null;
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

/**
 * A Maestro flow file's {appId, name, env, steps} from its text. Maestro's two documents, the
 * config and the command list, or a list alone.
 */
export function parseFlow(text, { file = "flow" } = {}) {
  let documents;
  try {
    documents = YAML.parseAllDocuments(text, { prettyErrors: true });
  } catch (e) {
    throw new FlowError(`${file}: not YAML: ${e.message}`);
  }
  for (const document of documents) {
    if (document.errors.length) throw new FlowError(`${file}: ${document.errors[0].message}`);
  }
  const values = documents.map((d) => d.toJS()).filter((v) => v !== null && v !== undefined);
  let config = {};
  let commands;
  if (values.length === 1 && Array.isArray(values[0])) commands = values[0];
  else if (values.length === 2 && Array.isArray(values[1])) [config, commands] = values;
  else throw new FlowError(`${file}: expected a config document (appId: ...), then "---", then a list of commands.`);
  if (config && typeof config !== "object") throw new FlowError(`${file}: the first document must be a map (appId: ...).`);
  const steps = commands.map((command, i) => parseCommand(command, i + 1, file));
  return { appId: config?.appId, name: config?.name, env: config?.env ?? {}, steps };
}

/** A command as written (`- back`, `- tapOn: x`, `- tapOn: {id: x}`) to {command, value, line}. */
function parseCommand(command, index, file) {
  if (typeof command === "string") return { command, value: null, index };
  if (command && typeof command === "object" && !Array.isArray(command)) {
    const keys = Object.keys(command);
    if (keys.length === 1) return { command: keys[0], value: command[keys[0]], optional: isOptional(command, command[keys[0]]), index };
    // `- tapOn: x` with `optional: true` beside it, which Maestro also accepts.
    const [name] = keys.filter((k) => k !== "optional" && k !== "label");
    if (name && keys.length <= 3) return { command: name, value: command[name], optional: isOptional(command, command[name]), label: command.label, index };
  }
  throw new FlowError(`${file}: command ${index} is not a command (${JSON.stringify(command)}).`);
}

/** Maestro's `optional: true`, beside the command or inside its selector. */
function isOptional(command, value) {
  return command.optional === true || (value && typeof value === "object" && value.optional === true);
}

/** `${NAME}` in strings replaced from [env]; unknown names stay. */
export function substitute(value, env) {
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => (name in env ? String(env[name]) : m));
  if (Array.isArray(value)) return value.map((v) => substitute(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, env)]));
  return value;
}

// ── Recording ────────────────────────────────────────────────────────────────────────────────

/** A tap selector for Maestro from a CodeDroid tap's arguments, using the last screen for a node. */
function selectorOf(args, lastScreen) {
  if (args.text !== undefined) return { tapOn: String(args.text) };
  if (args.resource_id !== undefined) return { tapOn: { id: String(args.resource_id) } };
  if (args.content_description !== undefined) return { tapOn: { text: String(args.content_description) } };
  if (Number.isInteger(args.node)) {
    const element = lastScreen ? elementByNode(lastScreen, args.node) : null;
    if (!element) return { comment: `tap by node ${args.node}: the element could not be resolved (no screen read before it)` };
    if (element.text) return { tapOn: element.text };
    if (element.id) return { tapOn: { id: element.id } };
    if (element.desc) return { tapOn: { text: element.desc } };
    if (element.x !== undefined) return { tapOn: { point: `${element.x},${element.y}` } };
    return { comment: `tap by node ${args.node}: ${element.className} with no text, id or description` };
  }
  if (Number.isInteger(args.x) && Number.isInteger(args.y)) return { tapOn: { point: `${args.x},${args.y}` } };
  return { comment: `tap with arguments ${JSON.stringify(args)} could not be recorded` };
}

/**
 * Turns one successful phone tool call into zero or more Maestro steps: objects with one command
 * key, or {comment} for what Maestro cannot say.
 */
export function stepsForCall(name, args = {}, { lastScreen, screenshotIndex = 0 } = {}) {
  switch (name) {
    case "open_app":
      return [{ launchApp: args.activity ? { appId: args.package, arguments: { activity: args.activity } } : args.package }];
    case "tap":
    case "long_press": {
      const step = selectorOf(args, lastScreen);
      if (step.comment) return [step];
      return [name === "tap" ? step : { longPressOn: step.tapOn }];
    }
    case "type_text": {
      const steps = [];
      if (args.clear !== false) steps.push("eraseText");
      steps.push({ inputText: String(args.text ?? "") });
      if (args.submit) steps.push({ pressKey: "Enter" });
      return steps;
    }
    case "swipe":
      return [{ swipe: { start: `${args.x1},${args.y1}`, end: `${args.x2},${args.y2}`, ...(args.duration_ms ? { duration: args.duration_ms } : {}) } }];
    case "press_key":
      return [args.key === "back" ? "back" : { pressKey: MAESTRO_KEYS[args.key] ?? String(args.key) }];
    case "wait_for": {
      const timeout = args.timeout_ms ? { timeout: args.timeout_ms } : {};
      if (args.text !== undefined) return [{ extendedWaitUntil: { visible: String(args.text), ...timeout } }];
      if (args.gone_text !== undefined) return [{ extendedWaitUntil: { notVisible: String(args.gone_text), ...timeout } }];
      if (args.package !== undefined) return [{ comment: `wait_for package ${args.package}: Maestro has no wait for an app; launchApp returns once it is open` }];
      return [];
    }
    case "take_screenshot":
      return [{ takeScreenshot: `step-${screenshotIndex}` }];
    case "open_url":
      return [{ openLink: String(args.url ?? "") }];
    case "dismiss_keyboard":
      return ["hideKeyboard"];
    case "scroll_until": {
      const direction = { down: "DOWN", up: "UP", left: "LEFT", right: "RIGHT" }[String(args.direction ?? "down").toLowerCase()] ?? "DOWN";
      return [{ scrollUntilVisible: { element: { text: String(args.text ?? "") }, direction } }];
    }
    case "alert":
      return [{ comment: `alert ${args.text ? JSON.stringify(args.text) : (args.action ?? "accept")}: the button tapped depends on the dialog; tap it by text to record it` }];
    case "run_task":
      return [{ codedroidTask: String(args.goal ?? "") }];
    case "clipboard":
      return args.text !== undefined ? [{ comment: `clipboard set to ${JSON.stringify(args.text)}: Maestro has no clipboard command` }] : [];
    default:
      // get_screen, device_info, list_apps, get_task, answer_task, cancel_task: observations, or the task's own.
      return [];
  }
}

/** The YAML text of a flow: the header comment, the config document, then the steps. */
export function flowToYaml({ appId, name, steps, comments = [] }) {
  const header = [
    `Recorded by CodeDroid MCP ${VERSION}. Run it on a phone: npx -y @codedroid/mcp flow run <this file>`,
    "Maestro's format (https://docs.maestro.dev): maestro test runs it too, except codedroidTask steps.",
    ...comments,
  ]
    .map((line) => `# ${line}`)
    .join("\n");
  const config = { ...(appId ? { appId } : {}), ...(name ? { name } : {}) };
  const configText = Object.keys(config).length ? YAML.stringify(config) : "";
  const real = steps.filter((s) => !s.comment);
  const list = new YAML.Document(real);
  // A comment step sits above the next real step, or at the end of the list.
  let pending = [];
  let at = 0;
  for (const step of steps) {
    if (step.comment) {
      pending.push(` ${step.comment}`);
      continue;
    }
    if (pending.length) list.contents.items[at].commentBefore = pending.join("\n");
    pending = [];
    at++;
  }
  if (pending.length) list.comment = pending.join("\n");
  return `${header}\n${configText}---\n${real.length ? list.toString() : "[]\n"}`;
}

/** Records a session's phone tool calls as flow steps. */
export class Recorder {
  constructor() {
    this.active = null;
  }

  start({ name, device } = {}) {
    if (this.active) throw new FlowError(`Already recording "${this.active.name}": call record_stop first.`);
    this.active = { name: name ?? "recording", device, appId: undefined, steps: [], screenshots: 0, startedAt: Date.now() };
    return this.active;
  }

  /** One phone tool call that succeeded: [lastScreen] is the full get_screen text read before it. */
  observe({ name, args = {}, result, lastScreen }) {
    const recording = this.active;
    if (!recording || result?.isError) return;
    if (recording.device !== undefined && args.device !== undefined && args.device !== recording.device) return;
    if (name === "take_screenshot") recording.screenshots++;
    const steps = stepsForCall(name, args, { lastScreen, screenshotIndex: recording.screenshots });
    if (name === "open_app" && !recording.appId && args.package) recording.appId = args.package;
    recording.steps.push(...steps);
  }

  /** Ends the recording: {name, yaml, steps, comments}. */
  stop() {
    const recording = this.active;
    if (!recording) throw new FlowError("Not recording: call record_start first.");
    this.active = null;
    const real = recording.steps.filter((s) => !s.comment).length;
    const skipped = recording.steps.length - real;
    return {
      name: recording.name,
      appId: recording.appId,
      steps: real,
      skipped,
      yaml: flowToYaml({ appId: recording.appId, name: recording.name, steps: recording.steps }),
    };
  }
}

// ── Replay ───────────────────────────────────────────────────────────────────────────────────

/** Maestro's selector (a string, or {text}/{id}/{point}) as CodeDroid tap arguments. */
function tapArgsOf(value, command) {
  if (typeof value === "string" || typeof value === "number") return { text: String(value) };
  if (!value || typeof value !== "object") throw new FlowError(`${command}: needs text, {id: ...}, {text: ...} or {point: "x,y"}.`);
  const known = ["text", "id", "point", "optional", "label", "index", "enabled", "checked", "focused", "selected", "childOf", "containsChild", "containsDescendants", "below", "above", "leftOf", "rightOf", "css", "repeat", "delay", "waitToSettleTimeoutMs", "retryTapIfNoChange", "longPress"];
  const unknown = Object.keys(value).filter((k) => !known.includes(k));
  if (unknown.length) throw new FlowError(`${command}: unknown selector keys ${unknown.join(", ")}.`);
  const unsupported = ["index", "childOf", "containsChild", "containsDescendants", "below", "above", "leftOf", "rightOf", "css"].filter((k) => k in value);
  if (unsupported.length) throw new FlowError(`${command}: ${unsupported.join(", ")} is not supported on CodeDroid; select by text or id.`);
  if (value.point !== undefined) {
    const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(String(value.point));
    if (!match) throw new FlowError(`${command}: point must be "x,y" in pixels; percentages are not supported on CodeDroid.`);
    return { x: Number(match[1]), y: Number(match[2]) };
  }
  if (value.id !== undefined) return { resource_id: String(value.id) };
  if (value.text !== undefined) return { text: String(value.text) };
  throw new FlowError(`${command}: needs text, {id: ...}, {text: ...} or {point: "x,y"}.`);
}

/** Whether the selector names something on [screen] (a get_screen text). */
function visibleOn(screen, selector) {
  const needle = typeof selector === "object" && selector !== null ? selector : { text: String(selector) };
  const lines = screen.split("\n");
  if (needle.id !== undefined) {
    const id = String(needle.id);
    return lines.some((line) => {
      const match = /(?:^|\s)id=("(?:[^"\\]|\\.)*"|\S+)/.exec(line);
      if (!match) return false;
      const value = match[1].startsWith('"') ? match[1].slice(1, -1) : match[1];
      return value === id || value.endsWith(`/${id}`);
    });
  }
  const text = String(needle.text ?? "").toLowerCase();
  return !!text && lines.some((line) => line.toLowerCase().includes(text));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs [flow] (parseFlow's result) through [call](name, args) → tool result. Options: env, baseDir
 * (for runFlow paths), screenshotDir (where takeScreenshot writes), log(line), now.
 * Resolves {ok, steps: [{index, command, status, detail}], screen} where screen is the first lines
 * of the screen at the end (or at the failure).
 */
export async function runFlow(flow, call, options = {}) {
  const state = {
    call,
    env: { ...flow.env, ...(options.env ?? {}) },
    appId: flow.appId,
    baseDir: options.baseDir ?? process.cwd(),
    screenshotDir: options.screenshotDir,
    log: options.log ?? (() => {}),
    pendingClear: false,
    depth: options.depth ?? 0,
    results: [],
  };
  let ok = true;
  let screen = null;
  for (const step of flow.steps) {
    const outcome = await runStep(step, state);
    state.results.push(outcome);
    state.log(`${outcome.status}: ${describeStep(step)}${outcome.detail ? ` (${outcome.detail})` : ""}`);
    if (outcome.status === "fail") {
      ok = false;
      break;
    }
  }
  try {
    screen = textOf(await call("get_screen", {})).split("\n").slice(0, 20).join("\n");
  } catch (e) {
    screen = null;
  }
  return { ok, steps: state.results, screen };
}

/** A step as the report names it. */
export function describeStep(step) {
  const value = step.value === null || step.value === undefined ? "" : typeof step.value === "object" ? JSON.stringify(step.value) : String(step.value);
  return `${step.index}. ${step.command}${value ? ` ${value}` : ""}`;
}

async function runStep(step, state) {
  const base = { index: step.index, command: step.command, text: describeStep(step) };
  try {
    const detail = await execute(step.command, substitute(step.value, state.env), state);
    return { ...base, status: "pass", ...(detail ? { detail } : {}) };
  } catch (e) {
    if (e instanceof FlowError || e?.name === "FlowError") {
      return step.optional ? { ...base, status: "warn", detail: e.message } : { ...base, status: "fail", detail: e.message };
    }
    throw e;
  }
}

/** Sends one tool call; a tool error becomes a FlowError with the phone's message and hint. */
async function send(state, name, args) {
  const result = await state.call(name, args);
  if (result?.isError) {
    const error = errorOf(result);
    throw new FlowError(`${name}: ${error.message ?? error.error ?? textOf(result)}${error.hint ? ` ${error.hint}` : ""}`);
  }
  return result;
}

async function flushClear(state) {
  if (!state.pendingClear) return;
  state.pendingClear = false;
  await send(state, "type_text", { text: "", clear: true });
}

async function readScreen(state) {
  return textOf(await send(state, "get_screen", {}));
}

/** Waits until [selector] is, or is not, on screen; resolves true when met within [timeoutMs]. */
async function waitUntil(state, selector, { visible, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const needle = typeof selector === "object" && selector !== null ? selector : { text: String(selector) };
  // wait_for watches text on the phone itself; anything else polls the screen from here.
  if (needle.text !== undefined && needle.id === undefined) {
    for (;;) {
      const left = Math.max(0, deadline - Date.now());
      const chunk = Math.min(left, WAIT_FOR_MAX_MS);
      const result = await send(state, "wait_for", { ...(visible ? { text: String(needle.text) } : { gone_text: String(needle.text) }), timeout_ms: Math.max(chunk, 1) });
      let met;
      try {
        met = JSON.parse(textOf(result)).met;
      } catch (e) {
        met = undefined;
      }
      if (met === true) return true;
      if (Date.now() >= deadline) return met === true;
    }
  }
  for (;;) {
    const on = visibleOn(await readScreen(state), needle);
    if (on === visible) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

function describeSelector(selector) {
  return typeof selector === "object" && selector !== null ? JSON.stringify(selector) : JSON.stringify(String(selector));
}

async function swipeDirection(state, direction) {
  const size = screenSizeOf(await readScreen(state));
  if (!size) throw new FlowError("swipe: could not read the screen size from get_screen.");
  const { width, height } = size;
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const points = {
    UP: [cx, Math.round(height * 0.75), cx, Math.round(height * 0.25)],
    DOWN: [cx, Math.round(height * 0.25), cx, Math.round(height * 0.75)],
    LEFT: [Math.round(width * 0.75), cy, Math.round(width * 0.25), cy],
    RIGHT: [Math.round(width * 0.25), cy, Math.round(width * 0.75), cy],
  }[String(direction).toUpperCase()];
  if (!points) throw new FlowError(`swipe: direction must be UP, DOWN, LEFT or RIGHT, not ${direction}.`);
  const [x1, y1, x2, y2] = points;
  await send(state, "swipe", { x1, y1, x2, y2 });
}

async function execute(command, value, state) {
  if (command !== "inputText" && command !== "eraseText") await flushClear(state);
  switch (command) {
    case "launchApp": {
      const appId = typeof value === "string" ? value : (value?.appId ?? state.appId);
      if (!appId) throw new FlowError("launchApp: no appId in the flow's config or the command.");
      if (value && typeof value === "object") {
        for (const key of ["clearState", "clearKeychain", "stopApp", "permissions"]) {
          if (key in value && value[key] !== false) throw new FlowError(`launchApp: ${key} is not supported on CodeDroid.`);
        }
      }
      const activity = value?.arguments?.activity;
      await send(state, "open_app", { package: appId, ...(activity ? { activity } : {}) });
      return null;
    }
    case "tapOn":
    case "longPressOn": {
      const result = await send(state, command === "tapOn" ? "tap" : "long_press", tapArgsOf(value, command));
      const after = afterOf(result);
      return after ? `screen_changed: ${after.screen_changed}` : null;
    }
    case "inputText": {
      const clear = state.pendingClear;
      state.pendingClear = false;
      await send(state, "type_text", { text: String(value ?? ""), clear });
      return null;
    }
    case "eraseText":
      state.pendingClear = true;
      return null;
    case "pressKey": {
      const key = CODEDROID_KEYS[String(value).toLowerCase()];
      if (!key) throw new FlowError(`pressKey: CodeDroid presses Enter, Home, Back or Recents, not ${value}.`);
      await send(state, "press_key", { key });
      return null;
    }
    case "back":
      await send(state, "press_key", { key: "back" });
      return null;
    case "swipe": {
      if (value && typeof value === "object" && value.start && value.end) {
        const point = (text) => {
          const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(String(text));
          if (!match) throw new FlowError(`swipe: start and end must be "x,y" in pixels; percentages are not supported on CodeDroid.`);
          return [Number(match[1]), Number(match[2])];
        };
        const [x1, y1] = point(value.start);
        const [x2, y2] = point(value.end);
        await send(state, "swipe", { x1, y1, x2, y2, ...(value.duration ? { duration_ms: Number(value.duration) } : {}) });
        return null;
      }
      const direction = typeof value === "string" ? value : value?.direction;
      if (!direction) throw new FlowError("swipe: needs start and end points, or a direction.");
      await swipeDirection(state, direction);
      return null;
    }
    case "scroll":
      await swipeDirection(state, "UP");
      return null;
    case "scrollUntilVisible": {
      const selector = value?.element ?? value;
      if (selector === undefined || selector === null) throw new FlowError("scrollUntilVisible: needs element.");
      const direction = String(value?.direction ?? "DOWN").toUpperCase();
      const swipe = { DOWN: "UP", UP: "DOWN", LEFT: "RIGHT", RIGHT: "LEFT" }[direction];
      if (!swipe) throw new FlowError(`scrollUntilVisible: direction must be UP, DOWN, LEFT or RIGHT, not ${direction}.`);
      for (let i = 0; i <= SCROLL_UNTIL_MAX_SWIPES; i++) {
        if (visibleOn(await readScreen(state), typeof selector === "object" ? selector : { text: String(selector) })) return `after ${i} swipes`;
        if (i === SCROLL_UNTIL_MAX_SWIPES) break;
        await swipeDirection(state, swipe);
      }
      throw new FlowError(`scrollUntilVisible: ${describeSelector(selector)} did not appear after ${SCROLL_UNTIL_MAX_SWIPES} swipes.`);
    }
    case "assertVisible":
    case "assertNotVisible": {
      const visible = command === "assertVisible";
      if (await waitUntil(state, value, { visible, timeoutMs: ASSERT_TIMEOUT_MS })) return null;
      throw new FlowError(`${command}: ${describeSelector(value)} is ${visible ? "not on" : "still on"} the screen after ${ASSERT_TIMEOUT_MS / 1000} s.`);
    }
    case "extendedWaitUntil": {
      const visible = value?.visible !== undefined;
      const selector = visible ? value.visible : value?.notVisible;
      if (selector === undefined) throw new FlowError("extendedWaitUntil: needs visible or notVisible.");
      const timeoutMs = Number(value.timeout ?? ASSERT_TIMEOUT_MS);
      if (await waitUntil(state, selector, { visible, timeoutMs })) return null;
      throw new FlowError(`extendedWaitUntil: ${describeSelector(selector)} ${visible ? "did not appear" : "did not go"} within ${timeoutMs} ms.`);
    }
    case "waitForAnimationToEnd":
      await sleep(Math.min(Number(value?.timeout ?? 1000), 5000));
      return null;
    case "hideKeyboard":
      await send(state, "dismiss_keyboard", {});
      return null;
    case "openLink": {
      const url = typeof value === "string" ? value : value?.link;
      if (!url) throw new FlowError("openLink: needs a link.");
      if (value && typeof value === "object" && (value.autoVerify || value.browser)) {
        throw new FlowError("openLink: autoVerify and browser are not supported on CodeDroid.");
      }
      await send(state, "open_url", { url: String(url) });
      return null;
    }
    case "takeScreenshot": {
      const result = await send(state, "take_screenshot", {});
      const image = result.content?.find((item) => item.type === "image");
      const name = typeof value === "string" ? value : (value?.path ?? `screenshot-${state.results.length + 1}`);
      if (!image) return "no image returned";
      if (!state.screenshotDir) return "not saved: no screenshot folder";
      const file = path.join(state.screenshotDir, `${path.basename(String(name)).replace(/\.(jpe?g|png)$/i, "")}.jpg`);
      fs.mkdirSync(state.screenshotDir, { recursive: true });
      fs.writeFileSync(file, Buffer.from(image.data, "base64"));
      return file;
    }
    case "runFlow": {
      if (state.depth >= 5) throw new FlowError("runFlow: flows nest more than 5 deep.");
      const file = typeof value === "string" ? value : value?.file;
      if (!file) throw new FlowError("runFlow: needs a file.");
      if (value && typeof value === "object" && ("when" in value || "commands" in value)) throw new FlowError("runFlow: when and inline commands are not supported on CodeDroid.");
      const resolved = path.resolve(state.baseDir, file);
      let text;
      try {
        text = fs.readFileSync(resolved, "utf8");
      } catch (e) {
        throw new FlowError(`runFlow: cannot read ${resolved}: ${e.message}`);
      }
      const nested = parseFlow(text, { file: resolved });
      const run = await runFlow(
        { ...nested, env: { ...state.env, ...nested.env, ...(value?.env ?? {}) }, appId: nested.appId ?? state.appId },
        state.call,
        { ...state, baseDir: path.dirname(resolved), depth: state.depth + 1, env: {} },
      );
      const failed = run.steps.find((s) => s.status === "fail");
      if (failed) throw new FlowError(`${path.basename(resolved)} step ${failed.index} ${failed.command}: ${failed.detail}`);
      return `${run.steps.length} steps`;
    }
    case "repeat": {
      const times = Number(value?.times);
      if (!Number.isInteger(times) || times < 1) throw new FlowError("repeat: needs times (while is not supported on CodeDroid).");
      const commands = (value.commands ?? []).map((c, i) => parseCommand(c, i + 1, "repeat"));
      for (let round = 1; round <= times; round++) {
        for (const step of commands) {
          const outcome = await runStep(step, state);
          if (outcome.status === "fail") throw new FlowError(`round ${round}, ${describeStep(step)}: ${outcome.detail}`);
        }
      }
      return `${times} rounds`;
    }
    case "codedroidTask": {
      const goal = typeof value === "string" ? value : value?.goal;
      if (!goal) throw new FlowError("codedroidTask: needs the goal.");
      const started = JSON.parse(textOf(await send(state, "run_task", { goal })));
      for (;;) {
        const task = JSON.parse(textOf(await send(state, "get_task", { task_id: started.task_id, wait_s: TASK_WAIT_S })));
        if (task.question) throw new FlowError(`codedroidTask asked a question nobody can answer in a flow: ${task.question}`);
        if (task.status === "running" || task.status === "queued") continue;
        if (task.status === "done" && task.success !== false) return task.reply ? String(task.reply).split("\n")[0] : null;
        throw new FlowError(`codedroidTask ended ${task.status}: ${task.reply ?? task.hint ?? ""}`);
      }
    }
    default:
      throw new FlowError(`${command} is not supported on CodeDroid. Supported: ${SUPPORTED_COMMANDS.join(", ")}.`);
  }
}
