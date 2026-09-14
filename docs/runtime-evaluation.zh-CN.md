# 在 Claude Code 和 Codex 中评估技能

项目保留原有 provider/API 评估模式，同时增加真实 CLI 执行模式。两种 CLI 共用 `SKILL.md`、`evals/evals.json`、输入文件、确定性检查和报告格式。

设计参考 [OpenAI 的技能评估文章](https://developers.openai.com/blog/eval-skills)：先定义可验证的行为，再分别观察触发、执行过程、产物和效率。评估结果同时保留模型评分与确定性检查，便于复现失败。

## 运行示例

在项目根目录执行以下命令。需要 Node.js 18+、Git，以及已安装并完成登录的相应 CLI。

```sh
npm ci
npm run build

# 使用 Codex
node dist/cli.js --config examples/codex-eval.yaml

# 使用 Claude Code
node dist/cli.js --config examples/claude-eval.yaml
```

登录和执行环境按 [Codex 非交互模式文档](https://developers.openai.com/codex/noninteractive)与 [Claude Code 程序化调用文档](https://code.claude.com/docs/en/headless)配置。运行时继承当前 CLI 的认证、环境变量和用户配置；使用 CLI 作为 target 或 judge 时，不要求额外配置 `OPENAI_API_KEY`。模型访问仍取决于各自账户与配置。

示例不指定 `target` 模型，沿用 CLI 的默认模型。`judgeRuntime: none` 表示仅运行确定性检查，因此没有额外模型裁判调用。`baseline: true` 会让四个用例各运行两次，共八次目标 CLI 调用。

YAML 的 `root`、`workspace` 等相对路径以启动命令的当前目录为准。两个示例都将结果保存在 `agent-skills-workspace` 中，并使用 iteration 布局保留每次运行。

## 共用的四个用例

示例技能位于 `examples/runtime-skill`，负责把标签列表转换为规范 JSON 报告。它使用 Node.js 内置库，不安装依赖，也不访问网络。

| 用例 | 输入方式 | 预期触发 |
| --- | --- | --- |
| explicit | 在任务中明确请求使用 `runtime-skill` | 是 |
| implicit | 只描述标签归一化与报告需求 | 是 |
| contextual | 从提供的本地交接文档了解任务 | 是 |
| negative | 回答无关的简单算术问题 | 否 |

正向用例要求生成 `report.json`，内容为 `format: "runtime-report/v1"`、`count: 3` 和排序后的 `labels: ["alpha", "beta", "gamma"]`。检查包括 Node.js 命令、文件存在性、格式标记、改动白名单、命令次数、耗时，以及独立脚本对完整 JSON 的精确比较。负向用例重点检查未触发技能且未创建或修改文件，不评价算术答案的语义。

每次执行会建立新的任务工作区，将 `files` 中相对于技能目录的文件复制到同样的相对路径。例如 `evals/files/labels.json` 在两种模式中均可读取。只有 `with_skill` 会将所选技能放进 CLI 的原生发现目录：Codex 使用 `.agents/skills`，Claude Code 使用 `.claude/skills`。评估器不把技能正文强行塞入目标提示词。

`without_skill` 使用相同提示词、输入文件和产物验收条件，并且预期未加载这个技能。显式请求在基线中找不到技能是有意保留的条件。触发混淆矩阵主要描述 `with_skill` 的选择行为，应结合产物分数和效率判断技能是否带来收益。

## 配置目标和裁判

`runtime` 可设为 `provider`、`codex` 或 `claude`；不设置时保留原有 provider 模式。`judgeRuntime` 可设为这些值或 `none`。例如用 Codex 执行、Claude Code 评分：

```yaml
runtime: codex
judgeRuntime: claude
runtimeOptions:
  allowWrites: true
  timeoutMs: 120000
judgeOptions:
  timeoutMs: 120000
```

使用 rubric 时，在用例中添加 `assertions`，例如 `"The final response clearly identifies the output path and normalized label count."`。设置 `judgeRuntime: none` 时，删除 rubric `assertions` 和 `expected_output`；否则配置会报错。确定性检查不需要裁判。

模型裁判使用固定 JSON Schema，必须按原文标识每条断言、返回布尔 `passed` 和非空 `evidence`。即使裁判调整顺序，也按断言原文匹配。遗漏、重复、未知断言、无效类型或请求错误都会导致重试；最多两次尝试，仍无效则判失败。汇总分数由程序重新计算，裁判不能自报一个不一致的总分。

provider 裁判通过兼容 API 的 `response_format: json_schema` 请求结构化输出。对于不支持此功能的模型或兼容端点，可在 YAML 中设置 `structuredOutput: false`，仍会执行本地严格校验。旧版仅实现 `complete()` 的自定义 provider 也能继续使用。

`runtimeOptions.allowWrites` 默认关闭。示例需要生成文件，所以显式开启。Claude 示例的 `allowedTools` 允许本地读取、编辑、执行命令和技能调用；它是本示例所需的工具授权配置，可按实际任务缩小范围。实现不会加入跳过全部权限检查的参数。权限拒绝会进入 trace，启用 `noPermissionDenials` 后作为失败检查呈现。

## 编写确定性检查

以下字段写在 `evals/evals.json` 的单个用例内，名称大小写需要保持一致：

```json
{
  "id": "report",
  "prompt": "Create the report from evals/files/labels.json using Node.js.",
  "files": ["evals/files/labels.json"],
  "assertions": [],
  "should_trigger": true,
  "captured_files": ["report.json"],
  "runtime_checks": {
    "requiredCommands": ["node"],
    "forbiddenCommands": ["npm install"],
    "requiredFiles": ["report.json"],
    "forbiddenFiles": ["package-lock.json"],
    "fileContents": [{"path": "report.json", "contains": "runtime-report/v1"}],
    "allowedChanges": ["report.json"],
    "maxCommands": 15,
    "maxRepeatedCommands": 2,
    "maxDurationMs": 120000,
    "noPermissionDenials": true
  },
  "verification": [{
    "name": "parse-output",
    "command": "node",
    "args": ["-e", "JSON.parse(require('node:fs').readFileSync('report.json','utf8'))"],
    "timeoutMs": 10000
  }]
}
```

`requiredCommands`、`forbiddenCommands` 使用命令字符串的子串匹配。CLI 可能记录 PowerShell、Bash 等包装命令，因此应从实际 trace 中挑选稳定片段。这些检查是行为证据，不是命令语义分析或安全边界。

`commandOrder: ["prepare.mjs", "verify.mjs"]` 要求在两个按顺序出现的命令事件中分别匹配；将两个片段放在同一个 shell 调用里不能证明两步顺序。命令次数与重复命令只依据捕获到的事件，不计入模型未执行的自然语言计划。

文件路径相对于任务工作区，使用具体相对路径。`allowedChanges` 限制新建、修改、删除的路径，`allowedChanges: []` 要求无改动。`fileContents` 是子串检查；精确 JSON、构建和测试条件应交给 `verification`。`captured_files` 用于保存产物并给裁判提供文件证据。

每项 `verification` 直接执行 `command` 与 `args`，在同一任务工作区运行并保存 stdout、stderr、退出状态和耗时。需要 shell 特性时应显式选择对应 shell，避免把完整命令和参数混进 `command`。可用于 `node --test`、构建脚本等。独立验证程序应检查实际结果，而不是复述目标模型的“已完成”。

运行时 smoke test 可在验证项中设置 `url`：启动指定服务命令、轮询本机 HTTP(S) URL，随后停止服务。例如 `command: "node"`、`args: ["server.mjs"]`、`url: "http://127.0.0.1:3000/health"`。端口应避免与本机其他服务冲突。

`maxTokens`、`maxCostUsd` 是可选预算。CLI 未报告的 token 或成本保持未知；配置对应预算而没有数据时，检查不能通过。不会把缺失值解释为零成本。`maxDurationMs` 是评分门槛，`runtimeOptions.timeoutMs` 是终止执行的超时，两者职责不同。

## 阅读结果和证据

运行结束后打开 CLI 输出所指向的 HTML 报告。总体分数之外，还应查看 `process`、`outcome`、`style`、`efficiency` 各类别与触发统计，定位是选错技能、执行失败、产物不合格还是资源消耗过高。

单次执行目录包含：

| 文件 | 用途 |
| --- | --- |
| `trace.jsonl` | 原始 CLI stdout 事件，方便按 CLI 协议排查 |
| `trace.json` | 归一化命令、工具、技能加载证据、用量和错误 |
| `execution.json` | 子进程退出状态、stderr、文件改动、产物和验证结果 |
| `deterministic-grading.json` | 本地确定性断言及证据 |
| `rubric-grading.json` | 模型裁判断言及证据 |
| `judge-response.txt` | 最后一次裁判原始响应；无 rubric 时为空 |
| `workspace/` | 临时任务工作区的结果副本，省略 Git 内部文件和符号链接 |

非零退出、超时、不完整事件流、无法解析的事件或 CLI 错误都会使执行有效性检查失败，即使模型文字声称成功也不会掩盖执行失败。失败时先看 `execution.json` 与 `trace.jsonl`，再分析评分。

技能加载证据代表观察到该技能被读取或调用，不能单独证明执行了所有指令。过程检查和产物验证需要同时使用。用户级技能、插件、MCP、CLI 设置和模型默认值仍可能影响执行；评估器只控制本次工作区中的技能与输入，不提供完全隔离的机器环境。工作区也不是操作系统安全沙箱。

建议固定 CLI 版本、模型和用户配置后重复运行同一组用例，比较历史 iteration 中的误触发、漏触发、实际结果与资源指标。四个示例用于展示完整流程，不代表真实业务上的统计置信度。
