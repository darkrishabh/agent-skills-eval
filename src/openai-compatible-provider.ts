import { createRequire } from "node:module";
import type { Provider, ProviderResult, ToolCall, ToolChoice, ToolDef } from "./provider.js";
import type { AttachedFile } from "./types.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const USER_AGENT = `agent-skills-eval/${version} (+https://github.com/darkrishabh/agent-skills-eval; node/${process.versions.node})`;

export interface OpenAICompatibleOptions {
  providerName?: string;
  model?: string;
  /**
   * Convenience defaults applied when the caller didn't supply the same key
   * via `completeChat({ params })`. Caller params always win. Both fields are
   * optional — the SDK does not default to any value when both are omitted.
   */
  maxTokens?: number;
  temperature?: number;
  /** Extra headers to merge into every request (e.g. HTTP-Referer for OpenRouter) */
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  retry?: {
    attempts?: number;
    backoffMs?: number;
  };
}

interface OpenAIToolCallWire {
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface OpenAIChatResponse {
  choices: Array<{
    message: { content: string | null; tool_calls?: OpenAIToolCallWire[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    costs?: {
      prompt?: number;
      completion?: number;
    };
  };
  model?: string;
}

function modelTail(model: string): string {
  const id = model.toLowerCase();
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

/**
 * Models that reject `max_tokens` and require `max_completion_tokens` on Chat Completions
 * (o-series, GPT-5 family, including OpenRouter-style ids like `openai/gpt-5.4`).
 *
 * This is a *parameter-name remap*, not an opinion: callers can set
 * `params.max_tokens` and the SDK will silently rename it for these families
 * so the same eval works across model lines. Caller-supplied
 * `max_completion_tokens` is always respected verbatim.
 */
function openAiUsesMaxCompletionTokens(model: string): boolean {
  const tail = modelTail(model);
  if (/^o\d/.test(tail)) return true;
  if (tail.startsWith("gpt-5")) return true;
  return false;
}

function parseToolCalls(raw: OpenAIToolCallWire[] | undefined): ToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw
    .filter((c): c is OpenAIToolCallWire & { function: { name: string } } =>
      Boolean(c?.function?.name)
    )
    .map((c) => {
      const args = c.function.arguments ?? "";
      let parsed: unknown;
      if (args.length > 0) {
        try {
          parsed = JSON.parse(args);
        } catch {
          parsed = undefined;
        }
      }
      return {
        id: c.id,
        type: "function" as const,
        function: { name: c.function.name, arguments: args },
        parsedArguments: parsed,
      };
    });
}

export class OpenAICompatibleProvider implements Provider {
  readonly capabilities = { systemRole: true, attachments: false, toolCalls: true };
  /** Shown as `provider` in ProviderResult — pass the human name, e.g. "openai", "groq" */
  readonly name: string;
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;
  private options: OpenAICompatibleOptions;

  constructor(
    nameOrOptions: string | (OpenAICompatibleOptions & { baseUrl: string; apiKey: string }),
    baseUrl?: string,
    apiKey?: string,
    model?: string,
    options: OpenAICompatibleOptions = {}
  ) {
    if (typeof nameOrOptions === "string") {
      this.name = nameOrOptions;
      this.baseUrl = (baseUrl ?? "").replace(/\/$/, "");
      this.apiKey = apiKey ?? "";
      this.model = model ?? "gpt-4o-mini";
      this.options = options;
    } else {
      this.name = nameOrOptions.providerName ?? "openai-compatible";
      this.baseUrl = nameOrOptions.baseUrl.replace(/\/$/, "");
      this.apiKey = nameOrOptions.apiKey;
      this.model = nameOrOptions.model ?? "gpt-4o-mini";
      this.options = nameOrOptions;
    }
  }

  async complete(prompt: string): Promise<ProviderResult> {
    return this.completeChat({ user: prompt });
  }

  async completeChat(args: {
    system?: string;
    user: string;
    attachments?: AttachedFile[];
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
    params?: Record<string, unknown>;
  }): Promise<ProviderResult> {
    const start = Date.now();
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          ...(args.system ? [{ role: "system", content: args.system }] : []),
          { role: "user", content: args.user },
        ],
      };

      // Constructor-level convenience defaults — applied only when the caller
      // didn't already pin the same key via `params`. Caller always wins.
      const params: Record<string, unknown> = { ...(args.params ?? {}) };
      if (
        this.options.maxTokens !== undefined &&
        params.max_tokens === undefined &&
        params.max_completion_tokens === undefined
      ) {
        params.max_tokens = this.options.maxTokens;
      }
      if (this.options.temperature !== undefined && params.temperature === undefined) {
        params.temperature = this.options.temperature;
      }

      // Cross-family parameter-name remap: callers write `max_tokens` and we
      // rename it for o-series / gpt-5 endpoints that require
      // `max_completion_tokens`. This is translation, not opinion — caller
      // intent is preserved verbatim, just under the field name the upstream
      // accepts.
      if (
        params.max_tokens !== undefined &&
        params.max_completion_tokens === undefined &&
        openAiUsesMaxCompletionTokens(this.model)
      ) {
        params.max_completion_tokens = params.max_tokens;
        delete params.max_tokens;
      }

      Object.assign(body, params);

      if (args.tools && args.tools.length > 0) {
        body.tools = args.tools;
        body.tool_choice = args.toolChoice ?? "auto";
      } else if (args.toolChoice !== undefined) {
        body.tool_choice = args.toolChoice;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.options.extraHeaders,
      };
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) {
        headers["User-Agent"] = USER_AGENT;
      }
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

      const data = await this.fetchWithRetry(body, headers);

      const latencyMs = Date.now() - start;
      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      const output = data.choices[0]?.message.content ?? "";
      const toolCalls = parseToolCalls(data.choices[0]?.message.tool_calls);
      const promptCost = data.usage?.costs?.prompt ?? 0;
      const completionCost = data.usage?.costs?.completion ?? 0;

      return {
        provider: this.name,
        model: this.model,
        output,
        latencyMs,
        inputTokens,
        outputTokens,
        costUsd: promptCost + completionCost,
        toolCalls,
      };
    } catch (err) {
      return {
        provider: this.name,
        model: this.model,
        output: "",
        latencyMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async fetchWithRetry(
    body: Record<string, unknown>,
    headers: Record<string, string>
  ): Promise<OpenAIChatResponse> {
    const attempts = this.options.retry?.attempts ?? 2;
    const backoffMs = this.options.retry?.backoffMs ?? 1500;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = this.options.timeoutMs ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => controller.abort(), this.options.timeoutMs)
        : undefined;
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller?.signal,
        });

        if (!res.ok) {
          throw new Error(`${this.name} ${res.status}: ${await res.text()}`);
        }

        return (await res.json()) as OpenAIChatResponse;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    throw lastError ?? new Error(`${this.name}: request failed`);
  }
}
