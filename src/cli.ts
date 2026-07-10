#!/usr/bin/env node
import { Command } from "commander";
import { loadConfigFile, type AgentSkillsEvalConfig } from "./config.js";
import { consoleReporter } from "./console-reporter.js";
import { evaluateSkills } from "./evaluate-skills.js";
import { jsonlReporter, type JsonlReporter } from "./jsonl-reporter.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { OpencodeProvider } from "./opencode-provider.js";
import type { Provider } from "./provider.js";

interface CliOptions {
  config?: string;
  workspace?: string;
  baseline?: boolean;
  target?: string;
  judge?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  runMode?: "api" | "opencode";
  opencodeAgent?: string;
  opencodeAuto?: boolean;
  opencodeDir?: string;
  opencodeTimeout?: string;
  opencodeJudgeTimeout?: string;
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

function requireApiCredentials(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  apiKeyEnv: string
): { baseUrl: string; apiKey: string } {
  if (!baseUrl) throw new Error("provide --base-url or set OPENAI_BASE_URL");
  if (!apiKey) throw new Error(`environment variable ${apiKeyEnv} is not set`);
  return { baseUrl, apiKey };
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
    .option("--judge <model>", "Judge model name; defaults to --target")
    .option("--base-url <url>", "OpenAI-compatible API base URL")
    .option("--api-key-env <name>", "Environment variable containing the API key")
    .option("--run-mode <mode>", "Execution mode: api (default) or opencode")
    .option("--opencode-agent <name>", "opencode --agent to use")
    .option("--opencode-auto", "Auto-approve opencode permissions (dangerous)")
    .option("--no-opencode-auto", "Disable opencode auto-approve, overriding config file")
    .option("--opencode-dir <path>", "Working directory for opencode runs")
    .option("--opencode-timeout <ms>", "opencode subprocess timeout in milliseconds")
    .option(
      "--opencode-judge-timeout <ms>",
      "opencode judge/grader subprocess timeout in milliseconds; defaults to --opencode-timeout"
    )
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
  const targetModel = opts.target ?? config.target ?? "gpt-4o-mini";
  const judgeModel = opts.judge ?? config.judge ?? targetModel;
  const apiKeyEnv = opts.apiKeyEnv ?? config.apiKeyEnv ?? "OPENAI_API_KEY";
  const baseUrl = opts.baseUrl ?? config.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiKey = process.env[apiKeyEnv];
  const runMode = opts.runMode ?? config.runMode ?? "api";
  const include = opts.include && opts.include.length > 0 ? opts.include : config.include;
  const exclude = opts.exclude && opts.exclude.length > 0 ? opts.exclude : config.exclude;
  const concurrency = opts.concurrency !== undefined
    ? Number.parseInt(opts.concurrency, 10)
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
  const opencodeAgent = opts.opencodeAgent ?? config.opencode?.agent;
  const opencodeBaseUrl = config.opencode?.baseUrl;
  const opencodeAuto = opts.opencodeAuto ?? config.opencode?.auto ?? false;
  const opencodeDir = opts.opencodeDir ?? config.opencode?.dir ?? process.cwd();
  const opencodeTimeoutMs =
    opts.opencodeTimeout !== undefined
      ? Number.parseInt(opts.opencodeTimeout, 10)
      : config.opencode?.timeoutMs ?? 5 * 60 * 1000;
  const opencodeJudgeTimeoutMs =
    opts.opencodeJudgeTimeout !== undefined
      ? Number.parseInt(opts.opencodeJudgeTimeout, 10)
      : config.opencode?.judgeTimeoutMs ?? opencodeTimeoutMs;

  if (runMode !== "api" && runMode !== "opencode") {
    throw new Error('--run-mode must be "api" or "opencode"');
  }
  if (runMode === "api") {
    if (!baseUrl) {
      throw new Error("provide --base-url or set OPENAI_BASE_URL");
    }
    if (!apiKey) {
      throw new Error(`environment variable ${apiKeyEnv} is not set`);
    }
  }
  if (runMode === "opencode" && !opts.target && !config.target) {
    throw new Error(
      '--target is required when --run-mode is "opencode" (use "provider/model", e.g. "anthropic/claude-sonnet-5")'
    );
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
  if (runMode === "opencode" && (!Number.isInteger(opencodeTimeoutMs) || opencodeTimeoutMs < 1)) {
    throw new Error("--opencode-timeout must be a positive integer (milliseconds)");
  }
  if (runMode === "opencode" && (!Number.isInteger(opencodeJudgeTimeoutMs) || opencodeJudgeTimeoutMs < 1)) {
    throw new Error("--opencode-judge-timeout must be a positive integer (milliseconds)");
  }

  let target: Provider;
  let judge: Provider;
  if (runMode === "opencode") {
    target = new OpencodeProvider({
      providerName: "opencode",
      model: targetModel,
      agent: opencodeAgent,
      dir: opencodeDir,
      auto: opencodeAuto,
      timeoutMs: opencodeTimeoutMs,
      baseUrl: opencodeBaseUrl,
    });
    judge = new OpencodeProvider({
      providerName: "opencode",
      model: judgeModel,
      agent: opencodeAgent,
      dir: opencodeDir,
      auto: opencodeAuto,
      timeoutMs: opencodeJudgeTimeoutMs,
      baseUrl: opencodeBaseUrl,
    });
  } else {
    const creds = requireApiCredentials(baseUrl, apiKey, apiKeyEnv);
    target = new OpenAICompatibleProvider({
      providerName: "openai-compatible",
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      model: targetModel,
    });
    judge = new OpenAICompatibleProvider({
      providerName: "openai-compatible",
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      model: judgeModel,
    });
  }

  let closeReporter: (() => Promise<void>) | undefined;
  let onEvent;
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
      target: { model: targetModel, provider: target },
      judge: { model: judgeModel, provider: judge },
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
