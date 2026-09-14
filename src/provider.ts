import type { AttachedFile } from "./types.js";
import type { AgentRunArgs, RuntimeExecution } from "./runtime-types.js";

export interface ProviderCapabilities {
  attachments?: boolean;
  systemRole?: boolean;
  toolCalls?: boolean;
  structuredOutput?: boolean;
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
  execution?: RuntimeExecution;
}

export interface CompleteChatArgs {
  system?: string;
  user: string;
  model?: string;
  attachments?: AttachedFile[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  params?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  readonly capabilities?: ProviderCapabilities;
  complete(prompt: string): Promise<ProviderResult>;
  completeChat?(args: CompleteChatArgs): Promise<ProviderResult>;
  runAgent?(args: AgentRunArgs): Promise<ProviderResult>;
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
