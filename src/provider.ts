import type { AttachedFile } from "./types.js";

export interface ProviderCapabilities {
  attachments?: boolean;
  systemRole?: boolean;
  toolCalls?: boolean;
}

export interface ToolFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolDef {
  type: "function";
  function: ToolFunctionDef;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ToolCall {
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
  parsedArguments?: unknown;
}

export interface ProviderResult {
  provider: string;
  model: string;
  output: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
  toolCalls?: ToolCall[];
  /** Provider-specific debug artifacts written alongside the run's other outputs (e.g. opencode's own server log). */
  outputFiles?: { path: string; content: string | Buffer }[];
}

export interface CompleteChatArgs {
  system?: string;
  user: string;
  model?: string;
  attachments?: AttachedFile[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  params?: Record<string, unknown>;
}

/** Minimal shape `prepareSkill`/`cleanupSkill` need — satisfied structurally by `Skill`. */
export interface SkillSource {
  name: string;
  /** Absolute path to the skill's folder on disk (contains SKILL.md, references/, scripts/, evals/). */
  dir: string;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  readonly capabilities?: ProviderCapabilities;
  complete(prompt: string): Promise<ProviderResult>;
  completeChat?(args: CompleteChatArgs): Promise<ProviderResult>;
  /**
   * Make `skill` discoverable the way this provider's agent natively finds
   * skills on disk (e.g. opencode's own skill-directory scan), instead of
   * injecting its content into the prompt. Called before every `complete`/
   * `completeChat` in `mode`; implementations should remove any previously
   * installed skill first, then (re)install only when `mode` is
   * `"with_skill"`. Providers that don't support native discovery should
   * omit this — callers fall back to injecting the skill into the prompt.
   */
  prepareSkill?(skill: SkillSource, mode: "with_skill" | "without_skill"): Promise<void>;
  /** Undo whatever `prepareSkill` installed, regardless of `mode`. */
  cleanupSkill?(skill: SkillSource, mode: "with_skill" | "without_skill"): Promise<void>;
}

export function createStaticProvider(output: string, options: Partial<ProviderResult> = {}): Provider {
  return {
    name: options.provider ?? "static",
    model: options.model ?? "static-model",
    async complete(): Promise<ProviderResult> {
      return {
        provider: options.provider ?? "static",
        model: options.model ?? "static-model",
        output,
        latencyMs: options.latencyMs ?? 0,
        inputTokens: options.inputTokens ?? 0,
        outputTokens: options.outputTokens ?? 0,
        costUsd: options.costUsd ?? 0,
        error: options.error,
        toolCalls: options.toolCalls,
      };
    },
  };
}
