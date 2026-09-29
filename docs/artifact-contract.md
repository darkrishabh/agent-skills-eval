# Artifact contract for external adapters

This describes the JSON written by the provider-based evaluator. Adapters should
pin the package version they support and validate required fields. There is no
embedded schema-version field or signed provenance in these artifacts. Ignore
unknown fields to allow additive changes; do not infer a future schema from a
pending runtime-provider PR.

## Locate a skill's output

Use the SDK result's `skills[].dir` and `skills[].benchmarkPath` when available.
Otherwise discover a skill's `meta.json` alongside `benchmark.json` rather than
assuming a fixed directory depth:

- CLI default, `layout: iteration`, one skill:
  `<workspace>/iteration-N/<eval-slug>/<mode>/grading.json`.
- Iteration layout, multiple skills:
  `<workspace>/iteration-N/<skill-slug>/<eval-slug>/<mode>/grading.json`.
- SDK default, `workspaceLayout: flat`:
  `<workspace>/<skill-slug>/<eval-slug>/<mode>/grading.json`.

`meta.json` lives at the parent of the eval directories and contains `name`,
`slug`, `relPath`, `target`, `judge`, `modes`, and `generated_at`. Modes are
`with_skill` and optionally `without_skill`. Slugs are sanitized labels, not
persistent globally unique IDs. An adapter should retain a source-run identifier
and the relative artifact path. Flat layout replaces the prior skill directory.
Iteration layout increments locally but resets `iteration-1` when `CI=true`.
Archive artifacts before a subsequent run if historical reproducibility matters.

## Per-run records

| File | Fields / interpretation |
|---|---|
| `grading.json` | `assertion_results`: array of `{text: string, passed: boolean, evidence: string}`; `summary`: `{passed, failed, total, pass_rate}`. Counts are assertion counts. |
| `timing.json` | `duration_ms`, `total_tokens` for the target provider, excluding judge work. |
| `outputs/response.txt` | Target output text; provider errors can appear as `ERROR: ...`. |
| `prompts.json` | `user`, optional `system`, optional `judgePrompt`, `fileCount`, optional `tools`, optional `tool_choice`. |
| `tool_calls.json` | Optional nonempty array of `{id?, type: "function", function: {name, arguments}, parsedArguments?}`. `arguments` is a JSON string from the provider and can be malformed; `parsedArguments` is optional. |

`pass_rate` is `passed / total`; with zero assertions the current implementation
uses 1. Treat an empty rubric as ungraded in downstream trust decisions, rather
than proof of quality. The current grading rows do not label rubric versus
local tool assertions. Retain the original eval definition to classify them;
do not label every row as an LLM judge result. A captured tool call records a
request, not independent proof that its underlying operation succeeded.

Token and cost completeness depends on the provider. Missing token usage may
be represented as zero. `timing.json` does not contain a cost amount. Adapters
must not manufacture billing data, signatures, generation hashes, or judge
sample hashes from these aggregates.

## Benchmark records

`benchmark.json` contains a `run_summary` object:

- `with_skill` has `pass_rate`, `time_seconds`, and `tokens`, each an object
  with numeric `mean` and `stddev`.
- `without_skill` has the same shape and is present only when baseline runs
  were aggregated.
- `delta`, when present, has numeric `pass_rate`, `time_seconds`, and `tokens`:
  each is the with-skill mean minus the without-skill mean.

Means weight each completed eval run equally, not each assertion equally.
Standard deviation is the population standard deviation, and aggregate values
are rounded to six decimal places. `benchmark.json` does not include per-case
results, cost, sample counts, or an overall pass/fail flag. Cases that throw
before returning a result can be absent from these aggregates: retain the SDK
summary / event log and check completion, not just benchmark pass rates.

## Adapter policy

EvalPort and receipt-format integrations should remain external packages. A
converter may map each mode into its own result set, carrying mode and source
artifact paths as metadata. Preserve raw grading rows and the original records
when a destination format cannot represent their semantics without loss.
Validate against that destination's current schema within the adapter project.
Imported records are declarations of source results, not cryptographically
attested executions. Hashing retained files later proves the bytes you imported;
it does not establish who executed them or make absent evidence available.

The repository's artifact tests exercise the fields above using deterministic
fixture providers. Those fixtures validate serialization, not model quality.
