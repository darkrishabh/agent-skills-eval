# Experimental native-runtime foundation

This is the first implementation slice of [#38](https://github.com/darkrishabh/agent-skills-eval/issues/38).
It is exported from `agent-skills-eval/experimental/runtime`. Its contracts are
open for review; it is not wired into the existing CLI or `evaluateSkills` yet.

## Collaboration and scope

The design builds on complementary contributions:

- [#25 by @tmnd1991](https://github.com/darkrishabh/agent-skills-eval/pull/25):
  OpenCode SDK sessions, delegated-work handling, and a real repository fixture.
- [#35 by @jasonlihaitao-sketch](https://github.com/darkrishabh/agent-skills-eval/pull/35):
  explicit native execution, isolated workspaces, raw traces, and deterministic checks.

This first slice implements the common lifecycle from that discussion. Neither
adapter implementation is copied or replaced here. Both original PRs remain
separate; the authors are invited to review the contract before ports. The
OpenCode adapter can retain its SDK/server transport.

## Boundary

`AgentRuntime.probe()` describes the runtime/adapter versions, model, configuration profile, discovery directory,
observation capabilities, and configuration limitations. `run(prepared, signal)`
owns the real agent loop, sessions/processes, and their cancellation. It receives
a run-owned directory, prompt, skill path (with-skill mode only), and a synchronous
`recordEvent` sink. Record native events and harness-generated continuations as
they occur, not just the final answer. Never put credentials into runtime info
or events. The adapter must terminate owned work before its promise settles;
it must not keep writing to the workspace or event sink after completion.

`executeAgentRun` owns:

1. Copying declared task fixtures into a unique workspace.
2. Copying skill payloads for with-skill mode, preserving top-level helper files
   and executable permissions while excluding top-level `evals` and `.git`.
3. Persisting raw events and terminal execution status.
4. Capturing a target snapshot and file hashes **before verification**.
5. Running each verifier on its own disposable copy of that snapshot.
6. Saving a versioned `run.json` and cleaning its temporary workspaces.

Task and skill inputs stay separate. Task fixtures must not include top-level
`.git`, `.agents`, `.claude`, `.opencode`, or `evals`; prepare a task-only fixture
first. A declared skill directory must contain only the payload intended for
agent access: the exclusion of `evals` cannot identify answer material placed
under arbitrary other names. Symlinks and special files are rejected rather
than exposing writable references to source files. `outputDir` must be new and
must not overlap an input directory, including through a symlink alias.

## Adapter-facing example

```ts
import { executeAgentRun, type AgentRuntime } from 'agent-skills-eval/experimental/runtime';

// Supply an adapter implemented against the agreed contract.
async function evaluateOne(runtime: AgentRuntime) {
  return executeAgentRun({
    runtime,
    fixtureDir: './fixtures/task-only',
    skill: { name: 'review', dir: './skills/review' },
    mode: 'with_skill',
    prompt: 'Review the supplied project.',
    outputDir: './runs/case-1-with-skill',
  });
}
```

Call it separately with `mode: 'without_skill'` and a different output directory
for the other half of a pair. The caller must use the same fixed fixture source;
compare `taskFiles` hashes to detect a changed source between runs. Atomic paired
snapshot allocation and repository-history fixtures belong in the next slice.

## Evidence semantics

`run.json` contains runtime identity/limitations, execution status, native tool
outcomes, skill-loading observations, optional usage, initial/target file hashes,
changed paths (including deletions and executable-bit changes), and independent
verification results. `target/` is the saved pre-verification state;
`trace.jsonl` contains events supplied by the adapter; `execution.json` preserves
the terminal result even if snapshot capture subsequently fails. Harness failures
write `harness-error.json` and reject; never treat a partially copied target tree
without a successful `run.json` as a complete result.

A successful verifier does not change `execution.status`, `changedFiles`, or
`targetFiles`. Verification statuses are separate from target correctness: a
build that creates a report in its own copy cannot prove the agent created that
report. Verifiers are skipped after target failure/timeout/cancellation. Each
verifier starts from the same target state, so checks cannot depend on artifacts
produced by an earlier verifier; group dependent build/test steps in one verifier.

Native tool events retain attempted/succeeded/failed/unknown states. A failed
skill-loading request is not a successful load. Missing usage stays absent.
Adapters must use `unknown` where their traces cannot establish an observation;
capability flags describe support, not evidence of a particular run. The harness
does not independently authenticate the truth of adapter-supplied events.

## Limits and next slices

- Filesystem copies are **not an OS sandbox**. Callbacks/adapters are trusted code
  running with host permissions; a malicious verifier is not confined by this API.
  Copies prevent ordinary verifier writes from contaminating the target snapshot,
  not deliberate access to other host paths.
- Baseline comparability is always `unverified` in this slice. No guarantee is made
  about inherited global skills/config, credentials, plugins, or external MCP state.
- Cancellation is cooperative. Adapters own process-tree/session termination and
  timeout enforcement; a hung adapter that ignores abort can still hang this API.
- No native OpenCode/Codex/Claude adapter, runtime preflight, CLI integration,
  judge execution, outcome grader, or report integration ships in this slice.
- No git-history fixture, stable paired-run scheduler, or resource-size quota yet.
  Copy/hash operations are synchronous and intended for small declared fixtures.
- Tests use in-process fake adapters to prove lifecycle behavior. They are not
  live runtime compatibility or model-quality measurements.

Next: settle the contract with both authors; add repository/paired snapshots and
resource limits; port their adapters with process cancellation and versioned
trace fixtures; connect frozen evidence to grading; then run opt-in live smoke
tests before advertising compatibility. Keep discovery, outcome, adherence,
and efficiency separate in reports.
