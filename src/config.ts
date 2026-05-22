import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

export type LogFormat = "pretty" | "jsonl" | "silent";
export type WorkspaceLayout = "flat" | "iteration";

export interface AgentSkillsEvalConfig {
  root?: string;
  workspace?: string;
  baseline?: boolean;
  target?: string;
  judge?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  include?: string[];
  exclude?: string[];
  evalIds?: string[];
  concurrency?: number;
  strict?: boolean;
  layout?: WorkspaceLayout;
  report?: boolean | {
    enabled?: boolean;
    title?: string;
    output?: string;
  };
  logging?: {
    format?: LogFormat;
    verbose?: boolean;
    color?: boolean | "auto";
    snippetLength?: number;
    file?: string;
  };
  targetParams?: Record<string, unknown>;
  judgeParams?: Record<string, unknown>;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  return value;
}

function asBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${where} must be a boolean`);
  return value;
}

function asNumber(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${where} must be a finite number`);
  return value;
}

function asStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${where} must be an array of strings`);
  }
  return value;
}

function asParams(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function parseLayout(value: unknown): WorkspaceLayout | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "flat" || value === "iteration") return value;
  throw new Error('layout must be "flat" or "iteration"');
}

function parseLogFormat(value: unknown): LogFormat | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "pretty" || value === "jsonl" || value === "silent") return value;
  throw new Error('logging.format must be "pretty", "jsonl", or "silent"');
}

function parseReport(value: unknown): AgentSkillsEvalConfig["report"] {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const record = asRecord(value, "report");
  return {
    enabled: asBoolean(record.enabled, "report.enabled"),
    title: asString(record.title, "report.title"),
    output: asString(record.output, "report.output"),
  };
}

function parseLogging(value: unknown): AgentSkillsEvalConfig["logging"] {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, "logging");
  const color = record.color;
  if (color !== undefined && color !== "auto" && typeof color !== "boolean") {
    throw new Error('logging.color must be true, false, or "auto"');
  }
  return {
    format: parseLogFormat(record.format),
    verbose: asBoolean(record.verbose, "logging.verbose"),
    color: color as boolean | "auto" | undefined,
    snippetLength: asNumber(record.snippetLength, "logging.snippetLength"),
    file: asString(record.file, "logging.file"),
  };
}

export function normalizeConfig(raw: unknown): AgentSkillsEvalConfig {
  const record = asRecord(raw ?? {}, "config");
  return {
    root: asString(record.root, "root"),
    workspace: asString(record.workspace, "workspace"),
    baseline: asBoolean(record.baseline, "baseline"),
    target: asString(record.target, "target"),
    judge: asString(record.judge, "judge"),
    baseUrl: asString(record.baseUrl, "baseUrl"),
    apiKeyEnv: asString(record.apiKeyEnv, "apiKeyEnv"),
    include: asStringArray(record.include, "include"),
    exclude: asStringArray(record.exclude, "exclude"),
    evalIds: asStringArray(record.evalIds, "evalIds"),
    concurrency: asNumber(record.concurrency, "concurrency"),
    strict: asBoolean(record.strict, "strict"),
    layout: parseLayout(record.layout),
    report: parseReport(record.report),
    logging: parseLogging(record.logging),
    targetParams: asParams(record.targetParams, "targetParams"),
    judgeParams: asParams(record.judgeParams, "judgeParams"),
  };
}

export function loadConfigFile(filePath: string): AgentSkillsEvalConfig {
  const absolutePath = path.resolve(filePath);
  if (!existsSync(absolutePath)) throw new Error(`config file not found: ${absolutePath}`);
  const text = readFileSync(absolutePath, "utf-8");
  const ext = path.extname(absolutePath).toLowerCase();
  const raw = ext === ".json" ? JSON.parse(text) : load(text);
  return normalizeConfig(raw);
}
