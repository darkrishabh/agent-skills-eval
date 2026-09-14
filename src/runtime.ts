import fs from "node:fs";
import path from "node:path";
import type { AssertionResult, ToolCall } from "./types.js";
import type { NormalizedTrace, RuntimeChecks, RuntimeExecution, RuntimeName, TraceCommand } from "./runtime-types.js";

type JsonObject = Record<string, unknown>;
type TraceOptions = { skillName?: string; skillPath?: string; durationMs?: number };

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function metric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(block => string(object(block)?.text) ?? "").filter(Boolean).join("\n");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function selectedSkillPath(candidate: string, options: TraceOptions): boolean {
  const windows = process.platform === "win32" || /^[a-z]:[\\/]/i.test(candidate) || /^[a-z]:[\\/]/i.test(options.skillPath ?? "");
  const comparable = (value: string): string => windows ? normalizePath(value).toLowerCase() : normalizePath(value);
  const actual = comparable(candidate);
  if (options.skillPath) {
    const expected = comparable(options.skillPath);
    if (actual === expected) return true;
    // Runtimes can return absolute paths for the relative staged skill path.
    return !path.isAbsolute(options.skillPath) && !/^[a-z]:\//i.test(expected) && actual.endsWith(`/${expected}`);
  }
  return Boolean(options.skillName && actual.endsWith(comparable(`/${options.skillName}/SKILL.md`)));
}

/** Tokenize only the shell subset needed to identify direct, unambiguous file reads. */
function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let token = "";
  let quote = "";
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) words.push(token);
      token = "";
    } else if (";|&<>`".includes(char) || (char === "$" && command[index + 1] === "(")) {
      return undefined; // Compound/piped shell success does not prove that a read succeeded.
    } else {
      token += char;
    }
  }
  if (quote) return undefined;
  if (token) words.push(token);
  return words;
}

function readsSelectedSkill(command: string, options: TraceOptions, depth = 0): boolean {
  if (depth > 3) return false;
  const words = shellWords(command);
  if (!words?.length) return false;
  const executable = words[0].replace(/\\/g, "/").split("/").pop()!.replace(/\.exe$/i, "").toLowerCase();
  if (["sh", "bash", "zsh", "powershell", "pwsh"].includes(executable)) {
    const flag = words.findIndex(word => /^-(?:[il]*c|command)$/i.test(word));
    return flag > 0 && flag + 2 === words.length && readsSelectedSkill(words[flag + 1], options, depth + 1);
  }
  if (!["cat", "head", "tail", "sed", "get-content", "type", "more", "less"].includes(executable)) return false;
  if (words.some(word => /^(?:--help|--version|-help|\/\?)$/i.test(word))) return false;
  return words.slice(1).some(word => selectedSkillPath(word, options));
}

function call(id: string, name: string, input: JsonObject): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(input) }, parsedArguments: input };
}

/** Normalize JSONL emitted by `codex exec --json` or Claude's `--output-format stream-json`. */
export function normalizeTrace(runtime: RuntimeName, stdout: string, options: TraceOptions = {}): NormalizedTrace {
  const trace: NormalizedTrace = {
    runtime, output: "", commands: [], toolCalls: [], skillInvocations: [],
    durationMs: options.durationMs ?? 0, complete: false, errors: [], permissionDenials: [],
  };
  const commands = new Map<string, TraceCommand>();
  const calls = new Map<string, ToolCall>();
  const successfulCalls = new Set<string>();
  const resolvedCalls = new Set<string>();
  const messages = new Map<string, string>();
  let terminalSuccess = false;
  let terminalCount = 0;
  let eventCount = 0;

  function denial(evidence: string): void {
    if (!trace.permissionDenials.includes(evidence)) trace.permissionDenials.push(evidence);
  }

  for (const [index, line] of stdout.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: JsonObject | undefined;
    try { event = object(JSON.parse(line)); } catch { /* Report errors without echoing potentially sensitive raw output. */ }
    if (!event || typeof event.type !== "string") {
      trace.errors.push(`Invalid JSON event at line ${index + 1}: expected an object with a type.`);
      continue;
    }
    eventCount++;
    if (runtime === "codex") {
      if (event.type === "turn.completed") {
        terminalSuccess = true;
        terminalCount++;
        const usage = object(event.usage);
        trace.inputTokens = metric(usage?.input_tokens);
        trace.outputTokens = metric(usage?.output_tokens);
      } else if (event.type === "turn.failed" || event.type === "error") {
        const error = object(event.error);
        trace.errors.push(string(error?.message) ?? string(event.message) ?? "Codex reported an error.");
      } else if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
        const item = object(event.item);
        if (!item || typeof item.type !== "string") {
          trace.errors.push(`Invalid Codex item at line ${index + 1}.`);
          continue;
        }
        const id = string(item.id) ?? `line-${index + 1}`;
        if (item.type === "command_execution") {
          const text = string(item.command);
          if (text === undefined) {
            trace.errors.push(`Command ${id} is missing its command text.`);
            continue;
          }
          const exitCode = typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? item.exit_code : undefined;
          const completed = event.type === "item.completed";
          const rejected = item.status === "failed" || item.status === "declined";
          const status = completed && exitCode === 0 && !rejected ? "completed" : completed && (exitCode !== undefined || rejected) ? "failed" : "unknown";
          if (!commands.has(id) || completed || commands.get(id)?.status === "unknown") {
            commands.set(id, { id, command: text, status, ...(exitCode === undefined ? {} : { exitCode }) });
          }
          calls.set(id, call(id, "command_execution", { command: text }));
          if (completed) resolvedCalls.add(id);
          const output = string(item.aggregated_output) ?? "";
          if (status === "failed" && /permission denied|not permitted|approval.*(?:denied|reject)|sandbox.*denied/i.test(output)) denial(`${id}: ${output}`);
          if (item.status === "declined") denial(`${id}: command execution declined`);
        } else if (item.type === "agent_message" && event.type === "item.completed") {
          messages.set(id, string(item.text) ?? "");
        } else if (item.type === "mcp_tool_call") {
          const name = string(item.tool) ?? "mcp_tool_call";
          const input = object(item.arguments) ?? {};
          calls.set(id, call(id, name, input));
          if (event.type === "item.completed") resolvedCalls.add(id);
          if (event.type === "item.completed" && item.status === "completed" && !item.error) successfulCalls.add(id);
        }
      }
    } else {
      if (event.type === "assistant" || event.type === "user") {
        const message = object(event.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        if (event.type === "assistant") {
          const text = contentText(content);
          if (text) messages.set(string(message?.id) ?? `line-${index + 1}`, text);
          for (const block of content) {
            const item = object(block);
            if (item?.type !== "tool_use") continue;
            const id = string(item.id);
            const name = string(item.name);
            const input = object(item.input);
            if (!id || !name || !input) {
              trace.errors.push(`Invalid Claude tool use at line ${index + 1}.`);
              continue;
            }
            calls.set(id, call(id, name, input));
            if (name === "Bash" && typeof input.command === "string" && !commands.has(id)) commands.set(id, { id, command: input.command, status: "unknown" });
          }
        } else {
          for (const block of content) {
            const item = object(block);
            if (item?.type !== "tool_result") continue;
            const id = string(item.tool_use_id);
            if (!id || !calls.has(id)) {
              trace.errors.push(`Unmatched Claude tool result at line ${index + 1}.`);
              continue;
            }
            const toolResult = object(event.tool_use_result);
            const explicitExit = typeof toolResult?.exitCode === "number" ? toolResult.exitCode : typeof toolResult?.exit_code === "number" ? toolResult.exit_code : undefined;
            const failed = item.is_error === true || toolResult?.interrupted === true || (explicitExit !== undefined && explicitExit !== 0);
            resolvedCalls.add(id);
            if (!failed) successfulCalls.add(id);
            else successfulCalls.delete(id);
            const existing = commands.get(id);
            if (existing) commands.set(id, { ...existing, status: failed ? "failed" : "completed", ...(explicitExit !== undefined ? { exitCode: explicitExit } : failed ? {} : { exitCode: 0 }) });
            const text = contentText(item.content);
            if (failed && /permission denied|not permitted|not allowed|approval.*(?:denied|reject)|permission.*(?:denied|reject)/i.test(text)) denial(`${id}: ${text}`);
          }
        }
      } else if (event.type === "result") {
        terminalCount++;
        terminalSuccess = event.is_error !== true && event.subtype === "success";
        if (!terminalSuccess) {
          const errors = Array.isArray(event.errors) ? event.errors.filter((error): error is string => typeof error === "string") : [];
          trace.errors.push(...(errors.length ? errors : [string(event.result) ?? `Claude result: ${String(event.subtype ?? "unknown")}`]));
        }
        const result = string(event.result);
        if (result !== undefined) trace.output = result;
        if (event.structured_output !== undefined) trace.output = JSON.stringify(event.structured_output);
        const usage = object(event.usage);
        const input = metric(usage?.input_tokens);
        const cached = metric(usage?.cache_read_input_tokens);
        const created = metric(usage?.cache_creation_input_tokens);
        trace.inputTokens = input === undefined ? undefined : input + (cached ?? 0) + (created ?? 0);
        trace.outputTokens = metric(usage?.output_tokens);
        trace.costUsd = metric(event.total_cost_usd);
        if (Array.isArray(event.permission_denials)) for (const entry of event.permission_denials) denial(JSON.stringify(entry));
      } else if (event.type === "error") {
        trace.errors.push(string(event.message) ?? "Claude reported an error.");
      }
    }
  }

  if (!eventCount) trace.errors.push("No structured runtime events were emitted.");
  if (!terminalSuccess) trace.errors.push("A successful terminal completion event is missing.");
  if (terminalCount > 1) trace.errors.push("Multiple terminal completion events are ambiguous.");
  trace.commands = [...commands.values()];
  trace.toolCalls = [...calls.values()];
  const pending = [...calls.keys()].filter(id => !resolvedCalls.has(id));
  if (pending.length) trace.errors.push(`Incomplete tool results for: ${pending.join(", ")}.`);
  const unknownCommands = trace.commands.filter(command => command.status === "unknown");
  if (unknownCommands.length) trace.errors.push(`Incomplete command outcomes for: ${unknownCommands.map(command => command.id).join(", ")}.`);
  if (!trace.output) trace.output = [...messages.values()].filter(Boolean).join("\n");
  trace.complete = terminalSuccess && trace.errors.length === 0;

  if (options.skillName) {
    for (const command of trace.commands) {
      if (command.status === "completed" && readsSelectedSkill(command.command, options)) {
        trace.skillInvocations.push({ name: options.skillName, evidence: `Successful read (${command.id}): ${command.command}` });
      }
    }
    for (const id of successfulCalls) {
      const entry = calls.get(id)!;
      const input = object(entry.parsedArguments);
      const skill = string(input?.skill);
      const file = string(input?.file_path) ?? string(input?.path);
      const invoked = entry.function.name === "Skill" && skill === options.skillName;
      const read = entry.function.name === "Read" && file !== undefined && selectedSkillPath(file, options);
      if (invoked || read) trace.skillInvocations.push({ name: options.skillName, evidence: `Successful ${entry.function.name} (${id}): ${entry.function.arguments}` });
    }
  }
  return trace;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Resolve every existing ancestor, including junctions, before a grader reads outside data. */
function workspacePath(workDir: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error("Expected a relative workspace path.");
  const root = fs.realpathSync(workDir);
  const resolved = path.resolve(root, relative.replace(/\\/g, path.sep));
  if (!contained(root, resolved)) throw new Error("Path escapes the workspace.");
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.lstatSync(current);
      if (!contained(root, fs.realpathSync(current))) throw new Error("Symlink or junction escapes the workspace.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return resolved;
}

/** Portable glob subset: * matches a path segment, ** crosses directories, ? matches one character. */
function globMatches(value: string, glob: string): boolean {
  let pattern = "^";
  const normalized = glob.replace(/\\/g, "/");
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      index++;
      if (normalized[index + 1] === "/") { pattern += "(?:.*/)?"; index++; }
      else pattern += ".*";
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`).test(value.replace(/\\/g, "/"));
}

/** Evaluate deterministic process, outcome and efficiency assertions with concrete evidence. */
export function gradeRuntime(execution: RuntimeExecution, checks: RuntimeChecks, options: { skillName?: string; shouldTrigger?: boolean } = {}): AssertionResult[] {
  const results: AssertionResult[] = [];
  const { trace } = execution;
  const valid = execution.exitCode === 0 && trace.complete && trace.errors.length === 0;
  const add = (text: string, passed: boolean, evidence: string, category: "process" | "outcome" | "efficiency" = "process"): void => {
    results.push({ text, passed, evidence, category });
  };
  add("runtime execution completed", valid, `Exit code: ${execution.exitCode}; complete trace: ${trace.complete}; ${trace.errors.join("; ") || "no trace errors"}${execution.stderr ? `; stderr: ${execution.stderr.slice(0, 2000)}` : ""}`);
  if (options.shouldTrigger !== undefined) {
    const observed = trace.skillInvocations.filter(invocation => invocation.name === options.skillName);
    add(`skill trigger: expected ${options.shouldTrigger}`, valid && Boolean(options.skillName) && (observed.length > 0) === options.shouldTrigger,
      !valid ? "Trigger is unknown because execution or trace is incomplete/invalid." : observed.length ? observed.map(invocation => invocation.evidence).join("; ") : `No successful loading/invocation of ${options.skillName ?? "a selected skill"} observed in the complete trace.`);
  }
  const successful = trace.commands.filter(command => command.status === "completed");
  for (const required of checks.requiredCommands ?? []) {
    const matches = successful.filter(command => command.command.includes(required));
    add(`required command: ${required}`, valid && matches.length > 0, matches.length ? matches.map(command => `${command.id}: ${command.command}`).join("; ") : "No successful matching command observed.");
  }
  for (const forbidden of checks.forbiddenCommands ?? []) {
    const matches = trace.commands.filter(command => command.command.includes(forbidden));
    add(`forbidden command: ${forbidden}`, valid && matches.length === 0, matches.length ? matches.map(command => `${command.id} (${command.status}): ${command.command}`).join("; ") : "No matching attempted command observed.");
  }
  if (checks.commandOrder !== undefined) {
    let next = 0;
    const evidence: string[] = [];
    for (const command of successful) {
      if (next < checks.commandOrder.length && command.command.includes(checks.commandOrder[next])) {
        evidence.push(`${command.id}: ${command.command}`);
        next++;
      }
    }
    add("command order", valid && next === checks.commandOrder.length, `${next}/${checks.commandOrder.length} commands matched in order. ${evidence.join(" -> ")}`);
  }
  const fileCheck = (text: string, relative: string, check: (absolute: string) => { passed: boolean; evidence: string }): void => {
    try {
      const result = check(workspacePath(execution.workDir, relative));
      add(text, result.passed, result.evidence, "outcome");
    } catch (error) { add(text, false, `${relative}: ${(error as Error).message}`, "outcome"); }
  };
  for (const relative of checks.requiredFiles ?? []) fileCheck(`required file: ${relative}`, relative, absolute => ({ passed: fs.existsSync(absolute) && fs.statSync(absolute).isFile(), evidence: `Checked regular file at ${relative}.` }));
  for (const relative of checks.forbiddenFiles ?? []) fileCheck(`forbidden file: ${relative}`, relative, absolute => ({ passed: !fs.existsSync(absolute), evidence: `${relative} ${fs.existsSync(absolute) ? "exists" : "does not exist"}.` }));
  for (const entry of checks.fileContents ?? []) fileCheck(`file content: ${entry.path}`, entry.path, absolute => ({ passed: fs.readFileSync(absolute, "utf8").includes(entry.contains), evidence: `Checked ${entry.path} for literal content ${JSON.stringify(entry.contains)}.` }));
  if (checks.allowedChanges !== undefined) {
    const disallowed = execution.changedFiles.filter(file => {
      try { workspacePath(execution.workDir, file); } catch { return true; }
      return !checks.allowedChanges!.some(glob => globMatches(file, glob));
    });
    add("allowed changes", disallowed.length === 0, disallowed.length ? `Disallowed changed paths: ${disallowed.join(", ")}` : `All ${execution.changedFiles.length} changed paths match the allowlist.`, "outcome");
  }
  if (checks.noPermissionDenials) add("no permission denials", valid && trace.permissionDenials.length === 0, trace.permissionDenials.length ? trace.permissionDenials.join("; ") : "No permission denials observed.");
  const seen = new Set<string>();
  let repeats = 0;
  for (const command of trace.commands) {
    const normalized = command.command.trim();
    if (seen.has(normalized)) repeats++;
    else seen.add(normalized);
  }
  const tokens = trace.inputTokens === undefined || trace.outputTokens === undefined ? undefined : trace.inputTokens + trace.outputTokens;
  const budgets: [keyof RuntimeChecks, number | undefined][] = [["maxCommands", trace.commands.length], ["maxRepeatedCommands", repeats], ["maxTokens", tokens], ["maxDurationMs", trace.durationMs], ["maxCostUsd", trace.costUsd]];
  for (const [name, actual] of budgets) {
    const limit = checks[name];
    if (typeof limit === "number") add(name, valid && actual !== undefined && Number.isFinite(actual) && actual <= limit, `${name}: observed ${actual ?? "unknown"}; limit ${limit}.`, "efficiency");
  }
  for (const verification of execution.verification) add(`verification: ${verification.name}`, verification.passed, `Exit code: ${verification.exitCode}; ${verification.error ?? ""}${verification.stdout ? `; stdout: ${verification.stdout.slice(0, 2000)}` : ""}${verification.stderr ? `; stderr: ${verification.stderr.slice(0, 2000)}` : ""}`, "outcome");
  return results;
}
