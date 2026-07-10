import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk";
import type { Provider, ProviderResult, SkillSource, ToolCall } from "./provider.js";

export interface OpencodeOptions {
  /** Shown as `provider` in ProviderResult. Default "opencode". */
  providerName?: string;
  /** Required. "provider/model" form, e.g. "anthropic/claude-sonnet-5". */
  model: string;
  /** Forwarded as the session's `agent`. Omitted when unset. */
  agent?: string;
  /** Working directory for the opencode server and installed skills. Default process.cwd(). */
  dir?: string;
  /** Auto-approve opencode's own permission prompts (bash/file-edit/etc). Dangerous — see class doc comment. Default false. */
  auto?: boolean;
  /** Hard deadline for the whole call (initial prompt + waiting on delegated work + continuations), ms. Default 300_000 (5 minutes). */
  timeoutMs?: number;
  /** Max follow-up prompts issued to let the model pick up a delegated subagent's result. Default 3. */
  maxContinuations?: number;
  /** Test-only: talk to an already-running server instead of spawning one via `createOpencodeServer`. */
  baseUrl?: string;
}

interface RunOutcome {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errorMessage?: string;
}

const POLL_INTERVAL_MS = 250;
/** Grace period between SIGTERM and SIGKILL when tearing down our private opencode server. */
const SERVER_KILL_GRACE_MS = 3000;
/** How long to wait for `opencode serve` to print its listening URL before giving up. */
const SERVER_START_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SpawnedServer {
  url: string;
  close(): void;
  /** Combined stdout+stderr of the child process so far, including everything logged after startup. */
  getLog(): string;
}

/**
 * Spawns `opencode serve` directly (rather than via `@opencode-ai/sdk`'s
 * `createOpencodeServer`) so we keep a handle to the raw child process and
 * can escalate to SIGKILL if it doesn't honor SIGTERM promptly — the SDK
 * helper's `close()` only ever sends one SIGTERM with no escalation, which
 * left real orphaned `opencode serve` processes behind in testing.
 */
function spawnOpencodeServer(options: {
  hostname: string;
  port: number;
  permission?: Record<string, unknown>;
}): Promise<SpawnedServer> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      "opencode",
      ["serve", `--hostname=${options.hostname}`, `--port=${options.port}`],
      {
        shell: false,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(options.permission ? { permission: options.permission } : {}),
        },
      }
    );

    let settled = false;
    let output = "";

    const forceKill = () => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), SERVER_KILL_GRACE_MS);
      killTimer.unref();
    };

    const startTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      forceKill();
      reject(new Error(`Timeout waiting for opencode server to start after ${SERVER_START_TIMEOUT_MS}ms`));
    }, SERVER_START_TIMEOUT_MS);
    startTimer.unref();

    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (settled) return;
      const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (match) {
        settled = true;
        clearTimeout(startTimer);
        resolve({ url: match[1], close: forceKill, getLog: () => output });
      }
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(startTimer);
      if (!settled) {
        settled = true;
        reject(new Error(`opencode serve exited with code ${code} before it started listening${output.trim() ? `: ${output.trim()}` : ""}`));
      }
    });
    child.on("error", (err) => {
      clearTimeout(startTimer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx === -1) {
    throw new Error(`OpencodeProvider: model must be "provider/model" (e.g. "anthropic/claude-sonnet-5"), got "${model}"`);
  }
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** Best-effort message from an SDK error body (parsed JSON, not necessarily an Error instance). */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const obj = error as { data?: { message?: unknown }; message?: unknown; name?: unknown };
    if (typeof obj.data?.message === "string") return obj.data.message;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.name === "string") return obj.name;
  }
  return "opencode server request failed";
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return part.type === "text";
}

function isToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
  return part.type === "tool";
}

function toolCallFrom(part: Extract<Part, { type: "tool" }>): ToolCall {
  const input = part.state.input;
  return {
    id: part.callID,
    type: "function",
    function: { name: part.tool, arguments: JSON.stringify(input) },
    parsedArguments: input,
  };
}

/**
 * Sums token/cost usage across every assistant message in the session (each
 * internal tool-calling "step" opencode takes gets its own message record).
 * Tool calls are likewise gathered from every assistant message, since "was
 * a tool ever called this run" shouldn't depend on which step it happened
 * in. Text, however, is gathered only from the assistant messages belonging
 * to the last *answered* turn — a turn's closing step can be a text-less
 * tool call (e.g. a trailing todo-list update) even though an earlier step
 * already delivered the real answer, so taking text from every message
 * risks concatenating in stale content from a superseded earlier turn, and
 * taking it only from the very last message risks losing the answer
 * entirely. This also has to tolerate being called while the session's
 * last message is itself an unanswered notification (the "gave up after N
 * follow-ups" path) — in that case the real content is the turn *before*
 * that trailing notification, not nothing.
 */
function collectOutcome(messages: Array<{ info: Message; parts: Part[] }>): RunOutcome {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let lastAssistant: AssistantMessage | undefined;
  const toolCalls: ToolCall[] = [];

  for (const entry of messages) {
    if (entry.info.role !== "assistant") continue;
    const info = entry.info;
    inputTokens += info.tokens?.input ?? 0;
    outputTokens += (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0);
    costUsd += info.cost ?? 0;
    lastAssistant = info;
    toolCalls.push(...entry.parts.filter(isToolPart).map(toolCallFrom));
  }

  // Find the boundary of the last *answered* turn: scanning from the end,
  // skip over a trailing user message that has no assistant reply yet (an
  // unanswered delegation notification — the "gave up after N follow-ups"
  // path calls this while one is still sitting unanswered) and keep looking
  // until we hit a user message that assistant messages actually followed.
  let boundary = -1;
  let sawAssistant = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].info.role;
    if (role === "assistant") {
      sawAssistant = true;
      continue;
    }
    if (role === "user" && sawAssistant) {
      boundary = i;
      break;
    }
  }
  const text = messages
    .slice(boundary + 1)
    .filter((entry) => entry.info.role === "assistant")
    .flatMap((entry) => entry.parts)
    .filter(isTextPart)
    .map((p) => p.text)
    .join("");

  let errorMessage = lastAssistant?.error ? describeError(lastAssistant.error) : undefined;
  if (!text && !errorMessage) {
    errorMessage = `opencode run completed with ${toolCalls.length} tool call(s) but produced no text output`;
  }
  return { text, toolCalls, inputTokens, outputTokens, costUsd, errorMessage };
}

/** Tool names opencode exposes for dispatching a delegated subagent. */
const DELEGATION_DISPATCH_TOOLS = new Set(["delegate", "task"]);
/** Tool name opencode exposes for reading back a dispatched delegation's result. */
const DELEGATION_READ_TOOLS = new Set(["delegation_read"]);
/**
 * Below this length, a reply that hasn't read back every dispatched
 * delegation is treated as a premature "waiting on delegation" stub rather
 * than a real (if short) answer — see `isStalledOnDelegation`.
 */
const STUB_TEXT_THRESHOLD = 300;

/**
 * True when the model has dispatched more delegations (`delegate`/`task`)
 * than it has read back (`delegation_read`) and its reply so far is too
 * short to plausibly be a real synthesis of that work. Catches the case
 * where the model narrates something like "Waiting for delegation
 * result..." and ends its turn instead of polling `delegation_read` or
 * letting the harness's own continuation loop pick the result up — that
 * text is the model's own reply (not opencode's unanswered-notification
 * message), so without this check it looks structurally identical to a
 * real final answer and gets accepted as one.
 */
function isStalledOnDelegation(outcome: RunOutcome): boolean {
  const dispatched = outcome.toolCalls.filter((call) => DELEGATION_DISPATCH_TOOLS.has(call.function.name)).length;
  const read = outcome.toolCalls.filter((call) => DELEGATION_READ_TOOLS.has(call.function.name)).length;
  return dispatched > read && outcome.text.trim().length < STUB_TEXT_THRESHOLD;
}

/**
 * Wraps opencode's HTTP server (via `@opencode-ai/sdk`'s client, talking to
 * our own directly-spawned `opencode serve` process) as a `Provider`. Each
 * `complete()` call spawns a fresh server (auto-assigned port so concurrent
 * calls don't collide), creates one session, sends the prompt, and waits.
 *
 * opencode's own subagent delegation (the `delegate`/`task` tool — see
 * https://opencode.ai/docs/agents/) is asynchronous: the model's own turn
 * ends the moment it dispatches a delegation, well before the delegate
 * finishes, and the delegate's result is delivered later as a message
 * appended to the same session. A one-shot request/response cycle can't
 * wait for that, so this provider keeps the server alive after the initial
 * prompt resolves and polls `session.status`/`session.children` until every
 * delegated child session goes idle, then — if the session's last message is
 * still an unanswered notification rather than the model's own reply, or the
 * model's own reply is a premature "waiting on delegation" stub that never
 * read back a dispatched delegation's result (see `isStalledOnDelegation`) —
 * sends a bounded number of follow-up prompts (`maxContinuations`) so the
 * model can actually synthesize using the delegate's result. All of this is
 * bounded by `timeoutMs` as the overall deadline.
 *
 * Implements `prepareSkill`/`cleanupSkill`: rather than injecting the skill
 * into the prompt, it symlinks every entry of the skill's directory (except
 * `evals/`, which holds the answer key) into `<dir>/.opencode/skills/<name>/`
 * so opencode's own skill tool discovers and loads it exactly as it would in
 * real-world use (see https://opencode.ai/docs/skills/). `runEval` calls
 * this instead of building a system message whenever the provider exposes
 * these hooks.
 *
 * Caveats (see README "opencode run mode" for detail): token/cost numbers
 * include opencode's own system-prompt/tool-schema overhead and are not
 * comparable to raw chat-completion counts from OpenAICompatibleProvider for
 * the same model; `auto: true` auto-approves opencode's own permission
 * prompts (bash/file-edit tools) unattended and is off by default;
 * capabilities are all false, so callers always merge system+user into one
 * string before calling `complete()`. The installed skill directory is
 * shared across every call using the same `dir` — use `--concurrency 1` if
 * concurrent evals of the same skill would otherwise race on install/remove.
 */
export class OpencodeProvider implements Provider {
  readonly capabilities = { systemRole: false, attachments: false, toolCalls: false };
  readonly name: string;
  readonly model: string;
  private agent?: string;
  private dir: string;
  private auto: boolean;
  private timeoutMs: number;
  private maxContinuations: number;
  private baseUrl?: string;

  constructor(options: OpencodeOptions) {
    if (!options.model) {
      throw new Error('OpencodeProvider requires "model" (e.g. "anthropic/claude-sonnet-5")');
    }
    this.name = options.providerName ?? "opencode";
    this.model = options.model;
    this.agent = options.agent;
    this.dir = options.dir ?? process.cwd();
    this.auto = options.auto ?? false;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.maxContinuations = options.maxContinuations ?? 3;
    this.baseUrl = options.baseUrl;
  }

  /**
   * Removes any previously installed copy of `skill`, then — only when
   * `mode` is `"with_skill"` — symlinks it into place so opencode's skill
   * tool finds it under `<dir>/.opencode/skills/<name>/`. Every entry in
   * `skill.dir` is linked except `evals/`, which holds the answer key.
   */
  async prepareSkill(skill: SkillSource, mode: "with_skill" | "without_skill"): Promise<void> {
    const installDir = this.skillInstallDir(skill.name);
    rmSync(installDir, { recursive: true, force: true });
    if (mode !== "with_skill") return;

    mkdirSync(installDir, { recursive: true });
    for (const entry of readdirSync(skill.dir, { withFileTypes: true })) {
      if (entry.name === "evals") continue;
      symlinkSync(
        path.join(skill.dir, entry.name),
        path.join(installDir, entry.name),
        entry.isDirectory() ? "dir" : "file"
      );
    }
  }

  /** Removes whatever `prepareSkill` installed for `skill`, regardless of mode. */
  async cleanupSkill(skill: SkillSource): Promise<void> {
    rmSync(this.skillInstallDir(skill.name), { recursive: true, force: true });
  }

  private skillInstallDir(name: string): string {
    return path.join(this.dir, ".opencode", "skills", name);
  }

  async complete(prompt: string): Promise<ProviderResult> {
    const start = Date.now();
    const deadline = start + this.timeoutMs;
    let server: SpawnedServer | undefined;

    try {
      let baseUrl = this.baseUrl;
      if (!baseUrl) {
        server = await spawnOpencodeServer({
          hostname: "127.0.0.1",
          port: 0,
          permission: this.auto
            ? { edit: "allow", bash: "allow", webfetch: "allow", doom_loop: "allow", external_directory: "allow" }
            : undefined,
        });
        baseUrl = server.url;
      }

      const client = createOpencodeClient({ baseUrl, directory: this.dir });
      const outcome = await this.runSession(client, prompt, deadline);
      const latencyMs = Date.now() - start;

      if (outcome.errorMessage) {
        return this.withServerLog(this.errorResult(outcome.errorMessage, latencyMs, outcome), server);
      }
      return this.withServerLog(
        {
          provider: this.name,
          model: this.model,
          output: outcome.text,
          latencyMs,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          costUsd: outcome.costUsd,
          toolCalls: outcome.toolCalls,
        },
        server
      );
    } catch (err) {
      return this.withServerLog(
        {
          provider: this.name,
          model: this.model,
          output: "",
          latencyMs: Date.now() - start,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          error: err instanceof Error ? err.message : String(err),
        },
        server
      );
    } finally {
      server?.close();
    }
  }

  private errorResult(message: string, latencyMs: number, outcome: RunOutcome): ProviderResult {
    return {
      provider: this.name,
      model: this.model,
      output: outcome.text,
      latencyMs,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      costUsd: outcome.costUsd,
      toolCalls: outcome.toolCalls,
      error: message,
    };
  }

  /** Attaches the spawned server's combined stdout+stderr as a debug artifact, when we actually spawned one (not when talking to an external `baseUrl`). */
  private withServerLog(result: ProviderResult, server: SpawnedServer | undefined): ProviderResult {
    if (!server) return result;
    return { ...result, outputFiles: [{ path: "opencode-serve.log", content: server.getLog() }] };
  }

  private async runSession(
    client: ReturnType<typeof createOpencodeClient>,
    prompt: string,
    deadline: number
  ): Promise<RunOutcome> {
    const model = splitModel(this.model);

    const created = await client.session.create({ signal: this.remainingSignal(deadline) });
    if (created.error) {
      return { text: "", toolCalls: [], inputTokens: 0, outputTokens: 0, costUsd: 0, errorMessage: describeError(created.error) };
    }
    const sessionId = created.data.id;

    const sendPrompt = (text: string) =>
      client.session.prompt({
        path: { id: sessionId },
        body: { agent: this.agent, model, parts: [{ type: "text", text }] },
        signal: this.remainingSignal(deadline),
      });

    const first = await sendPrompt(prompt);
    if (first.error) {
      return { text: "", toolCalls: [], inputTokens: 0, outputTokens: 0, costUsd: 0, errorMessage: describeError(first.error) };
    }

    let continuations = 0;
    while (true) {
      const idle = await this.waitForIdle(client, sessionId, deadline);
      if (!idle) {
        return {
          text: "",
          toolCalls: [],
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          errorMessage: `opencode run timed out after ${this.timeoutMs}ms waiting for delegated work to finish`,
        };
      }

      const messagesResult = await client.session.messages({
        path: { id: sessionId },
        signal: this.remainingSignal(deadline),
      });
      if (messagesResult.error) {
        return { text: "", toolCalls: [], inputTokens: 0, outputTokens: 0, costUsd: 0, errorMessage: describeError(messagesResult.error) };
      }
      const messages = messagesResult.data;
      const lastMessage = messages[messages.length - 1];
      const outcome = collectOutcome(messages);
      const stalled = lastMessage?.info.role !== "user" && isStalledOnDelegation(outcome);

      // The model's own reply (not a still-unanswered notification, and not
      // a premature "waiting on delegation" stub) is the real end of the turn.
      if (lastMessage?.info.role !== "user" && !stalled) {
        return outcome;
      }

      if (continuations >= this.maxContinuations || Date.now() >= deadline) {
        return {
          ...outcome,
          errorMessage: stalled
            ? `opencode run: gave up after ${continuations} follow-up prompt(s) waiting for the model to read back a dispatched delegation's result`
            : `opencode run: gave up after ${continuations} follow-up prompt(s) waiting for the model to use a delegated subagent's result`,
        };
      }

      continuations++;
      const cont = await sendPrompt(
        "Continue. If you dispatched a delegation, call delegation_read on its id now and report the findings — do not say you are waiting."
      );
      if (cont.error) {
        return { text: "", toolCalls: [], inputTokens: 0, outputTokens: 0, costUsd: 0, errorMessage: describeError(cont.error) };
      }
    }
  }

  /** Polls until the session and every delegated child session report non-busy, or the deadline passes. */
  private async waitForIdle(
    client: ReturnType<typeof createOpencodeClient>,
    sessionId: string,
    deadline: number
  ): Promise<boolean> {
    while (true) {
      const childrenResult = await client.session.children({ path: { id: sessionId }, signal: this.remainingSignal(deadline) });
      const childIds = (childrenResult.data ?? []).map((session) => session.id);
      const statusResult = await client.session.status({ signal: this.remainingSignal(deadline) });
      const statusById = statusResult.data ?? {};

      const allIdle = [sessionId, ...childIds].every((id) => {
        const type = statusById[id]?.type ?? "idle";
        return type !== "busy" && type !== "retry";
      });
      if (allIdle) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  private remainingSignal(deadline: number): AbortSignal {
    return AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  }
}
