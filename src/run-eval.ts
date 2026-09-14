import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Provider } from "./provider.js";
import type { ProviderResult } from "./provider.js";
import { writeRunArtifacts } from "./artifacts.js";
import { gradeOutputs } from "./grade.js";
import { gradeRuntime } from "./runtime.js";
import type { RuntimeExecution } from "./runtime-types.js";
import type { AssertionResult } from "./types.js";
import { parseRuntimeChecks, parseVerification, optionalBoolean, stringList } from "./runtime-config.js";
import type {
  AgentSkillsEval,
  AttachedFile,
  GradingJson,
  Skill,
  SkillsEvent,
  ToolCall,
  ToolChoice,
  ToolDef,
} from "./types.js";
import { attachedFileXml, readAttachedFile, slugify } from "./fs-utils.js";

export type RunMode = "with_skill" | "without_skill";

export interface RunEvalArgs {
  skill: Skill;
  eval: AgentSkillsEval;
  modes: RunMode[];
  target: { model: string; provider: Provider };
  judge?: { model: string; provider: Provider };
  workspace: string;
  iteration: number;
  gradingPrompt?: string;
  index?: number;
  evalRootDir?: string;
  /**
   * Caller-level inference param defaults for the target model. Lowest
   * precedence: skill `defaults.target.params` and eval `params` override.
   */
  targetParams?: Record<string, unknown>;
  /** Caller-level defaults for the judge model. */
  judgeParams?: Record<string, unknown>;
  /** Receives eval-start / eval-end events as each mode runs. */
  onEvent?: (event: SkillsEvent) => void;
}

export interface RunEvalResult {
  slug: string;
  modes: Record<RunMode, {
    outputDir: string;
    timing: { total_tokens: number; duration_ms: number };
    grading: GradingJson;
    rawOutput: string;
    toolCalls?: ToolCall[];
    /** System message sent to the target model (only set in `with_skill`). */
    system?: string;
    /** User message sent to the target model. */
    user: string;
    /** Number of attached `evals[].files`. */
    fileCount: number;
    /** Final prompt sent to the judge for grading. */
    judgePrompt: string;
    /** Tools made available for this run, if any. */
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
    execution?: RuntimeExecution;
  }>;
}

export function evalSlug(evalCase: AgentSkillsEval, index = 0): string {
  const source = evalCase.name ?? (evalCase.id !== undefined ? `eval-${String(evalCase.id)}` : `eval-${index + 1}`);
  const slug = slugify(source, `eval-${index + 1}`);
  return slug.startsWith("eval-") ? slug : `eval-${slug}`;
}

function renderSkillSystemMessage(skill: Skill): string {
  const parts = [
    `<skill name="${skill.name}">`,
    `<description>${skill.description ?? ""}</description>`,
    `<instructions>`,
    skill.skillMd,
    `</instructions>`,
  ];

  if (skill.references.length > 0) {
    parts.push(`<references>`);
    for (const ref of skill.references) parts.push(attachedFileXml("reference", ref));
    parts.push(`</references>`);
  }

  if (skill.scripts.length > 0) {
    parts.push(`<scripts>`);
    for (const script of skill.scripts) parts.push(attachedFileXml("script", script));
    parts.push(`</scripts>`);
  }

  parts.push(`</skill>`);
  return parts.join("\n");
}

function readEvalFiles(skill: Skill, evalCase: AgentSkillsEval): AttachedFile[] {
  return (evalCase.files ?? []).map((relativePath) =>
    readAttachedFile(skill.dir, relativePath)
  );
}

function inlineFiles(user: string, files: AttachedFile[]): string {
  if (files.length === 0) return user;
  return [
    ...files.map((file) => attachedFileXml("file", file)),
    "---USER PROMPT---",
    user,
  ].join("\n\n");
}

async function completeWithFallback(args: {
  provider: Provider;
  system?: string;
  user: string;
  attachments: AttachedFile[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  params?: Record<string, unknown>;
}): Promise<ProviderResult> {
  const { provider, system, tools, toolChoice, params } = args;
  let user = args.user;
  let attachments: AttachedFile[] | undefined;

  if (provider.capabilities?.attachments) {
    attachments = args.attachments;
  } else {
    user = inlineFiles(user, args.attachments);
  }

  if (provider.completeChat && provider.capabilities?.systemRole) {
    return provider.completeChat({
      system,
      user,
      attachments,
      tools,
      toolChoice,
      params,
    });
  }

  const merged = [system, "", "---USER REQUEST---", user].filter(Boolean).join("\n");
  return provider.complete(merged);
}

function mergeParams(
  ...layers: (Record<string, unknown> | undefined)[]
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  let any = false;
  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(merged, layer);
    any = true;
  }
  return any ? merged : undefined;
}

function timingFrom(result: ProviderResult): { total_tokens: number; duration_ms: number } {
  return {
    total_tokens: result.execution && result.inputTokens === 0 && result.outputTokens === 0 &&
      (result.execution.trace.inputTokens === undefined || result.execution.trace.outputTokens === undefined)
      ? -1 : (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
    duration_ms: result.latencyMs ?? 0,
  };
}

export async function runEval(args: RunEvalArgs): Promise<RunEvalResult> {
  if (args.modes.length === 0) throw new Error("runEval requires at least one mode");
  validateEvalTarget(args.eval, args.target.provider, args.judge);

  const slug = evalSlug(args.eval, args.index);
  const evalDir = path.join(args.evalRootDir ?? path.join(args.workspace, `iteration-${args.iteration}`), slug);
  const result: RunEvalResult = { slug, modes: {} as RunEvalResult["modes"] };
  const evalIndex = args.index ?? 0;

  // Resolve effective tools / tool_choice / params for this case once.
  // Precedence (low → high): caller programmatic args, skill defaults, eval-level.
  const effectiveTools: ToolDef[] | undefined =
    args.eval.tools ?? args.skill.defaults?.tools;
  const effectiveToolChoice: ToolChoice | undefined =
    args.eval.tool_choice ?? (effectiveTools && effectiveTools.length > 0 ? "auto" : undefined);
  const effectiveTargetParams = mergeParams(
    args.targetParams,
    args.skill.defaults?.target?.params,
    args.eval.params
  );
  const effectiveJudgeParams = mergeParams(
    args.judgeParams,
    args.skill.defaults?.judge?.params
  );

  for (const mode of args.modes) {
    const runDir = path.join(evalDir, mode);
    const outputDir = path.join(runDir, "outputs");
    const evalFiles = readEvalFiles(args.skill, args.eval);
    const system = mode === "with_skill" && !args.target.provider.runAgent ? renderSkillSystemMessage(args.skill) : undefined;
    const userMessage = args.eval.prompt;

    args.onEvent?.({
      type: "eval-start",
      skill: args.skill.name,
      evalIndex,
      evalSlug: slug,
      evalName: args.eval.name,
      evalId: args.eval.id,
      mode,
      system,
      user: userMessage,
      fileCount: evalFiles.length,
      tools: effectiveTools,
      toolChoice: effectiveToolChoice,
    });

    let completion: ProviderResult;
    try {
      completion = args.target.provider.runAgent
        ? await args.target.provider.runAgent({ skill: args.skill, eval: args.eval, mode, runDir })
        : await completeWithFallback({
          provider: args.target.provider, system, user: userMessage, attachments: evalFiles,
          tools: effectiveTools, toolChoice: effectiveToolChoice, params: effectiveTargetParams,
        });
    } catch (error) {
      completion = { provider: args.target.provider.name, model: args.target.model, output: "", inputTokens: 0,
        outputTokens: 0, costUsd: 0, latencyMs: 0, error: error instanceof Error ? error.message : String(error) };
    }
    const rawOutput = completion.error ? `ERROR: ${completion.error}` : completion.output;
    const toolCalls = completion.toolCalls;
    const assertions =
      args.eval.assertions && args.eval.assertions.length > 0
        ? args.eval.assertions
        : args.eval.expected_output
          ? [`The output satisfies this expected output: ${args.eval.expected_output}`]
          : [];
    const { grading: rubric, judgePrompt, judgeResponse } = await gradeOutputs({
      modelOutput: rawOutput,
      outputFiles: completion.execution?.outputFiles,
      assertions,
      toolCalls,
      toolAssertions: args.eval.tool_assertions,
      judge: args.judge,
      judgeParams: effectiveJudgeParams,
      gradingPrompt: args.gradingPrompt,
    });
    const deterministic: AssertionResult[] = completion.execution
      ? gradeRuntime(completion.execution, args.eval.runtime_checks ?? {}, {
        skillName: args.skill.name,
        shouldTrigger: args.eval.should_trigger === undefined ? undefined : mode === "with_skill" && args.eval.should_trigger,
      })
      : [];
    if (completion.error) deterministic.push({ text: "Target completed successfully", passed: false, evidence: completion.error, category: "outcome" });
    if (args.target.provider.runAgent && !completion.execution && !completion.error) deterministic.push({ text: "Runtime supplied execution evidence", passed: false, evidence: "Missing execution trace", category: "process" });
    const grading = summarizeGrading([...rubric.assertion_results, ...deterministic]);
    const timing = timingFrom(completion);
    writeRunArtifacts(
      runDir,
      timing,
      grading,
      rawOutput,
      [{ path: "output.txt", content: rawOutput }],
      {
        system,
        user: userMessage,
        judgePrompt,
        fileCount: evalFiles.length,
        tools: effectiveTools,
        tool_choice: effectiveToolChoice,
      },
      toolCalls
    );
    writeJson(runDir, "deterministic-grading.json", summarizeGrading([...rubric.assertion_results.filter(r => r.category === "process"), ...deterministic]));
    writeJson(runDir, "rubric-grading.json", summarizeGrading(rubric.assertion_results.filter(r => r.category !== "process")));
    writeFileSync(path.join(runDir, "judge-response.txt"), judgeResponse, "utf8");
    if (completion.execution) {
      const execution = completion.execution;
      writeJson(runDir, "trace.json", execution.trace);
      writeJson(runDir, "execution.json", execution);
      writeFileSync(path.join(runDir, "trace.jsonl"), execution.stdout, "utf8");
      writeFileSync(path.join(runDir, "stderr.txt"), execution.stderr, "utf8");
    }

    result.modes[mode] = {
      outputDir,
      timing,
      grading,
      rawOutput,
      toolCalls,
      system,
      user: userMessage,
      fileCount: evalFiles.length,
      judgePrompt,
      tools: effectiveTools,
      toolChoice: effectiveToolChoice,
      execution: completion.execution,
    };

    args.onEvent?.({
      type: "eval-end",
      skill: args.skill.name,
      evalIndex,
      evalSlug: slug,
      evalName: args.eval.name,
      evalId: args.eval.id,
      mode,
      output: rawOutput,
      timing,
      grading,
      judgePrompt,
      toolCalls,
    });
  }

  return result;
}

export function summarizeGrading(results: AssertionResult[]): GradingJson {
  const summary = (rows: AssertionResult[]) => {
    const passed = rows.filter(r => r.passed).length;
    return { passed, failed: rows.length - passed, total: rows.length, pass_rate: rows.length ? passed / rows.length : 1 };
  };
  const categories: GradingJson["categories"] = {};
  for (const category of ["process", "outcome", "style", "efficiency"] as const) {
    const rows = results.filter(r => r.category === category);
    if (rows.length) categories[category] = summary(rows);
  }
  return { assertion_results: results, summary: summary(results), categories };
}

function writeJson(dir: string, file: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function validateEvalTarget(evalCase: AgentSkillsEval, provider: Provider, judge?: { model: string; provider: Provider }): void {
  parseRuntimeChecks(evalCase.runtime_checks);
  parseVerification(evalCase.verification);
  optionalBoolean(evalCase.should_trigger, "should_trigger");
  stringList(evalCase.captured_files, "captured_files", true);
  if ((evalCase.should_trigger !== undefined || evalCase.runtime_checks || evalCase.verification?.length || evalCase.captured_files?.length) && !provider.runAgent) {
    throw new Error("Native runtime checks require a codex or claude runtime target");
  }
  if (provider.runAgent && (evalCase.tools?.length || evalCase.tool_choice || (evalCase.params && Object.keys(evalCase.params).length))) {
    throw new Error("Runtime targets use native tools and runtimeOptions; provider tools/tool_choice/params are not supported");
  }
  if (!judge && (evalCase.assertions?.length || evalCase.expected_output)) throw new Error("Rubric assertions require a judge; select a judge runtime or remove rubric assertions for deterministic-only runs");
  if (new Set(evalCase.assertions).size !== (evalCase.assertions?.length ?? 0)) throw new Error("Duplicate rubric assertions are not supported");
}
