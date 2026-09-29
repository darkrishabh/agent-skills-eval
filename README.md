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
evalIds:
  - "basic"
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

### Options reference

These are configuration-file options and CLI defaults. See `--help` for the
available CLI flags; `targetParams`, `judgeParams`, and `logging.snippetLength`
are config-only. Logging flags use `--log-format`, `--log-file`, `--verbose`,
and `--no-color`; report flags use `--report`, `--no-report`, `--report-title`,
and `--report-output`. Supplied CLI flags override matching config values.

| Option | Type | Default | What it does |
|---|---|---|---|
| `root` | string | `.` | Directory scanned recursively for `SKILL.md` files. Positional CLI arg. |
| `workspace` | string | `./agent-skills-workspace` | Output directory for run artifacts (per-eval outputs, `grading.json`, `benchmark.json`, `meta.json`). |
| `baseline` | boolean | `false` | When `true`, runs each eval both `with_skill` and `without_skill` so the report shows the lift the skill provides. When `false`, only `with_skill` runs. |
| `target` | string | `gpt-4o-mini` | Model under evaluation — the one the skill is meant to help. |
| `judge` | string | value of `target` | Model that grades the rubric assertions. Set it to a stronger model than `target` for more reliable grading. |
| `baseUrl` | string | `OPENAI_BASE_URL` env, else **required** | Base URL of the OpenAI-compatible API for both target and judge. |
| `apiKeyEnv` | string | `OPENAI_API_KEY` | Name of the environment variable holding the API key (the key itself is never written to config). |
| `include` | string[] | all discovered skills | Glob(s) matched against each skill's path; only matching skills run. Repeatable `--include` on the CLI. |
| `exclude` | string[] | none | Glob(s) matched against each skill's path; matching skills are skipped. Applied after `include`. Repeatable `--exclude`. |
| `evalIds` | string[] | all cases | Select IDs within every selected skill. Repeat `--eval-id` on the CLI; SDK also accepts numeric IDs. Missing IDs fail the run. |
| `concurrency` | number | `4` | Number of eval cases run in parallel. Must be a positive integer. |
| `strict` | boolean | `false` | Validate each `SKILL.md` against the agentskills.io schema before running; fail on violations. |
| `layout` | `flat` \| `iteration` | `iteration` | `iteration` allocates `iteration-N/` locally; with `CI=true`, it resets `iteration-1/`; `flat` writes directly into the workspace, overwriting the previous run. |
| `report` | boolean \| object | `true` | `true`/`false` toggles HTML report generation. As an object, takes `enabled`, `title`, and `output`. |
| `report.enabled` | boolean | `true` | Whether to generate the static HTML report. |
| `report.title` | string | none | Title shown at the top of the HTML report. |
| `report.output` | string | `<run workspace>/report` | Directory the HTML report is written to. |
| `logging.format` | `pretty` \| `jsonl` \| `silent` | `pretty` | `pretty` prints the rich console reporter; `jsonl` emits machine-readable events; `silent` suppresses progress output (the final JSON result still goes to stdout). |
| `logging.verbose` | boolean | `false` | Print full prompts, outputs, and judge prompts instead of snippets (`pretty` format only). |
| `logging.color` | boolean \| `auto` | `auto` | ANSI color: `auto` enables it on a TTY, `true`/`false` force it. |
| `logging.snippetLength` | number | `200` | Max length of inline prompt/output snippets in non-verbose `pretty` output. |
| `logging.file` | string | none | Path to write JSONL event logs to (used with `--log-file`). |
| `targetParams` | object | none | Inference params (e.g. `temperature`) passed through to the target model. |
| `judgeParams` | object | none | Inference params passed through to the judge model. |

To iterate on one case, pass `--eval-id` one or more times:

```bash
OPENAI_API_KEY=... npx agent-skills-eval --config agent-skills-eval.yaml --eval-id basic
```

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
  --eval-id basic \
  --concurrency 4 \
  --layout iteration \
  --strict \
  --log-format pretty \
  --report
```

**Logging modes**: `pretty` for humans, `jsonl` for machines, `silent` for quiet CI.

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


## Integration boundaries

See [the artifact contract](docs/artifact-contract.md) for output layouts, field
semantics, adapter guidance, and provenance limits. External result-format
adapters can consume these files without adding dependencies to this runner.

The built-in OpenAI-compatible provider makes a single chat-completion request
per target run (plus retries). Function tool definitions let you grade the
returned tool-call requests; the provider does not connect to MCP servers,
execute tools, or run a multi-turn agent loop. To evaluate a skill that needs
real MCP execution today, implement a custom `Provider` that owns the tool loop
and returns actual output and captured `toolCalls` for grading. Declaring a
function tool is not evidence that its operation executed successfully.

This runner evaluates behavior supplied by a provider; it does not authenticate
agent identity, detect clones, or attest to an untampered runtime. Integrations
that need identity verification must perform it before starting the evaluation
and retain the evidence separately. Passing scores do not establish identity
or regulatory compliance.

Outgoing requests from `OpenAICompatibleProvider` carry
`User-Agent: agent-skills-eval/<package-version> (+https://github.com/darkrishabh/agent-skills-eval; node/<node-version>)`.
This applies to target and judge calls and retries. SDK callers can override it
through `extraHeaders` using any capitalization of `User-Agent`.


The proposed native-agent lifecycle is available for contributor review through
[the experimental runtime foundation](docs/runtime-foundation.md). It is a
separate SDK entry point; the native adapters and CLI integration are still under
development with the authors of PRs #25 and #35.
