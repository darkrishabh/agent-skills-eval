import type { Provider } from "./provider.js";
import type { ProviderResult } from "./provider.js";
import type { AttachedFile, ToolAssertion, ToolCall } from "./types.js";

export interface AssertionResult {
  text: string;
  passed: boolean;
  evidence: string;
}

export interface GradingJson {
  assertion_results: AssertionResult[];
  summary: { passed: number; failed: number; total: number; pass_rate: number };
}

export interface GradeOutputsArgs {
  modelOutput: string;
  outputFiles?: AttachedFile[];
  /** Free-form rubric assertions (graded by the LLM judge). */
  assertions: string[];
  /** Structured tool calls captured from the target model's response, if any. */
  toolCalls?: ToolCall[];
  /** Deterministic tool-call assertions (graded locally, no judge involved). */
  toolAssertions?: ToolAssertion[];
  judge: { model: string; provider: Provider };
  /** Inference parameters passed through to the judge model (passthrough). */
  judgeParams?: Record<string, unknown>;
  gradingPrompt?: string;
}

export interface GradeOutputsResult {
  grading: GradingJson;
  /** Final prompt sent to the judge (after any retry). Empty when no rubric assertions. */
  judgePrompt: string;
  /** Raw text the judge returned. Empty when no rubric assertions. */
  judgeResponse: string;
}

function truncate(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function extractJsonObject(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function summarize(grades: AssertionResult[]): GradingJson["summary"] {
  const passed = grades.filter((r) => r.passed).length;
  const total = grades.length;
  const failed = total - passed;
  return { passed, failed, total, pass_rate: total === 0 ? 1 : passed / total };
}

function normalizeRubricGrading(raw: unknown, assertions: string[]): AssertionResult[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("grading response must be an object");
  }
  const o = raw as Record<string, unknown>;
  const rawResults = o.assertion_results;
  if (!Array.isArray(rawResults)) {
    throw new Error("grading response missing assertion_results");
  }
  return assertions.map((text, index) => {
    const rawResult = rawResults[index] as unknown;
    if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
      return { text, passed: false, evidence: "judge omitted this assertion result" };
    }
    const r = rawResult as Record<string, unknown>;
    return {
      text,
      passed: r.passed === true,
      evidence: typeof r.evidence === "string" && r.evidence.trim()
        ? r.evidence.trim()
        : "judge did not provide concrete evidence",
    };
  });
}

function failClosed(assertions: string[], response: string): AssertionResult[] {
  const evidence = `judge returned unparseable response: ${truncate(response, 500)}`;
  return assertions.map((text) => ({ text, passed: false, evidence }));
}

function serializeToolCalls(toolCalls: ToolCall[] | undefined): string {
  if (!toolCalls || toolCalls.length === 0) return "(no tool calls)";
  return toolCalls
    .map((c, i) => {
      const args = c.parsedArguments !== undefined
        ? JSON.stringify(c.parsedArguments, null, 2)
        : c.function.arguments || "(empty)";
      return `[${i + 1}] ${c.function.name}\n${args}`;
    })
    .join("\n\n");
}

function renderRubricPrompt(
  args: GradeOutputsArgs,
  previousBadResponse?: string
): string {
  if (args.gradingPrompt) {
    return [
      args.gradingPrompt,
      "",
      "Assertions:",
      JSON.stringify(args.assertions, null, 2),
      "",
      "Model output:",
      args.modelOutput,
      args.toolCalls && args.toolCalls.length > 0
        ? `\n\nTool calls (structured):\n${serializeToolCalls(args.toolCalls)}`
        : "",
    ].join("\n");
  }

  const files = (args.outputFiles ?? [])
    .map((file) => `<output_file path="${file.path}" kind="${file.kind}">\n${file.content}\n</output_file>`)
    .join("\n\n") || "No output files were captured.";

  return [
    "You are grading an agentskills.io evaluation run.",
    "",
    "Grading principles:",
    "- Require concrete evidence for every PASS; quote or reference the output.",
    "- Do not give the benefit of the doubt.",
    "- PASS an assertion only if every condition in the assertion text holds.",
    "- A label without substance is a FAIL.",
    "- Tool calls (when present) are authoritative evidence of model behavior.",
    "",
    "Return STRICT JSON only. No markdown. Shape:",
    '{"assertion_results":[{"text":"...","passed":true,"evidence":"..."}],"summary":{"passed":0,"failed":0,"total":0,"pass_rate":0}}',
    "",
    "Rules:",
    "- Include every assertion exactly once and copy the full assertion text verbatim into text.",
    "- Use short concrete evidence: quote, snippet, or file reference.",
    "- Summary may be included, but it will be recomputed by the caller.",
    previousBadResponse ? `Previous response was not parseable JSON. Try again. Bad response: ${truncate(previousBadResponse, 500)}` : "",
    "",
    "Assertions:",
    JSON.stringify(args.assertions, null, 2),
    "",
    "Model output:",
    args.modelOutput || "(empty output)",
    args.toolCalls && args.toolCalls.length > 0
      ? `\nTool calls (structured):\n${serializeToolCalls(args.toolCalls)}`
      : "",
    "",
    "Output files:",
    files,
  ].filter(Boolean).join("\n");
}

async function callJudge(
  provider: Provider,
  prompt: string,
  params?: Record<string, unknown>
): Promise<ProviderResult> {
  if (provider.completeChat && provider.capabilities?.systemRole) {
    return provider.completeChat({
      system: "You are a strict JSON-only evaluator.",
      user: prompt,
      params,
    });
  }
  return provider.complete(prompt);
}

// ─── deterministic tool-call assertions ──────────────────────────────────────
// Graded locally with no LLM. Each ToolAssertion produces one AssertionResult.

function getByPath(root: unknown, path: string): unknown {
  if (root === undefined || root === null) return undefined;
  const tokens: (string | number)[] = [];
  const re = /[^.\[\]]+|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    tokens.push(m[1] !== undefined ? Number(m[1]) : m[0]);
  }
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[tok];
  }
  return cur;
}

// Structural equality: object key order is not significant, but array order is.
// Primitives compare by ===. Falls through nested objects/arrays recursively so
// that reordered keys (e.g. {limit,sort} vs {sort,limit}) grade as equal while
// reordered array elements still differ.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    if (aArr.length !== bArr.length) return false;
    return aArr.every((item, i) => deepEqual(item, bArr[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key])
  );
}

function describeToolAssertion(a: ToolAssertion): string {
  if (a.description) return a.description;
  switch (a.type) {
    case "tool-called":
      return `tool "${a.name}" was called`;
    case "tool-not-called":
      return `tool "${a.name}" was NOT called`;
    case "tool-arg-equals":
      return `${a.name}.${a.path} equals ${JSON.stringify(a.value)}`;
    case "tool-arg-contains":
      return `${a.name}.${a.path} contains ${JSON.stringify(a.value)}`;
    case "tool-arg-matches":
      return `${a.name}.${a.path} matches /${a.pattern}/${a.flags ?? ""}`;
    case "tool-call-count": {
      const bounds = [
        a.min !== undefined ? `>=${a.min}` : "",
        a.max !== undefined ? `<=${a.max}` : "",
      ].filter(Boolean).join(" and ");
      return `${a.name ?? "any tool"} called ${bounds} times`;
    }
  }
}

function callsByName(toolCalls: ToolCall[], name?: string): ToolCall[] {
  if (!name) return toolCalls;
  return toolCalls.filter((c) => c.function.name === name);
}

function gradeToolAssertion(
  assertion: ToolAssertion,
  toolCalls: ToolCall[]
): AssertionResult {
  const text = describeToolAssertion(assertion);
  const observedNames = toolCalls.map((c) => c.function.name).join(", ") || "(none)";

  switch (assertion.type) {
    case "tool-called": {
      const matches = callsByName(toolCalls, assertion.name);
      return matches.length > 0
        ? { text, passed: true, evidence: `${assertion.name} called ${matches.length} time(s)` }
        : { text, passed: false, evidence: `${assertion.name} not called; observed: ${observedNames}` };
    }
    case "tool-not-called": {
      const matches = callsByName(toolCalls, assertion.name);
      return matches.length === 0
        ? { text, passed: true, evidence: `confirmed: ${assertion.name} never called` }
        : { text, passed: false, evidence: `${assertion.name} was called ${matches.length} time(s)` };
    }
    case "tool-arg-equals": {
      const matches = callsByName(toolCalls, assertion.name);
      if (matches.length === 0) {
        return { text, passed: false, evidence: `${assertion.name} not called; observed: ${observedNames}` };
      }
      for (const c of matches) {
        if (c.parsedArguments === undefined) continue;
        const actual = getByPath(c.parsedArguments, assertion.path);
        if (deepEqual(actual, assertion.value)) {
          return {
            text,
            passed: true,
            evidence: `${assertion.name}.${assertion.path} = ${JSON.stringify(actual)}`,
          };
        }
      }
      const seen = matches
        .map((c) => JSON.stringify(getByPath(c.parsedArguments, assertion.path)))
        .join(", ");
      return {
        text,
        passed: false,
        evidence: `expected ${JSON.stringify(assertion.value)}; observed ${seen}`,
      };
    }
    case "tool-arg-contains": {
      const matches = callsByName(toolCalls, assertion.name);
      if (matches.length === 0) {
        return { text, passed: false, evidence: `${assertion.name} not called; observed: ${observedNames}` };
      }
      for (const c of matches) {
        if (c.parsedArguments === undefined) continue;
        const actual = getByPath(c.parsedArguments, assertion.path);
        if (typeof actual === "string" && actual.includes(assertion.value)) {
          return {
            text,
            passed: true,
            evidence: `${assertion.name}.${assertion.path} = ${JSON.stringify(actual)}`,
          };
        }
      }
      const seen = matches
        .map((c) => JSON.stringify(getByPath(c.parsedArguments, assertion.path)))
        .join(", ");
      return {
        text,
        passed: false,
        evidence: `expected substring ${JSON.stringify(assertion.value)}; observed ${seen}`,
      };
    }
    case "tool-arg-matches": {
      const matches = callsByName(toolCalls, assertion.name);
      if (matches.length === 0) {
        return { text, passed: false, evidence: `${assertion.name} not called; observed: ${observedNames}` };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(assertion.pattern, assertion.flags ?? "");
      } catch (err) {
        return {
          text,
          passed: false,
          evidence: `invalid regex /${assertion.pattern}/${assertion.flags ?? ""}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      for (const c of matches) {
        if (c.parsedArguments === undefined) continue;
        const actual = getByPath(c.parsedArguments, assertion.path);
        if (typeof actual === "string" && regex.test(actual)) {
          return {
            text,
            passed: true,
            evidence: `${assertion.name}.${assertion.path} = ${JSON.stringify(actual)}`,
          };
        }
      }
      const seen = matches
        .map((c) => JSON.stringify(getByPath(c.parsedArguments, assertion.path)))
        .join(", ");
      return {
        text,
        passed: false,
        evidence: `did not match /${assertion.pattern}/${assertion.flags ?? ""}; observed ${seen}`,
      };
    }
    case "tool-call-count": {
      const matches = callsByName(toolCalls, assertion.name);
      const count = matches.length;
      const minOk = assertion.min === undefined || count >= assertion.min;
      const maxOk = assertion.max === undefined || count <= assertion.max;
      return minOk && maxOk
        ? { text, passed: true, evidence: `${assertion.name ?? "tools"} called ${count} time(s)` }
        : {
            text,
            passed: false,
            evidence: `${assertion.name ?? "tools"} called ${count} time(s); expected ${
              [
                assertion.min !== undefined ? `>=${assertion.min}` : "",
                assertion.max !== undefined ? `<=${assertion.max}` : "",
              ]
                .filter(Boolean)
                .join(" and ")
            }`,
          };
    }
  }
}

export function runToolAssertions(
  toolCalls: ToolCall[] | undefined,
  toolAssertions: ToolAssertion[] | undefined
): AssertionResult[] {
  if (!toolAssertions || toolAssertions.length === 0) return [];
  const calls = toolCalls ?? [];
  return toolAssertions.map((a) => gradeToolAssertion(a, calls));
}

// ─── orchestrator ────────────────────────────────────────────────────────────

export async function gradeOutputs(args: GradeOutputsArgs): Promise<GradeOutputsResult> {
  const toolResults = runToolAssertions(args.toolCalls, args.toolAssertions);

  if (args.assertions.length === 0) {
    return {
      grading: { assertion_results: toolResults, summary: summarize(toolResults) },
      judgePrompt: "",
      judgeResponse: "",
    };
  }

  let badResponse = "";
  let lastPrompt = "";
  let lastText = "";
  let rubricResults: AssertionResult[] | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    lastPrompt = renderRubricPrompt(args, badResponse || undefined);
    const response = await callJudge(args.judge.provider, lastPrompt, args.judgeParams);
    lastText = response.output || response.error || "";
    try {
      rubricResults = normalizeRubricGrading(JSON.parse(extractJsonObject(lastText)), args.assertions);
      break;
    } catch {
      badResponse = lastText;
    }
  }

  if (!rubricResults) {
    rubricResults = failClosed(args.assertions, badResponse);
  }

  const combined = [...rubricResults, ...toolResults];
  return {
    grading: { assertion_results: combined, summary: summarize(combined) },
    judgePrompt: lastPrompt,
    judgeResponse: lastText,
  };
}
