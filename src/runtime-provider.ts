import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_FILE_BYTES, isInsideDir, readAttachedFile, safeResolve, toPosixPath } from "./fs-utils.js";
import type { CompleteChatArgs, Provider, ProviderResult } from "./provider.js";
import type { AgentRunArgs, RuntimeExecution, RuntimeOptions, VerificationResult } from "./runtime-types.js";
import { normalizeTrace } from "./runtime.js";
import { runProcess, type ProcessResult } from "./runtime-process.js";

function copyTree(source: string, target: string): void {
  if (lstatSync(source).isSymbolicLink()) throw new Error(`Symlinks are not staged: ${source}`);
  if (statSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyTree(path.join(source, name), path.join(target, name));
  } else { mkdirSync(path.dirname(target), { recursive: true }); cpSync(source, target); }
}

export class RuntimeProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly capabilities = { systemRole: true, toolCalls: true, structuredOutput: true };
  constructor(readonly options: RuntimeOptions) {
    this.name = options.runtime;
    this.model = options.model ?? "default";
    for (const key of ["timeoutMs", "maxOutputBytes"] as const) {
      if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key]! <= 0)) throw new Error(`${key} must be positive`);
    }
  }

  private async invoke(cwd: string, prompt: string, judge = false, schema?: Record<string, unknown>, model?: string): Promise<ProcessResult> {
    const args = [...(this.options.executableArgs ?? [])];
    const selectedModel = model ?? this.options.model;
    const schemaPath = schema ? path.join(path.dirname(cwd), `schema-${path.basename(cwd)}.json`) : undefined;
    try {
      if (this.options.runtime === "codex") {
        args.push("exec", "--json", "--color", "never", "--sandbox", !judge && this.options.allowWrites ? "workspace-write" : "read-only", "-c", 'approval_policy="never"', "--skip-git-repo-check");
        if (judge) args.push("-c", "features.shell_tool=false");
        if (schemaPath) { writeFileSync(schemaPath, JSON.stringify(schema)); args.push("--output-schema", schemaPath); }
        if (selectedModel) args.push("--model", selectedModel);
        args.push("-");
      } else {
        args.push("-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", !judge && this.options.allowWrites ? "acceptEdits" : "dontAsk");
        if (judge) args.push("--tools", "");
        else if (this.options.allowedTools?.length) args.push("--allowedTools", this.options.allowedTools.join(","));
        if (schema) args.push("--json-schema", JSON.stringify(schema));
        if (selectedModel) args.push("--model", selectedModel);
      }
      return await runProcess({ command: this.options.executable ?? this.options.runtime, args, cwd, stdin: prompt,
        timeoutMs: this.options.timeoutMs, maxOutputBytes: this.options.maxOutputBytes });
    } finally { if (schemaPath && existsSync(schemaPath)) rmSync(schemaPath); }
  }

  private result(process: ProcessResult, skillName?: string, skillPath?: string): ProviderResult & { execution?: RuntimeExecution } {
    const trace = normalizeTrace(this.options.runtime, process.stdout, { skillName, skillPath, durationMs: process.durationMs });
    if (process.error) trace.errors.push(process.error);
    if (process.exitCode !== 0) trace.errors.push(`CLI exited with code ${process.exitCode}${process.stderr ? `: ${process.stderr.slice(0, 2000)}` : ""}`);
    return { provider: this.name, model: this.model, output: trace.output, latencyMs: process.durationMs,
      inputTokens: trace.inputTokens ?? 0, outputTokens: trace.outputTokens ?? 0, costUsd: trace.costUsd ?? 0,
      toolCalls: trace.toolCalls, ...(trace.errors.length ? { error: trace.errors.join("; ") } : {}) };
  }

  async complete(prompt: string): Promise<ProviderResult> { return this.completeChat({ user: prompt }); }

  async completeChat(args: CompleteChatArgs): Promise<ProviderResult> {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "skills-eval-judge-"));
    try {
      const prompt = args.system ? `<system>\n${args.system}\n</system>\n\n${args.user}` : args.user;
      return this.result(await this.invoke(scratch, prompt, true, args.outputSchema, args.model));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }

  async runAgent(args: AgentRunArgs): Promise<ProviderResult> {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "skills-eval-run-"));
    mkdirSync(args.runDir, { recursive: true });
    const defaultWorkDir = path.resolve(args.runDir, "workspace");
    const workDir = existsSync(defaultWorkDir) ? mkdtempSync(path.join(path.resolve(args.runDir), "workspace-")) : defaultWorkDir;
    try {
      for (const file of args.eval.files ?? []) {
        const from = safeResolve(args.skill.dir, file);
        const to = safeResolve(scratch, file);
        if (!from || !to || to.relativePath === "" || /^(?:\.git|\.agents|\.claude)(?:\/|$)/i.test(to.relativePath)) throw new Error(`Invalid fixture path: ${file}`);
        if (!existsSync(from.absolutePath)) throw new Error(`Missing fixture: ${file}`);
        if (!isInsideDir(realpathSync(args.skill.dir), realpathSync(from.absolutePath))) throw new Error(`Fixture escapes skill directory: ${file}`);
        copyTree(from.absolutePath, to.absolutePath);
      }
      let skillPath: string | undefined;
      if (args.mode === "with_skill") {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(args.skill.name)) throw new Error(`Invalid native skill name: ${args.skill.name}`);
        skillPath = path.join(scratch, this.options.runtime === "codex" ? ".agents" : ".claude", "skills", args.skill.name);
        mkdirSync(skillPath, { recursive: true });
        for (const entry of ["SKILL.md", "references", "scripts", "assets"]) {
          const source = path.join(args.skill.dir, entry);
          if (existsSync(source)) copyTree(source, path.join(skillPath, entry));
        }
        if (!existsSync(path.join(skillPath, "SKILL.md"))) throw new Error("Runtime skills require an on-disk SKILL.md");
        skillPath = toPosixPath(path.relative(scratch, path.join(skillPath, "SKILL.md")));
      }
      // Commit fixtures and native skill metadata before execution, giving both modes a clean baseline.
      const git = async (commands: string[]) => {
        const result = await runProcess({ command: "git", args: ["-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", ...commands], cwd: scratch, timeoutMs: 30000 });
        if (result.exitCode !== 0 || result.error) throw new Error(`Workspace git setup/status failed: ${result.error ?? result.stderr}`);
        return result.stdout;
      };
      await git(["init", "--quiet"]);
      await git(["add", "--all", "--force"]);
      await git(["-c", "user.name=Skills Eval", "-c", "user.email=skills-eval@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Evaluation fixtures"]);
      const baseline = (await git(["rev-parse", "HEAD"])).trim();
      const process = await this.invoke(scratch, args.eval.prompt);
      const verification: VerificationResult[] = [];
      for (const check of args.eval.verification ?? []) {
        const checked = await runProcess({ command: check.command, args: check.args, cwd: scratch,
          timeoutMs: check.timeoutMs ?? 60000, maxOutputBytes: this.options.maxOutputBytes, readyUrl: check.url });
        verification.push({ name: check.name, passed: checked.exitCode === 0 && !checked.error, ...checked });
      }
      const inspectionErrors: string[] = [];
      let changedFiles: string[] = [];
      try {
        const diff = await git(["diff", "--name-only", "--no-renames", "-z", baseline, "--"]);
        const untracked = await git(["ls-files", "--others", "-z"]);
        changedFiles = [...new Set((diff + untracked).split("\0").filter(Boolean).map(toPosixPath))].sort();
      } catch (error) { inspectionErrors.push(`Cannot inspect workspace changes: ${String(error)}`); }
      const paths = new Set([...(args.eval.captured_files ?? []), ...(args.eval.runtime_checks?.requiredFiles ?? []),
        ...(args.eval.runtime_checks?.forbiddenFiles ?? []), ...(args.eval.runtime_checks?.fileContents ?? []).map(file => file.path)]);
      const outputFiles = [...paths].map(file => {
        const resolved = safeResolve(scratch, file);
        if (resolved && existsSync(resolved.absolutePath) && !isInsideDir(realpathSync(scratch), realpathSync(resolved.absolutePath))) {
          inspectionErrors.push(`Captured path escapes workspace through a symlink: ${file}`);
          return { path: file, content: "", kind: "missing" as const };
        }
        if (resolved && existsSync(resolved.absolutePath) && statSync(resolved.absolutePath).isFile() && statSync(resolved.absolutePath).size > DEFAULT_MAX_FILE_BYTES) {
          const bytes = statSync(resolved.absolutePath).size;
          const descriptor = openSync(resolved.absolutePath, "r");
          try {
            const buffer = Buffer.alloc(DEFAULT_MAX_FILE_BYTES);
            const read = readSync(descriptor, buffer, 0, buffer.length, 0);
            const content = buffer.subarray(0, read);
            return { path: resolved.relativePath, content: content.includes(0) ? "" : content.toString("utf8"),
              kind: content.includes(0) ? "binary-skipped" as const : "too-large" as const, bytes };
          } finally { closeSync(descriptor); }
        }
        return readAttachedFile(scratch, file);
      });
      const trace = normalizeTrace(this.options.runtime, process.stdout, { skillName: args.skill.name, skillPath, durationMs: process.durationMs });
      if (process.error) trace.errors.push(process.error);
      if (process.exitCode !== 0) trace.errors.push(`CLI exited with code ${process.exitCode}`);
      trace.errors.push(...inspectionErrors);
      const execution: RuntimeExecution = { trace, workDir, stdout: process.stdout, stderr: process.stderr, exitCode: process.exitCode,
        outputFiles, changedFiles: changedFiles.sort(), verification };
      // Artifacts survive temp cleanup; skip symlinks and git internals rather than following agent-created links.
      cpSync(scratch, workDir, { recursive: true, filter: source => {
        if (path.relative(scratch, source).split(path.sep)[0] === ".git") return false;
        if (lstatSync(source).isSymbolicLink()) {
          trace.errors.push(`Artifact contains a symlink that cannot be safely preserved: ${toPosixPath(path.relative(scratch, source))}`);
          return false;
        }
        return true;
      } });
      const result = this.result(process, args.skill.name, skillPath);
      return { ...result, ...(trace.errors.length ? { error: [...new Set([result.error, ...trace.errors].filter(Boolean))].join("; ") } : {}), execution };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}
