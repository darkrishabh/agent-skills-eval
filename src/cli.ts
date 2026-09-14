#!/usr/bin/env node
import { Command } from "commander";
import { loadConfigFile, type AgentSkillsEvalConfig } from "./config.js";
import { consoleReporter } from "./console-reporter.js";
import { evaluateSkills } from "./evaluate-skills.js";
import { jsonlReporter, type JsonlReporter } from "./jsonl-reporter.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { RuntimeProvider } from "./runtime-provider.js";
import { normalizeConfig } from "./config.js";
import type { Provider } from "./provider.js";

interface CliOptions {
  runtime?: "provider" | "codex" | "claude";
  judgeRuntime?: "provider" | "codex" | "claude" | "none";
  executable?: string;
  timeoutMs?: string;
  allowWrites?: boolean;
  config?: string;
  workspace?: string;
  baseline?: boolean;
  target?: string;
  judge?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  include?: string[];
  exclude?: string[];
  concurrency?: string;
  report?: boolean;
  color?: boolean;
  verbose?: boolean;
  layout?: "iteration" | "flat";
  strict?: boolean;
  logFormat?: "pretty" | "jsonl" | "silent";
  logFile?: string;
  reportTitle?: string;
  reportOutput?: string;
}

function list(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function reportEnabled(report: AgentSkillsEvalConfig["report"]): boolean | undefined {
  if (report === undefined) return undefined;
  if (typeof report === "boolean") return report;
  return report.enabled;
}

function reportTitle(report: AgentSkillsEvalConfig["report"]): string | undefined {
  return typeof report === "object" && report ? report.title : undefined;
}

function reportOutput(report: AgentSkillsEvalConfig["report"]): string | undefined {
  return typeof report === "object" && report ? report.output : undefined;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("agent-skills-eval")
    .description("Evaluate agentskills.io-style skills and write portable benchmark artifacts")
    .argument("[root]", "Directory to scan for SKILL.md files", ".")
    .option("--config <path>", "YAML or JSON config file")
    .option("--workspace <path>", "Workspace directory for artifacts")
    .option("--baseline", "Run both with_skill and without_skill modes")
    .option("--target <model>", "Target model name")
    .option("--runtime <runtime>", "Target runtime: provider, codex, or claude")
    .option("--judge-runtime <runtime>", "Judge: provider, codex, claude, or none; defaults to target runtime")
    .option("--executable <path>", "Path to the native target CLI executable")
    .option("--timeout-ms <number>", "Native target process timeout")
    .option("--allow-writes", "Enable native target workspace writes (no permission bypass)")
    .option("--no-allow-writes", "Use native target default noninteractive permissions")
    .option("--judge <model>", "Judge model name; defaults to --target")
    .option("--base-url <url>", "OpenAI-compatible API base URL")
    .option("--api-key-env <name>", "Environment variable containing the API key")
    .option("--include <glob>", "Include skill relPath glob", list, [])
    .option("--exclude <glob>", "Exclude skill relPath glob", list, [])
    .option("--concurrency <number>", "Eval cases to run in parallel")
    .option("--report", "Generate the static HTML report")
    .option("--no-report", "Skip HTML report generation")
    .option("--no-color", "Disable ANSI color")
    .option("--verbose", "Print full prompts, outputs, and judge prompts")
    .option("--layout <layout>", "Artifact layout: iteration or flat")
    .option("--strict", "Validate SKILL.md against agentskills.io before running")
    .option("--log-format <format>", "Logging format: pretty, jsonl, or silent")
    .option("--log-file <path>", "Write JSONL event logs to a file")
    .option("--report-title <title>", "HTML report title")
    .option("--report-output <path>", "HTML report output directory");

  program.parse(process.argv);
  const opts = program.opts<CliOptions>();
  const config = opts.config ? loadConfigFile(opts.config) : {};
  const root = program.args[0] !== undefined && program.args[0] !== "." ? program.args[0] : config.root ?? ".";
  const workspace = opts.workspace ?? config.workspace ?? "./agent-skills-workspace";
  const runtime = opts.runtime ?? config.runtime ?? "provider";
  const judgeRuntime = opts.judgeRuntime ?? config.judgeRuntime ?? runtime;
  const runtimeOptions = { ...config.runtimeOptions,
    ...(opts.executable !== undefined ? {executable:opts.executable} : {}),
    ...(opts.timeoutMs !== undefined ? {timeoutMs:Number(opts.timeoutMs)} : {}),
    ...(opts.allowWrites !== undefined ? {allowWrites:opts.allowWrites} : {}),
  };
  normalizeConfig({runtime, judgeRuntime, runtimeOptions});
  const targetModel = opts.target ?? config.target ?? (runtime === "provider" ? "gpt-4o-mini" : undefined);
  const judgeModel = opts.judge ?? config.judge ?? (judgeRuntime === runtime ? targetModel : judgeRuntime === "provider" ? "gpt-4o-mini" : undefined);
  const apiKeyEnv = opts.apiKeyEnv ?? config.apiKeyEnv ?? "OPENAI_API_KEY";
  const baseUrl = opts.baseUrl ?? config.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiKey = process.env[apiKeyEnv];
  const include = opts.include && opts.include.length > 0 ? opts.include : config.include;
  const exclude = opts.exclude && opts.exclude.length > 0 ? opts.exclude : config.exclude;
  const concurrency = opts.concurrency !== undefined
    ? Number(opts.concurrency)
    : config.concurrency ?? 4;
  const layout = opts.layout ?? config.layout ?? "iteration";
  const strict = opts.strict ?? config.strict ?? false;
  const enabledReport = opts.report ?? reportEnabled(config.report) ?? true;
  const title = opts.reportTitle ?? reportTitle(config.report);
  const output = opts.reportOutput ?? reportOutput(config.report);
  const logFormat = opts.logFormat ?? config.logging?.format ?? "pretty";
  const logFile = opts.logFile ?? config.logging?.file;
  const verbose = opts.verbose ?? config.logging?.verbose ?? false;
  const color = opts.color ?? config.logging?.color ?? "auto";

  const needsApi = runtime === "provider" || judgeRuntime === "provider";
  if (needsApi && !baseUrl) {
    throw new Error("provide --base-url or set OPENAI_BASE_URL");
  }
  if (needsApi && !apiKey) {
    throw new Error(`environment variable ${apiKeyEnv} is not set`);
  }
  if (layout !== "iteration" && layout !== "flat") {
    throw new Error('--layout must be "iteration" or "flat"');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (logFormat !== "pretty" && logFormat !== "jsonl" && logFormat !== "silent") {
    throw new Error('--log-format must be "pretty", "jsonl", or "silent"');
  }

  const apiProvider = (model: string | undefined) => new OpenAICompatibleProvider({
    providerName:"openai-compatible", baseUrl:baseUrl!, apiKey:apiKey!, model:model!, structuredOutput:config.structuredOutput,
  });
  const target: Provider = runtime === "provider" ? apiProvider(targetModel) : new RuntimeProvider({...runtimeOptions, runtime, model:targetModel});
  const judge: Provider | undefined = judgeRuntime === "none" ? undefined : judgeRuntime === "provider" ? apiProvider(judgeModel)
    : new RuntimeProvider({...config.judgeOptions, runtime:judgeRuntime, model:judgeModel});

  let closeReporter: (() => Promise<void>) | undefined;
  let onEvent = (_event: import("./types.js").SkillsEvent): void => {};
  if (logFormat === "pretty") {
    onEvent = consoleReporter({
      color,
      verbose,
      snippetLength: config.logging?.snippetLength,
    });
  } else if (logFormat === "jsonl") {
    const reporter: JsonlReporter = jsonlReporter({ file: logFile });
    onEvent = reporter.onEvent;
    closeReporter = reporter.close;
  }

  try {
    const result = await evaluateSkills({
      root,
      workspace,
      baseline: opts.baseline ?? config.baseline ?? false,
      target: { model: target.model, provider: target },
      judge: judge ? { model: judge.model, provider: judge } : undefined,
      include,
      exclude,
      concurrency,
      report: enabledReport,
      reportTitle: title,
      reportOutput: output,
      workspaceLayout: layout,
      strict,
      targetParams: config.targetParams,
      judgeParams: config.judgeParams,
      onEvent,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.failed > 0 ? 1 : 0;
  } finally {
    await closeReporter?.();
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
