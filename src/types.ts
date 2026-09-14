import type { Provider } from "./provider.js";
import type { ToolCall, ToolChoice, ToolDef } from "./provider.js";
import type { RuntimeChecks, VerificationCommand } from "./runtime-types.js";

export type { ToolCall, ToolChoice, ToolDef } from "./provider.js";

export interface AttachedFile {
  path: string;
  content: string;
  kind: "text" | "binary-skipped" | "missing" | "too-large";
  bytes?: number;
}

// ─── tool-call assertions (deterministic, no LLM judge) ──────────────────────
// Graded locally against the structured `tool_calls` returned by the model.
// `path` is dot-notation into the parsed arguments object, e.g. "command",
// "input.command", "files[0]". Each assertion produces a normal AssertionResult.

export type ToolAssertion =
  | { type: "tool-called";       name: string;                                                description?: string }
  | { type: "tool-not-called";   name: string;                                                description?: string }
  | { type: "tool-arg-equals";   name: string; path: string; value: unknown;                  description?: string }
  | { type: "tool-arg-contains"; name: string; path: string; value: string;                   description?: string }
  | { type: "tool-arg-matches";  name: string; path: string; pattern: string; flags?: string; description?: string }
  | { type: "tool-call-count";   name?: string; min?: number; max?: number;                   description?: string };

export interface AgentSkillsEval {
  /** Native skill loading expectation; supported only by agent runtimes. */
  should_trigger?: boolean;
  runtime_checks?: RuntimeChecks;
  verification?: VerificationCommand[];
  captured_files?: string[];
  id?: number | string;
  name?: string;
  prompt: string;
  expected_output?: string;
  files?: string[];
  /** Free-form rubric assertions graded by the LLM judge. */
  assertions?: string[];
  /** Inference params (passthrough) for this case; merged over skill defaults. */
  params?: Record<string, unknown>;
  /** Tools available to the model for this case. Falls back to skill defaults. */
  tools?: ToolDef[];
  /** Tool selection control; defaults to `"auto"` when tools are present. */
  tool_choice?: ToolChoice;
  /** Deterministic checks against the structured tool_calls returned. */
  tool_assertions?: ToolAssertion[];
}

export interface SkillDefaults {
  target?: { params?: Record<string, unknown> };
  judge?: { params?: Record<string, unknown> };
  /** Tools provided to every case in this skill unless the case overrides. */
  tools?: ToolDef[];
}

export interface Skill {
  name: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  dir: string;
  skillMd: string;
  references: AttachedFile[];
  scripts: AttachedFile[];
  evals: AgentSkillsEval[];
  evalFilesDir?: string;
  /** Skill-level defaults parsed from the top-level `defaults` block of evals.json. */
  defaults?: SkillDefaults;
}

export type RunMode = "with_skill" | "without_skill";

export interface SkillModelTarget {
  model: string;
  provider: Provider;
}

export interface AssertionResult {
  category?: "process" | "outcome" | "style" | "efficiency";
  text: string;
  passed: boolean;
  evidence: string;
}

export interface GradingJson {
  assertion_results: AssertionResult[];
  summary: { passed: number; failed: number; total: number; pass_rate: number };
  categories?: Partial<Record<"process" | "outcome" | "style" | "efficiency", { passed: number; failed: number; total: number; pass_rate: number }>>;
}

export interface AggStats {
  pass_rate: { mean: number; stddev: number };
  time_seconds: { mean: number; stddev: number };
  tokens: { mean: number; stddev: number };
}

export interface BenchmarkJson {
  runtime?: string;
  trigger_summary?: {
    true_positive: number; true_negative: number; false_positive: number; false_negative: number;
    unknown: number; total: number; accuracy: number | null; false_positive_rate: number | null; false_negative_rate: number | null;
  };
  run_summary: {
    with_skill: AggStats;
    without_skill?: AggStats;
    delta?: { pass_rate: number; time_seconds: number; tokens: number };
  };
}

// ─── progress events ──────────────────────────────────────────────────────────
// Emitted by evaluateSkills / runEval as a typed event stream so callers can
// build their own UI. The bundled `consoleReporter` is the default consumer.

export interface SuiteStartEvent {
  type: "suite-start";
  skill: string;
  relPath: string;
  evalsCount: number;
  modes: RunMode[];
  target: string;
  judge: string;
}

export interface EvalStartEvent {
  type: "eval-start";
  skill: string;
  evalIndex: number;
  evalSlug: string;
  evalName?: string;
  evalId?: number | string;
  mode: RunMode;
  /** System message sent to the target model (only set in `with_skill` mode). */
  system?: string;
  /** User message sent to the target model. */
  user: string;
  /** Number of `evals[].files` attached / inlined for this run. */
  fileCount: number;
  /** Tools made available to the model for this run, if any. */
  tools?: ToolDef[];
  /** Tool selection control sent to the provider. */
  toolChoice?: ToolChoice;
}

export interface EvalEndEvent {
  type: "eval-end";
  skill: string;
  evalIndex: number;
  evalSlug: string;
  evalName?: string;
  evalId?: number | string;
  mode: RunMode;
  /** Raw text returned by the target model. */
  output: string;
  timing: { total_tokens: number; duration_ms: number };
  grading: GradingJson;
  /** The prompt sent to the judge model for grading (useful for debugging). */
  judgePrompt?: string;
  /** Structured tool calls captured from the target model's response, if any. */
  toolCalls?: ToolCall[];
}

export interface SuiteEndEvent {
  type: "suite-end";
  skill: string;
  benchmarkPath: string;
  benchmark: BenchmarkJson;
}

export type SkillsEvent =
  | SuiteStartEvent
  | EvalStartEvent
  | EvalEndEvent
  | SuiteEndEvent;
