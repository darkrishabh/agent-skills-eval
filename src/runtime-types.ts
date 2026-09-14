import type { AgentSkillsEval, AttachedFile, RunMode, Skill, ToolCall } from "./types.js";

export type RuntimeName = "codex" | "claude";
export interface TraceCommand {
  id: string;
  command: string;
  status: "completed" | "failed" | "unknown";
  exitCode?: number;
}
export interface NormalizedTrace {
  runtime: RuntimeName;
  output: string;
  commands: TraceCommand[];
  toolCalls: ToolCall[];
  skillInvocations: { name: string; evidence: string }[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs: number;
  complete: boolean;
  errors: string[];
  permissionDenials: string[];
}
export interface RuntimeChecks {
  requiredCommands?: string[];
  forbiddenCommands?: string[];
  commandOrder?: string[];
  requiredFiles?: string[];
  forbiddenFiles?: string[];
  fileContents?: { path: string; contains: string }[];
  allowedChanges?: string[];
  maxCommands?: number;
  maxRepeatedCommands?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
  noPermissionDenials?: boolean;
}
export interface VerificationCommand {
  name: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  /** For a server smoke check: launch command, poll this URL, then stop it. */
  url?: string;
}
export interface VerificationResult {
  name: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  error?: string;
}
export interface RuntimeExecution {
  trace: NormalizedTrace;
  workDir: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  outputFiles: AttachedFile[];
  changedFiles: string[];
  verification: VerificationResult[];
}
export interface AgentRunArgs {
  skill: Skill;
  eval: AgentSkillsEval;
  mode: RunMode;
  runDir: string;
}
export interface RuntimeOptions {
  runtime: RuntimeName;
  model?: string;
  executable?: string;
  /** Arguments preceding CLI arguments, e.g. a Node CLI entry point. */
  executableArgs?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Defaults to read-only / no noninteractive write approval. */
  allowWrites?: boolean;
  allowedTools?: string[];
}
