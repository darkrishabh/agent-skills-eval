<div align="center">

<img src="https://github.com/user-attachments/assets/094b8e11-e19e-4c96-ae82-ba701cfcf7e3" alt="agent-skills-eval — a test runner for Agent Skills" width="100%" />

<br />

# agent-skills-eval

**A test runner for [Agent Skills](https://agentskills.io).**

Write a `SKILL.md`, drop in some evals, and find out — empirically — whether your skill actually makes the model better at the task.

[![npm version](https://img.shields.io/npm/v/agent-skills-eval.svg?style=flat-square&logo=npm&label=npm)](https://www.npmjs.com/package/agent-skills-eval)
[![CI](https://img.shields.io/github/actions/workflow/status/darkrishabh/agent-skills-eval/ci.yml?style=flat-square&logo=github&label=ci)](https://github.com/darkrishabh/agent-skills-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![node](https://img.shields.io/node/v/agent-skills-eval.svg?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-0f766e?style=flat-square)](https://darkrishabh.github.io/agent-skills-eval/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Documentation](https://darkrishabh.github.io/agent-skills-eval/) · [Quickstart](#quickstart) · [SDK](#sdk) · [agentskills.io](https://agentskills.io)

</div>

---

## Why this exists

[Agent Skills](https://agentskills.io) — the open standard from Anthropic for giving agents domain knowledge — make it easy to ship a `SKILL.md` and assume your agent is now better at the task. The hard part is *proving* it.

`agent-skills-eval` is the missing piece. It runs your skill against the same prompts twice — once `with_skill` loaded into context, once `without_skill` (baseline) — has a judge model grade both outputs, and gives you a side-by-side report. If the skill doesn't make a measurable difference, you'll see it. If it does, you have receipts.

It's the test framework for the Agent Skills ecosystem, separated from any specific agent runtime so it works wherever your skills do.

## Quickstart

```bash
npx agent-skills-eval ./skills \
  --target gpt-4o-mini \
  --judge gpt-4o-mini \
  --baseline \
  --strict
```

That's it. Point it at a folder of skills, give it a target model and a judge model, and it produces a workspace with full artifacts and a static HTML report.

```text
agent-skills-workspace/
└── iteration-1/
    ├── meta.json            # run metadata
    ├── benchmark.json       # rolled-up pass/fail per skill
    ├── eval-basic/
    │   ├── with_skill/      # output, timing, judge grading
    │   └── without_skill/   # ↑ same, with the skill stripped
    └── report/
        └── index.html       # the visual report
```

Open `iteration-1/report/index.html` and you have a real, evidence-backed answer to "is my skill working?"

## What you get

|  |  |
|---|---|
| **`with_skill` vs `without_skill`** | Every eval runs both ways so you can see the actual lift from the skill — or its absence. |
| **Judge-graded outputs** | Use any chat model as a judge. Pass/fail with cited assertions, not vibes. |
| **TypeScript SDK + CLI** | One-liner CLI for CI, full SDK for custom pipelines, custom providers, and dashboards. |
| **OpenAI-compatible by default** | Works out of the box with OpenAI, Together, Groq, Anthropic via OpenAI-compat layers, local Llama servers — anything that speaks the OpenAI chat API. |
| **Pluggable execution: API or agentic CLI** | Run target/judge through any OpenAI-compatible API, or drive the real [`opencode`](https://opencode.ai) CLI (its own tool use, permissions, agent config) via `--run-mode opencode`. |
| **Tool-call assertions** | Deterministic checks for agents that call tools, not just generate text. |
| **Portable artifacts** | JSON + JSONL all the way down. Run today, diff tomorrow. Plug into your own dashboard. |
| **Static HTML reports** | A drop-in report site you can publish anywhere — no infrastructure. |
| **Fully spec-compliant** | Implements the full [agentskills.io specification](https://agentskills.io/specification): `SKILL.md` validation, `evals/evals.json`, official `iteration-N` artifact layout, frontmatter rules. |

## Install

```bash
npm install agent-skills-eval
```

Or run directly without installing:

```bash
npx agent-skills-eval --help
```

## How it works

The mental model is straightforward. For every eval defined in your skill:

```
                ┌─────────────────────────────┐
                │       same prompt           │
                └───────────────┬─────────────┘
                                │
                ┌───────────────┴─────────────┐
                ▼                             ▼
        ┌──────────────┐              ┌──────────────┐
        │ with_skill   │              │without_skill │
        │ SKILL.md in  │              │ baseline,    │
        │ context      │              │ no skill     │
        └──────┬───────┘              └──────┬───────┘
               │                             │
               ▼                             ▼
          target model                  target model
               │                             │
               ▼                             ▼
            output                        output
               │                             │
               └──────────┬──────────────────┘
                          ▼
                   ┌─────────────┐
                   │  judge      │  scores both against
                   │  model      │  the same assertions
                   └──────┬──────┘
                          ▼
                  pass / fail per side
```

The judge sees the eval's `expected_output` and `assertions` and grades each side independently. The `--baseline` flag is what enables the comparison; without it you only get the `with_skill` run.

This is the *logical* flow regardless of run mode — `--run-mode opencode` (below) changes *how* the target/judge models are invoked (a subprocess instead of an HTTP call), not this flow.

## YAML config

For anything beyond a quick command, drop a config file at the root of your project:

```yaml
# agent-skills-eval.yaml
root: ./skills
workspace: ./agent-skills-workspace
baseline: true
target: gpt-4o-mini
judge: gpt-4o-mini
baseUrl: https://api.openai.com/v1
apiKeyEnv: OPENAI_API_KEY
include:
  - "skills/**"
exclude:
  - "**/draft-*"
concurrency: 4
layout: iteration
strict: true
report:
  enabled: true
  title: Agent Skills Report
logging:
  format: pretty   # pretty | jsonl | silent
  verbose: false
  color: auto
targetParams:
  temperature: 0
judgeParams:
  temperature: 0
```

```bash
OPENAI_API_KEY=... npx agent-skills-eval --config agent-skills-eval.yaml
```

CLI flags always override config values.

## SDK

For programmatic use — CI pipelines, custom dashboards, multi-skill rollups — drive the evaluator from TypeScript:

```ts
import {
  OpenAICompatibleProvider,
  consoleReporter,
  evaluateSkills,
} from "agent-skills-eval";

const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini",
  providerName: "openai",
});

const result = await evaluateSkills({
  root: "./skills",
  workspace: "./agent-skills-workspace",
  baseline: true,
  concurrency: 4,
  workspaceLayout: "iteration",
  strict: true,
  target: { model: provider.model, provider },
  judge: { model: provider.model, provider },
  onEvent: consoleReporter(),
});

console.log(result);
```

Stream events to a file as JSONL for downstream analysis:

```ts
import { jsonlReporter } from "agent-skills-eval";

const reporter = jsonlReporter({ file: "./events.jsonl" });

await evaluateSkills({ /* ... */ onEvent: reporter.onEvent });
await reporter.close();
```

Load YAML config programmatically:

```ts
import { loadConfigFile } from "agent-skills-eval";

const config = loadConfigFile("./agent-skills-eval.yaml");
```

## Custom providers

Bring any backend by implementing the `Provider` interface — five fields, one method:

```ts
import type { Provider, ProviderResult } from "agent-skills-eval";

export const provider: Provider = {
  name: "my-provider",
  model: "my-model",
  async complete(prompt: string): Promise<ProviderResult> {
    return {
      provider: "my-provider",
      model: "my-model",
      output: "model output",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  },
};
```

Useful for: local model servers (Ollama, vLLM, llama.cpp), proprietary internal APIs, mock providers in unit tests, or routing layers in front of multiple providers.

## opencode run mode

Instead of calling an OpenAI-compatible API directly, you can route target/judge calls through [`opencode`](https://opencode.ai) via `@opencode-ai/sdk` — useful if you already manage model access/credentials through opencode and don't want to supply a separate `--base-url`/API key to this tool.

```bash
npx agent-skills-eval ./skills \
  --run-mode opencode \
  --target anthropic/claude-sonnet-5 \
  --opencode-agent build \
  --opencode-timeout 300000
```

| Flag | Description |
|---|---|
| `--run-mode <api\|opencode>` | Default `api`. Set to `opencode` to talk to an opencode server instead of calling an HTTP API. |
| `--target` / `--judge` | In opencode mode, must be `provider/model` form (e.g. `anthropic/claude-sonnet-5`), matching opencode's own model id syntax. |
| `--opencode-agent <name>` | Which opencode agent handles the session (e.g. `build`). |
| `--opencode-dir <path>` | Working directory opencode runs in. Default: current directory. |
| `--opencode-auto` / `--no-opencode-auto` | Auto-approve opencode's own permission prompts (edit/bash/webfetch/etc). **Dangerous, off by default** — see caveat below. `--no-opencode-auto` always overrides `opencode.auto: true` set in a config file. |
| `--opencode-timeout <ms>` | Hard deadline per call — covers the initial prompt, waiting on any delegated subagent work, and follow-up continuations. Default `300000` (5 minutes). |
| `--opencode-judge-timeout <ms>` | Hard deadline for judge/grader calls specifically. Defaults to `--opencode-timeout`. A judge that reads a full transcript plus output files is often slower than the run it grades — set this higher if judge calls are timing out. |

Equivalent YAML:

```yaml
runMode: opencode
opencode:
  agent: build
  auto: false
  dir: ./workspace-scratch
  timeoutMs: 300000
  judgeTimeoutMs: 600000
  # baseUrl: http://127.0.0.1:4096  # talk to an already-running `opencode serve` instead of spawning one
```

**Skills are loaded natively, not injected into the prompt.** In every other run mode, `with_skill` works by wrapping the skill in an XML block and prepending it to the prompt. In opencode mode, that would never happen in real-world use — opencode discovers skills on disk and loads them itself via its own `skill` tool (see [opencode's Agent Skills docs](https://opencode.ai/docs/skills/)). So instead, before each call this provider symlinks every entry of the skill's directory into `<opencode.dir>/.opencode/skills/<name>/` for `with_skill` runs, and removes that symlink tree for `without_skill` runs — the agent decides for itself whether to call `skill({ name })`. The skill's `evals/` folder (which holds the answer key) is never linked. No `system` message is sent in this mode; the model gets the bare eval prompt either way.

**How a call works.** Each `complete()` call spawns a fresh, private `opencode serve` process (via `createOpencodeServer`, on an auto-assigned port so concurrent target/judge calls don't collide), creates one session, and sends the prompt. opencode's own subagent delegation (the `delegate`/`task` tool — see [opencode's Agents docs](https://opencode.ai/docs/agents/)) is asynchronous: the model's turn ends the moment it dispatches a delegation, and the delegate's result is delivered later as a message appended to the same session, once it finishes. A single request/response can't wait for that, so this provider keeps its private server alive after the initial prompt resolves and polls the session (and any child sessions opencode created for delegated work) until they go idle. It then sends a bounded number of follow-up "Continue." prompts (`maxContinuations`, capped internally) if either: the session's last message is still an unanswered delegation notification rather than the model's own reply, or the model's own reply is a premature "waiting on delegation" stub — dispatched a delegation but never read its result back with `delegation_read` — that would otherwise look structurally identical to a real final answer. All of this is bounded by `--opencode-timeout` as the overall deadline. The server is always torn down afterward, even on error or timeout. Its combined stdout/stderr is captured for the whole run and written to `outputs/opencode-serve.log` alongside the other run artifacts, so a crashed or misbehaving server is diagnosable after the fact.

**Caveats:**

- **Token/cost numbers aren't comparable to API mode.** opencode's own system prompt and tool schemas add fixed overhead to every call (observed ~8,400 input tokens for a trivial one-word prompt), so `inputTokens`/`outputTokens`/`costUsd` from opencode-mode runs are not apples-to-apples with the same model called via `OpenAICompatibleProvider`.
- **`--opencode-auto` is dangerous.** It lets the target/judge model run opencode's own bash/file-edit tools completely unattended for the duration of the call. It's off by default. Even without it, a stuck interactive permission prompt has no TTY to answer in a non-interactive eval run — that's what `--opencode-timeout` guards against; it always applies, whether or not `--opencode-auto` is set.
- **No custom binary path.** Unlike older versions of this provider, there's no way to point at a non-`PATH` opencode binary — `@opencode-ai/sdk` always spawns `opencode` resolved via `PATH`. Point `PATH` at the right install, or use `opencode.baseUrl` to talk to a server you started yourself.
- **`tool_assertions` see opencode's own internal tools, not a caller-supplied schema.** This provider reports every tool call opencode's agent actually made during the run (`bash`, file edits, `task` delegation, `skill`, etc.) as `ProviderResult.toolCalls`, written to `tool_calls.json` and shown in the HTML report — including, for `with_skill` runs, whether the `skill` tool was called with this eval's skill name (surfaced as a "skill picked up" badge). `tool_assertions` grade against that same list, so e.g. `{"type": "tool-called", "name": "skill"}` works under `--run-mode opencode`, but there's no `tools`/`tool_choice` schema to pass *in* — the model always has whatever tools opencode itself exposes, never a caller-defined set.
- **Shared working directory.** All calls from one CLI invocation share a single `--opencode-dir`. If a skill has the model write files, or you run `with_skill`/`without_skill` for the same skill concurrently, use `--concurrency 1` — otherwise the on-disk skill symlink one call installs/removes can race another call's `.opencode/skills/<name>/` lookup, or concurrent git operations against the same working tree.

## Skill layout

A skill is a folder. The minimum is a `SKILL.md`. Add `evals/evals.json` and you can evaluate it.

```text
my-skill/
├── SKILL.md
├── references/
│   └── notes.md
├── scripts/
│   └── helper.sh
└── evals/
    ├── evals.json
    └── files/
        └── input.csv
```

`SKILL.md`:

```markdown
---
name: my-skill
description: Analyze small CSV files.
license: MIT
compatibility: Works with text-capable chat models.
---

When given a CSV file, identify the most important trend and cite the
relevant rows.
```

`evals/evals.json`:

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": "basic",
      "name": "basic behavior",
      "prompt": "Use the attached data to summarize revenue.",
      "files": ["evals/files/input.csv"],
      "expected_output": "The response identifies the highest revenue month.",
      "assertions": [
        "The output identifies the highest revenue month."
      ]
    }
  ]
}
```

If you skip `assertions` but provide `expected_output`, the SDK promotes the expected output into a judge assertion automatically — so a minimal agentskills.io eval file produces meaningful pass/fail grading without extra work.

## CLI options

```bash
npx agent-skills-eval [root] \
  --config agent-skills-eval.yaml \
  --workspace ./agent-skills-workspace \
  --baseline \
  --target gpt-4o-mini \
  --judge gpt-4o-mini \
  --base-url https://api.openai.com/v1 \
  --api-key-env OPENAI_API_KEY \
  --include "skills/**" \
  --exclude "**/draft-*" \
  --concurrency 4 \
  --layout iteration \
  --strict \
  --log-format pretty \
  --report
```

**Logging modes**: `pretty` for humans, `jsonl` for machines, `silent` for quiet CI.

Or run via the [opencode CLI](#opencode-run-mode) instead of an API:

```bash
npx agent-skills-eval [root] \
  --run-mode opencode \
  --target anthropic/claude-sonnet-5 \
  --opencode-agent build \
  --opencode-timeout 300000
```

## Reports

The static HTML report is built from disk artifacts and shows everything you'd want for skill iteration:

- Pass rate by skill and by eval
- Assertion-by-assertion grading evidence with judge reasoning
- Full target output, side by side for `with_skill` and `without_skill`
- Prompt and judge prompt details
- Timing and token usage
- Tool calls when present

Use `--report-output` (or `report.output` in YAML) to choose where the report lands.

## agentskills.io compatibility

Implements the [agentskills.io](https://agentskills.io) specification end to end:

- `SKILL.md` YAML frontmatter — required `name` and `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools`
- Strict validation: name length, lowercase-hyphenated format, parent-directory match, description length, compatibility length
- Optional `scripts/`, `references/`, and `assets/` directories — markdown references included in skill context, scripts exposed by manifest
- `evals/evals.json` schema: `skill_name`, `evals[].id`, `prompt`, `expected_output`, `files`, `assertions`
- Official artifact layout: `iteration-N/<eval>/<mode>/outputs`, `timing.json`, `grading.json`, `benchmark.json`
- Baseline comparison via `with_skill` and `without_skill`

Beyond the spec, this SDK adds: per-eval `defaults`, model `params`, tool definitions, deterministic `tool_assertions`, and a flat `workspaceLayout: "flat"` for multi-skill dashboards.

## Examples

See [`examples/basic-skill`](examples/basic-skill) for a complete skill folder, and [`examples/agent-skills-eval.yaml`](examples/agent-skills-eval.yaml) for a reference config.

## Development

```bash
npm ci
npm test
npm pack --dry-run
```

## Documentation

Full docs live at **[darkrishabh.github.io/agent-skills-eval](https://darkrishabh.github.io/agent-skills-eval/)** (sources in [`docs/`](docs)). Local preview:

```bash
python3 -m http.server 8080 --directory docs
```

## Contributing

Issues, PRs, and skill examples are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

---

<div align="center">

Built for the [Agent Skills](https://agentskills.io) ecosystem.

</div>
