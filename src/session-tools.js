/**
 * session-tools — what the daemon adds to one MCP session on top of the phone's tools:
 *
 *   get_screen options  interactive_only, max_depth and diff, applied here to the phone's reply.
 *   batch               several screen tool calls in one round trip, with the screen held.
 *   record_start/stop   the session's phone tool calls as a Maestro flow (flow.js).
 *   run_flow            a flow replayed on the phone with no model in the loop.
 *
 * Each session has its own state (the last screen it read per phone, its recording), so two
 * clients on one computer never see each other's diffs or steps. The screen itself is shared and
 * is held for a whole batch or flow, so another session's tap cannot land in the middle of one.
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { confinedFile } from "./adb-tool.js";
import { FlowError, Recorder, parseFlow, runFlow, textOf } from "./flow.js";
import { DEVICE_SCHEMA } from "./phones.js";
import { GET_SCREEN_OPTIONS, ScreenOptions } from "./screen-text.js";

/** Tools a batch may hold: they act on or read the screen, and answer within one call. */
export const BATCH_TOOLS = new Set([
  "get_screen",
  "tap",
  "long_press",
  "swipe",
  "type_text",
  "press_key",
  "open_app",
  "list_apps",
  "wait_for",
  "clipboard",
  "device_info",
  "open_url",
  "dismiss_keyboard",
  "alert",
  "scroll_until",
  "notifications",
  "logs",
]);
export const BATCH_MAX_STEPS = 20;
/** Tools Claude Code keeps loaded (code.claude.com/docs/en/mcp.md): the loop, and how to get going. */
export const ALWAYS_LOADED_TOOLS = new Set(["get_screen", "tap", "type_text", "swipe", "press_key", "open_app", "wait_for", "codedroid_status", "codedroid_devices"]);
const ALWAYS_LOAD_META = { "anthropic/alwaysLoad": true };

/** How long run_flow waits in one call before saying it is still running. */
const FLOW_WAIT_MS = 50_000;
const KEEP_FLOW_RESULT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 120_000;

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message) => ({ ...text(message), isError: true });

const BATCH_DESCRIPTION = `
Run several screen tool calls in one round trip, in order, with the phone held so nothing else acts between them. For a sequence you already know (tap a field, type, submit, wait_for the result), not for exploring: a step's result decides nothing, so read the screen first.

steps: up to ${BATCH_MAX_STEPS} of {tool, arguments} with tool one of ${[...BATCH_TOOLS].join(", ")}. Screenshots, tasks, install_apk and adb are not allowed.
stop_on_error (default true): stop at the first failing step; the reply says which, and which steps did not run. Node numbers from a get_screen inside the batch are not usable later in it: select by text or resource_id.
Each step's reply is returned under its number, with get_screen's options (interactive_only, max_depth, diff) honoured.
`.trim();

const RECORD_START_DESCRIPTION = `
Start recording this session's phone actions as a Maestro flow (YAML). From now until record_stop, every successful open_app, tap, long_press, type_text, swipe, press_key, wait_for, take_screenshot and run_task becomes a step; reads are not steps. A tap by node is written as a tap by the text, resource id or description that node showed. Call it before open_app, so the flow starts by launching the app, and before driving a test case by hand, so run_flow can repeat it later without you.
`.trim();

const RECORD_STOP_DESCRIPTION = `
Stop recording and return the flow as Maestro YAML. save_to writes it to a file in the project (e.g. e2e/flows/TC-12a.yaml) or the temp directory; the reply names the path and the step count. Steps Maestro cannot express are kept as comments in the file.
`.trim();

const RUN_FLOW_DESCRIPTION = `
Replay a Maestro flow on the phone with no model in the loop: a file (path) or inline YAML (yaml). Runs launchApp, tapOn, longPressOn, inputText, eraseText, pressKey, back, swipe, scroll, scrollUntilVisible, assertVisible, assertNotVisible, extendedWaitUntil, waitForAnimationToEnd, takeScreenshot, runFlow, repeat and codedroidTask (CodeDroid's own agent); any other command fails the run where it is, so a pass means every step ran. assertVisible waits up to 7 s as in Maestro. \${VAR} comes from the flow's env and the env argument.

The phone is held for the whole run. A run longer than ${FLOW_WAIT_MS / 1000} s answers "running": call again with the same path or yaml to keep waiting. The reply lists each step's result and, after a failure, the screen's first lines: drive the rest by hand from there, or fix the flow. screenshot_dir (in the project or temp) is where takeScreenshot steps save their images.
`.trim();

/** A flow job's key: the file, or the inline text. */
function flowKey(args) {
  if (args.path) return `path:${args.path}`;
  return `yaml:${createHash("sha256").update(String(args.yaml ?? "")).digest("hex")}`;
}

/**
 * @param {object} options
 * @param {import("./phones.js").Phones} options.phones
 * @param {string|null} options.cwd the client's working directory, for file paths
 * @param {Map} options.flowJobs runs under way, shared by the daemon's sessions
 */
export function createSessionTools({ phones, cwd = null, flowJobs = new Map() }) {
  const screens = new ScreenOptions();
  const recorder = new Recorder();

  /** One phone tool call: the options this computer adds, and the recording. */
  const handle = async ({ name, args = {}, forward }) => {
    const deviceKey = args.device ?? "";
    if (name === "get_screen") {
      const { options, phoneArgs } = ScreenOptions.split(args);
      const result = await forward(phoneArgs);
      return screens.apply(deviceKey, options, result);
    }
    const lastScreen = screens.last(deviceKey);
    const result = await forward(args);
    recorder.observe({ name, args, result, lastScreen });
    return result;
  };

  const shapeTool = (definition) => {
    let shaped = definition;
    if (definition.name === "get_screen") {
      const schema = definition.inputSchema ?? { type: "object" };
      shaped = { ...definition, inputSchema: { ...schema, properties: { ...schema.properties, ...GET_SCREEN_OPTIONS } } };
    }
    if (ALWAYS_LOADED_TOOLS.has(definition.name)) shaped = { ...shaped, _meta: { ...shaped._meta, ...ALWAYS_LOAD_META } };
    return shaped;
  };

  const batch = {
    definition: {
      name: "batch",
      title: "Several steps in one call",
      description: BATCH_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            maxItems: BATCH_MAX_STEPS,
            items: {
              type: "object",
              properties: {
                tool: { type: "string", enum: [...BATCH_TOOLS] },
                arguments: { type: "object" },
              },
              required: ["tool"],
            },
          },
          stop_on_error: { type: "boolean", default: true },
          device: DEVICE_SCHEMA,
        },
        required: ["steps"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: { ...ALWAYS_LOAD_META },
    },
    async handler({ steps, stop_on_error = true, device } = {}) {
      if (!Array.isArray(steps) || !steps.length) return failure("batch: steps must be a list of {tool, arguments}.");
      if (steps.length > BATCH_MAX_STEPS) return failure(`batch: at most ${BATCH_MAX_STEPS} steps; this has ${steps.length}.`);
      for (const [i, step] of steps.entries()) {
        if (!step || typeof step !== "object" || !BATCH_TOOLS.has(step.tool)) {
          return failure(`batch: step ${i + 1} must name one of ${[...BATCH_TOOLS].join(", ")}, not ${JSON.stringify(step?.tool)}.`);
        }
        if (step.tool === "get_screen" && step.arguments?.screenshot) return failure(`batch: step ${i + 1}: screenshots are not allowed in a batch.`);
      }
      const lines = [];
      let failedAt = null;
      try {
        await phones.withPhone(
          device,
          async ({ call }) => {
            for (const [i, step] of steps.entries()) {
              const { device: _ignored, ...args } = step.arguments ?? {};
              const result = await handle({ name: step.tool, args: device !== undefined ? { ...args, device } : args, forward: (phoneArgs) => {
                const { device: _d, ...sent } = phoneArgs;
                return call(step.tool, sent);
              } });
              lines.push(`#${i + 1} ${step.tool} ${JSON.stringify(args)}${result.isError ? " FAILED" : ""}`);
              lines.push(textOf(result));
              if (result.isError && stop_on_error) {
                failedAt = i + 1;
                break;
              }
            }
          },
          { timeout: STEP_TIMEOUT_MS },
        );
      } catch (e) {
        return failure(`batch: ${e.message}`);
      }
      if (failedAt !== null) {
        const left = steps.length - failedAt;
        lines.push(`Stopped at step ${failedAt}${left ? `; ${left} step${left === 1 ? "" : "s"} did not run` : ""}. Read the screen before going on.`);
        return failure(lines.join("\n"));
      }
      return text(lines.join("\n"));
    },
  };

  const recordStart = {
    definition: {
      name: "record_start",
      title: "Start recording a flow",
      description: RECORD_START_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "What the flow is for, e.g. the test case id. Written into the file." },
          device: DEVICE_SCHEMA,
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async handler({ name, device } = {}) {
      try {
        recorder.start({ name, device });
      } catch (e) {
        return failure(e.message);
      }
      return text(`Recording${name ? ` "${name}"` : ""}. Drive the phone, then call record_stop.`);
    },
  };

  const recordStop = {
    definition: {
      name: "record_stop",
      title: "Stop recording a flow",
      description: RECORD_STOP_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          save_to: { type: "string", description: "Where to write the YAML: a path in the project (relative to it, or absolute) or in the temp directory." },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async handler({ save_to } = {}) {
      let file = null;
      if (save_to !== undefined) {
        try {
          file = confinedFile(save_to, cwd, "record_stop", "save_to");
        } catch (e) {
          return failure(e.message);
        }
      }
      let flow;
      try {
        flow = recorder.stop();
      } catch (e) {
        return failure(e.message);
      }
      const summary =
        `${flow.steps} step${flow.steps === 1 ? "" : "s"}${flow.skipped ? `, ${flow.skipped} kept as comments` : ""}` +
        (flow.appId ? "" : "; no launchApp, so it starts wherever the phone is (call record_start before open_app to include it)");
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, flow.yaml);
        } catch (e) {
          return failure(`Recorded ${summary}, but could not write ${file}: ${e.message}\n\n${flow.yaml}`);
        }
        return text(`Wrote ${file}: ${summary}. Replay it with run_flow, or npx -y @codedroid/mcp flow run ${file}.\n\n${flow.yaml}`);
      }
      return text(`Recorded ${summary}. Pass save_to to write it to a file.\n\n${flow.yaml}`);
    },
  };

  const runFlowTool = {
    definition: {
      name: "run_flow",
      title: "Replay a flow",
      description: RUN_FLOW_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "A flow file in the project (relative to it, or absolute) or the temp directory." },
          yaml: { type: "string", description: "The flow's YAML, instead of a file." },
          env: { type: "object", description: "Values for ${VAR} in the flow.", additionalProperties: { type: "string" } },
          screenshot_dir: { type: "string", description: "Where takeScreenshot steps save their images (in the project or temp). Default: beside the flow file, under screenshots/." },
          device: DEVICE_SCHEMA,
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async handler(args = {}) {
      const { path: file, yaml, env, screenshot_dir, device } = args;
      if ((file === undefined) === (yaml === undefined)) return failure("run_flow: pass path or yaml, not both and not neither.");
      const key = flowKey(args);
      let job = flowJobs.get(key);
      if (!job || (job.done && Date.now() - job.finishedAt > KEEP_FLOW_RESULT_MS)) {
        let resolved = null;
        let flowText = yaml;
        let baseDir = cwd ?? process.cwd();
        let screenshotDir;
        try {
          if (file !== undefined) {
            resolved = confinedFile(file, cwd, "run_flow");
            flowText = fs.readFileSync(resolved, "utf8");
            baseDir = path.dirname(resolved);
          }
          screenshotDir = screenshot_dir !== undefined ? confinedFile(screenshot_dir, cwd, "run_flow", "screenshot_dir") : resolved ? path.join(baseDir, "screenshots") : undefined;
        } catch (e) {
          return failure(e.message);
        }
        let flow;
        try {
          flow = parseFlow(flowText, { file: resolved ?? "yaml" });
        } catch (e) {
          return failure(e.message);
        }
        if (!flow.steps.length) return failure(`run_flow: ${resolved ?? "the flow"} has no steps.`);
        job = { key, file: resolved, done: false, finishedAt: null, log: [], startedAt: Date.now() };
        job.promise = phones
          .withPhone(device, ({ call }) => runFlow(flow, call, { env, baseDir, screenshotDir, log: (line) => job.log.push(line) }), { timeout: STEP_TIMEOUT_MS })
          .then(
            (result) => ({ result }),
            (error) => ({ error }),
          )
          .then((outcome) => {
            job.done = true;
            job.finishedAt = Date.now();
            job.outcome = outcome;
            return outcome;
          });
        flowJobs.set(key, job);
      }
      const outcome = await Promise.race([job.promise, new Promise((resolve) => setTimeout(() => resolve(null), FLOW_WAIT_MS))]);
      if (!outcome) {
        return text(`Still running after ${Math.round((Date.now() - job.startedAt) / 1000)} s, at step ${job.log.length + 1}. Call run_flow again with the same ${file !== undefined ? "path" : "yaml"} to keep waiting.\n${job.log.join("\n")}`);
      }
      flowJobs.delete(key);
      if (outcome.error) {
        const message = outcome.error instanceof FlowError ? outcome.error.message : `run_flow: ${outcome.error.message}`;
        return failure(message);
      }
      const { ok, steps, screen } = outcome.result;
      const lines = steps.map((s) => `${s.status.toUpperCase()} ${s.text}${s.detail ? ` (${s.detail})` : ""}`);
      const header = ok ? `Passed: ${steps.length} step${steps.length === 1 ? "" : "s"}${job.file ? ` of ${job.file}` : ""}.` : `Failed at step ${steps.at(-1).index}${job.file ? ` of ${job.file}` : ""}.`;
      const body = [header, ...lines, ...(!ok && screen ? ["", "Screen now:", screen] : [])].join("\n");
      return ok ? text(body) : failure(body);
    },
  };

  return { shapeTool, interceptCall: handle, localTools: [batch, recordStart, recordStop, runFlowTool] };
}
