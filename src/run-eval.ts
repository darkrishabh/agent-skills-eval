import path from "node:path";
import type { Provider } from "./provider.js";
import type { ProviderResult } from "./provider.js";
import { writeRunArtifacts } from "./artifacts.js";
import { gradeOutputs } from "./grade.js";
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
  judge: { model: string; provider: Provider };
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
  }>;
}

function evalSlug(evalCase: AgentSkillsEval, index = 0): string {
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
    total_tokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
    duration_ms: result.latencyMs ?? 0,
  };
}

export async function runEval(args: RunEvalArgs): Promise<RunEvalResult> {
  if (args.modes.length === 0) throw new Error("runEval requires at least one mode");

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

  // If the target provider can natively discover skills on disk (e.g.
  // opencode's own skill-directory scan), let it — don't also inject the
  // skill into the prompt. `prepareSkill` installs/removes it per mode.
  const nativeSkillLoading = typeof args.target.provider.prepareSkill === "function";

  for (const mode of args.modes) {
    const runDir = path.join(evalDir, mode);
    const outputDir = path.join(runDir, "outputs");
    const evalFiles = mode === "with_skill" ? readEvalFiles(args.skill, args.eval) : [];
    const system = nativeSkillLoading
      ? undefined
      : mode === "with_skill"
        ? renderSkillSystemMessage(args.skill)
        : undefined;
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

    if (nativeSkillLoading) await args.target.provider.prepareSkill!(args.skill, mode);
    let completion: ProviderResult;
    try {
      completion = await completeWithFallback({
        provider: args.target.provider,
        system,
        user: userMessage,
        attachments: evalFiles,
        tools: effectiveTools,
        toolChoice: effectiveToolChoice,
        params: effectiveTargetParams,
      });
    } finally {
      if (nativeSkillLoading) await args.target.provider.cleanupSkill?.(args.skill, mode);
    }
    const rawOutput = completion.error
      ? `ERROR: ${completion.error}` +
        (completion.output ? `\n\n---partial output---\n${completion.output}` : "")
      : completion.output;
    const toolCalls = completion.toolCalls;
    const assertions =
      args.eval.assertions && args.eval.assertions.length > 0
        ? args.eval.assertions
        : args.eval.expected_output
          ? [`The output satisfies this expected output: ${args.eval.expected_output}`]
          : [];
    const { grading, judgePrompt } = await gradeOutputs({
      modelOutput: rawOutput,
      assertions,
      toolCalls,
      toolAssertions: args.eval.tool_assertions,
      judge: args.judge,
      judgeParams: effectiveJudgeParams,
      gradingPrompt: args.gradingPrompt,
    });
    const timing = timingFrom(completion);
    writeRunArtifacts(
      runDir,
      timing,
      grading,
      rawOutput,
      completion.outputFiles ?? [],
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
