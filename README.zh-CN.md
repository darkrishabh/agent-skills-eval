<div align="center">

<img src="https://github.com/user-attachments/assets/094b8e11-e19e-4c96-ae82-ba701cfcf7e3" alt="agent-skills-eval — Agent Skills 评估工具" width="100%" />

# agent-skills-eval

[English](README.md) | [简体中文](README.zh-CN.md)

**面向 [Agent Skills](https://agentskills.io) 的测试与评估工具。**

编写 `SKILL.md`，添加评估用例，用可复查的结果判断技能是否真正改善了模型的表现。

[快速开始](#快速开始) · [主要能力](#主要能力) · [SDK](#sdk) · [中文运行指南](docs/runtime-evaluation.zh-CN.md)

</div>

## 为什么需要这个项目

发布一个技能，并不等于证明它有效。技能可能没有触发、跳过必要步骤，也可能生成看似正确却无法使用的产物。

`agent-skills-eval` 使用相同提示词和输入文件，分别运行 `with_skill`（提供技能）和 `without_skill`（不提供技能），再通过确定性检查或模型裁判比较结果。通过率、耗时、工具调用和评分证据会保存到本地，便于追踪改进与回归。

项目提供 TypeScript SDK 和命令行工具，既支持 OpenAI 兼容 API，也支持真实的 Codex 与 Claude Code CLI 执行。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 基线对比 | 开启 `--baseline` 后，用相同输入比较有技能与无技能的表现。 |
| 原生运行时 | 通过 Codex、Claude Code CLI 执行任务，采集执行轨迹与文件产物。 |
| 技能触发评估 | 支持显式、隐式、上下文和负向用例，记录指定技能的加载证据。 |
| 确定性检查 | 检查命令、顺序、文件、内容、改动白名单、权限拒绝和效率预算。 |
| 独立验证 | 执行构建、测试命令，或启动服务并检查本机 HTTP 接口。 |
| 模型裁判 | 按断言评分，要求结构化结果和具体证据；也可只运行确定性检查。 |
| 自定义 provider | 接入兼容 API、本地模型服务、自定义后端或测试替身。 |
| 可复查的产物 | 保存 JSON、JSONL、提示词、输出、评分及验证日志。 |
| 静态 HTML 报告 | 在浏览器中查看两种模式的输出、断言、证据和资源指标。 |
| 技能格式校验 | 校验 `SKILL.md` 前置信息，读取技能资源和 `evals/evals.json`。 |

## 快速开始

### 从源码运行

需要 Node.js 18+ 和 npm。原生运行时还需要 Git，以及已安装、配置好认证的 Codex 或 Claude Code CLI。

```sh
git clone https://github.com/jasonlihaitao-sketch/agent-skills-eval-taotao.git
cd agent-skills-eval-taotao
npm ci
npm run build
```

在项目根目录选择一种运行方式：

```sh
# 使用 Codex
node dist/cli.js --config examples/codex-eval.yaml

# 使用 Claude Code
node dist/cli.js --config examples/claude-eval.yaml
```

两份配置使用同一组技能与用例，沿用各自 CLI 的默认模型。示例启用了基线对比，共执行八次目标运行；`judgeRuntime: none` 表示只做确定性检查，不额外调用模型裁判。

本仓库的原生运行时增强请使用包含这些变更的源码构建。npm 包中的功能以实际发布版本为准。

### 使用兼容 API

先配置 API 密钥。PowerShell 示例：

```powershell
$env:OPENAI_API_KEY = "你的 API 密钥"
node dist/cli.js ./examples/basic-skill --base-url https://api.openai.com/v1 --target gpt-4o-mini --judge gpt-4o-mini --baseline --strict
```

Bash / Zsh 示例：

```sh
export OPENAI_API_KEY="你的 API 密钥"
node dist/cli.js ./examples/basic-skill --base-url https://api.openai.com/v1 --target gpt-4o-mini --judge gpt-4o-mini --baseline --strict
```

`--target` 和 `--judge` 应设置为你的服务实际支持的模型。兼容 API 模式需要提供 `--base-url` 或 `OPENAI_BASE_URL`，以及指定环境变量中的 API 密钥。

也可以安装已发布的包：

```sh
npm install agent-skills-eval
npx agent-skills-eval --help
```

## 工作原理

每个用例按以下步骤执行：

1. 读取提示词、输入文件和验收条件。
2. 运行 `with_skill`；启用基线时，再运行 `without_skill`。
3. 采集输出、工具调用；原生模式额外保存执行轨迹和工作区文件。
4. 执行确定性检查，并按需要调用模型裁判。
5. 保存评分与证据，生成汇总和 HTML 报告。

API 模式将技能内容放入模型上下文；原生模式将技能放入 CLI 的发现目录，由 CLI 自行选择是否加载。只有开启 `--baseline` 或 `baseline: true` 才运行两种模式。

## YAML 配置

兼容 API 配置示例：

```yaml
root: ./examples/basic-skill
workspace: ./agent-skills-workspace
runtime: provider
baseline: true
target: gpt-4o-mini
judge: gpt-4o-mini
baseUrl: https://api.openai.com/v1
apiKeyEnv: OPENAI_API_KEY
concurrency: 4
layout: iteration
strict: true
report:
  enabled: true
  title: Agent Skills 评估报告
logging:
  format: pretty # pretty | jsonl | silent
  verbose: false
  color: auto
targetParams:
  temperature: 0
judgeParams:
  temperature: 0
```

```sh
node dist/cli.js --config agent-skills-eval.yaml
```

CLI 参数优先于 YAML 配置。相对路径以运行命令时的当前目录为准。可以通过 `include` 和 `exclude` 筛选相对于扫描根目录的技能路径。

原生模式配置示例：

```yaml
root: ./examples/runtime-skill
workspace: ./agent-skills-workspace
runtime: codex # 也可以设为 claude
judgeRuntime: none
runtimeOptions:
  allowWrites: true
  timeoutMs: 120000
baseline: true
concurrency: 1
layout: iteration
strict: true
```

`judgeRuntime` 可选 `provider`、`codex`、`claude` 或 `none`，默认与目标运行时一致。设置为 `none` 时，用例不能包含需要模型裁判的 `assertions` 或 `expected_output`。

## SDK

使用已安装的包进行 API 评估：

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

在本仓库根目录创建脚本，使用本地构建的原生运行器：

```js
import { RuntimeProvider, evaluateSkills } from "./dist/index.js";

const provider = new RuntimeProvider({
  runtime: "codex",
  allowWrites: true,
  timeoutMs: 120000,
});

const result = await evaluateSkills({
  root: "./examples/runtime-skill",
  workspace: "./agent-skills-workspace",
  baseline: true,
  concurrency: 1,
  workspaceLayout: "iteration",
  target: { model: provider.model, provider },
});

console.log(result);
```

SDK 还导出 `loadConfigFile` 读取配置、`jsonlReporter` 保存事件，以及 `normalizeTrace`、`gradeRuntime` 处理原生执行证据。使用文件日志时，应在结束后调用 reporter 的 `close()`。

## 自定义 provider

实现 `Provider` 接口即可接入其他后端：

```ts
import type { Provider, ProviderResult } from "agent-skills-eval";

export const provider: Provider = {
  name: "my-provider",
  model: "my-model",
  async complete(prompt: string): Promise<ProviderResult> {
    // 在这里调用你的后端，并填写实际输出与用量。
    return {
      provider: "my-provider",
      model: "my-model",
      output: "模型输出",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  },
};
```

该接口适用于本地模型服务、内部 API、路由层和单元测试替身。已有的仅实现 `complete()` 的 provider 仍可使用。

## 技能目录与用例

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

`SKILL.md` 示例：

```markdown
---
name: my-skill
description: 分析小型 CSV 文件，找出关键趋势并引用相关数据。
license: MIT
---

收到 CSV 文件后，找出最重要的趋势，并引用支持结论的数据行。
```

`evals/evals.json` 示例：

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": "basic",
      "name": "收入汇总",
      "prompt": "根据附件数据汇总收入。",
      "files": ["evals/files/input.csv"],
      "expected_output": "回答指出收入最高的月份。",
      "assertions": ["回答正确指出收入最高的月份，并引用对应金额。"]
    }
  ]
}
```

`files` 路径相对于技能目录。省略 `assertions` 但提供 `expected_output` 时，程序会将预期输出转为模型裁判断言。

原生模式可额外添加：

| 字段 | 用途 |
| --- | --- |
| `should_trigger` | 是否预期加载指定技能。 |
| `runtime_checks` | 命令、顺序、文件、内容、改动和效率检查。 |
| `verification` | 独立构建、测试或本机 HTTP 冒烟检查。 |
| `captured_files` | 保存指定产物，并将文件内容提供给裁判。 |

完整字段和示例见[中文运行指南](docs/runtime-evaluation.zh-CN.md)。

## CLI 参数

使用 `node dist/cli.js --help` 查看全部选项。

| 参数 | 说明 |
| --- | --- |
| `[root]`、`--config` | 技能扫描目录、YAML 或 JSON 配置文件。 |
| `--runtime`、`--judge-runtime` | 选择目标和裁判运行方式。 |
| `--target`、`--judge` | 指定模型名称。 |
| `--baseline` | 启用无技能基线对比。 |
| `--workspace`、`--layout` | 产物目录和布局，布局支持 `iteration`、`flat`。 |
| `--base-url`、`--api-key-env` | API 地址和密钥环境变量名称。 |
| `--include`、`--exclude` | 技能路径筛选规则。 |
| `--concurrency` | 并行运行的用例数。 |
| `--strict` | 校验技能前置信息。 |
| `--executable`、`--timeout-ms` | 指定原生目标 CLI 路径和超时。 |
| `--allow-writes` | 允许原生目标在任务工作区写入。 |
| `--report`、`--no-report` | 启用或关闭 HTML 报告。 |
| `--report-title`、`--report-output` | 报告标题和输出目录。 |
| `--log-format`、`--log-file` | 日志格式及 JSONL 日志文件。 |
| `--verbose`、`--no-color` | 完整日志和关闭 ANSI 颜色。 |

日志格式：`pretty` 便于人工阅读，`jsonl` 便于程序消费，`silent` 关闭进度日志。

## 报告与运行产物

CLI 默认使用 `iteration` 布局；SDK 默认为 `flat`，可通过 `workspaceLayout` 修改。单技能评估的 iteration 目录示例：

```text
agent-skills-workspace/
└── iteration-1/
    ├── meta.json
    ├── benchmark.json
    ├── eval-basic/
    │   ├── with_skill/
    │   │   ├── grading.json
    │   │   ├── timing.json
    │   │   ├── prompts.json
    │   │   └── outputs/
    │   └── without_skill/
    └── report/
        └── index.html
```

HTML 报告展示评分、逐条断言证据、两种模式的输出、提示词、耗时、token 和工具调用。原生模式还保存 `trace.jsonl`、`trace.json`、`execution.json`、确定性与模型评分文件，以及工作区结果副本。触发混淆统计保存在 `benchmark.json` 中。

## 兼容性与评估边界

- `SKILL.md` 支持 `name`、`description`、`license`、`compatibility`、`metadata` 和 `allowed-tools` 等前置信息。
- 严格校验包括名称格式、名称与目录一致性，以及描述和兼容性字段的长度。
- 保留原有 `defaults`、模型 `params`、工具定义和 `tool_assertions`；原生目标使用自己的工具和 `runtimeOptions`。
- 模型裁判要求断言身份、布尔结果和非空证据。不支持 JSON Schema 的兼容 API 可设置 `structuredOutput: false`，本地结果校验仍然生效。
- 技能加载证据只表示观察到读取或调用，不能单独证明遵循了全部指令。应结合过程检查和产物验证。
- 原生执行使用独立临时工作区，但仍可能受到用户级技能、插件、CLI 配置和认证环境影响；临时目录不是操作系统沙箱。

## 示例与开发

- [基础 API 技能示例](examples/basic-skill)
- [API 配置示例](examples/agent-skills-eval.yaml)
- [共用原生技能与四类用例](examples/runtime-skill)
- [Codex 配置](examples/codex-eval.yaml)
- [Claude Code 配置](examples/claude-eval.yaml)

开发检查：

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

文档页面源码位于 [docs](docs)，可在本地预览：

```sh
python -m http.server 8080 --directory docs
```

## 贡献与许可证

欢迎提交问题、改进和技能用例。参与前请阅读[贡献指南](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md)和[安全说明](SECURITY.md)。

项目采用 [MIT 许可证](LICENSE)。
