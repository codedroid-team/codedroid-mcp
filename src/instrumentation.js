/**
 * `am instrument -r` output as what happened to each test. `am` exits 0 whether tests pass, fail or
 * crash the app, and the raw output is long enough to bury the one failure that matters.
 */
const OUTCOMES = new Map([
  [0, "passed"],
  [-1, "errored"],
  [-2, "failed"],
  [-3, "ignored"],
  [-4, "assumption failed"],
]);
const STARTED = 1;
const STACK_LINES = 30;

function label(fields) {
  return [fields.class, fields.test].filter(Boolean).join("#");
}

/** The start of [stack]: its top frames say where, and the rest repeats the test runner. */
function shortStack(stack) {
  const lines = (stack ?? "(no stack trace)").trim().split("\n");
  const cut = lines.length - STACK_LINES;
  return cut > 0 ? [...lines.slice(0, STACK_LINES), `…(${cut} more lines)`].join("\n") : lines.join("\n");
}

/**
 * @returns {{text: string, ok: boolean} | null} null for output with no instrumentation lines, such
 * as a run without -r. ok is false unless the run ended by itself and ran at least one test.
 */
export function summarizeInstrumentation(output) {
  // Devices put it after `onError: ... message=` on stdout and the exception's name on stderr.
  if (/^(?:onError: .*message=|android\.util\.AndroidException: )?INSTRUMENTATION_FAILED/m.test(output)) {
    return { text: `Instrumentation did not start.\n${output}`, ok: false };
  }
  if (!/^INSTRUMENTATION_(STATUS|RESULT|CODE)/m.test(output)) return null;

  const tests = [];
  const result = {};
  let fields = {};
  let open = null;
  let key = null;
  let total = null;
  let ended = false;
  for (const line of output.split(/\r?\n/)) {
    const status = /^INSTRUMENTATION_STATUS: (\w+)=(.*)$/.exec(line);
    const code = /^INSTRUMENTATION_STATUS_CODE: (-?\d+)/.exec(line);
    const final = /^INSTRUMENTATION_RESULT: (\w+)=(.*)$/.exec(line);
    if (status) {
      key = status[1];
      fields[key] = status[2];
    } else if (code) {
      const value = Number(code[1]);
      if (fields.numtests) total = fields.numtests;
      if (value === STARTED) {
        open = label(fields);
      } else if (OUTCOMES.has(value) && label(fields)) {
        tests.push({ name: label(fields), outcome: OUTCOMES.get(value), stack: fields.stack });
        open = null;
      }
      fields = {};
      key = null;
    } else if (final) {
      result[final[1]] = final[2];
      key = null;
    } else if (/^INSTRUMENTATION_CODE:/.test(line)) {
      ended = true;
      key = null;
    } else if (key) {
      fields[key] += `\n${line}`;
    }
  }

  const finished = ended && !result.shortMsg && !open;
  const counts = [...OUTCOMES.values()]
    .map((outcome) => [outcome, tests.filter((t) => t.outcome === outcome).length])
    .filter(([, count]) => count)
    .map(([outcome, count]) => `${count} ${outcome}`);
  const ran = `${tests.length}${total ? ` of ${total}` : ""} ${tests.length === 1 && !total ? "test" : "tests"}`;
  const time = /^Time: (.+)$/m.exec(output)?.[1];
  const lines = [];
  if (finished && tests.length) {
    lines.push(`Instrumentation finished: ${tests.length} ${tests.length === 1 ? "test" : "tests"}, ${counts.join(", ")}${time ? `, in ${time}s` : ""}.`);
  } else if (finished) {
    lines.push("Instrumentation finished, but no tests ran. Check the runner and any -e class or -e package filter.", output.trim());
  } else {
    lines.push(`Instrumentation did not finish: ${result.shortMsg?.replace(/\.$/, "") ?? "the run stopped before its result"}. ${ran} ended${counts.length ? ` (${counts.join(", ")})` : ""}.`);
    if (open) lines.push(`Was running ${open}.`);
    if (result.longMsg && result.longMsg !== result.shortMsg) lines.push(result.longMsg);
    if (result.shortMsg) lines.push("Read the crash with logcat -d -b crash.");
  }
  for (const test of tests.filter((t) => t.outcome === "failed" || t.outcome === "errored")) {
    lines.push(`\n${test.outcome.toUpperCase()} ${test.name}\n${shortStack(test.stack)}`);
  }
  return { text: lines.join("\n"), ok: finished && tests.length > 0 };
}
