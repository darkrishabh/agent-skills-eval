# Claude Code and Codex evaluation implementation plan

**Goal:** Extend the existing SDK and CLI with real agent execution, reproducible evidence, deterministic checks and structured grading on both runtimes.

**Architecture:** Keep provider mode and the current reports. Add a runtime provider with an explicit agent execution method, normalized traces, per-case scratch workspaces, and deterministic checks. Keep runtime execution, parsing and orchestration independent. Claude means Claude Code CLI; API compatibility remains available via provider mode.

**Tech stack:** TypeScript, Node child_process, node:test, existing Commander and YAML parser.

## Chunk 1: Evidence and execution

- [ ] Add shared runtime contracts in `src/runtime-types.ts`.
- [ ] Test and implement strict Codex/Claude JSONL normalization in `src/runtime.ts`; deduplicate lifecycle events; identify only skill-specific loading evidence; incomplete traces must fail closed.
- [ ] Test and implement command/order, file/content/allowlist, permission and efficiency checks in `src/runtime.ts`. Unknown usage is not zero.
- [ ] Test and implement subprocess handling and `RuntimeProvider` in `src/runtime-provider.ts`: stdin prompts, safe executable resolution on Windows, timeout/tree termination, fresh workspace per mode, same input fixtures, only selected skill staged, raw evidence persisted.
- [ ] Run optional build/test commands and server URL smoke checks in the scratch workspace, retaining logs and process outcomes.

## Chunk 2: Integration and grading

- [ ] Extend `src/types.ts`, `src/provider.ts`, `src/skill.ts`, `src/config.ts`, `src/cli.ts` with runtime options, should_trigger, runtime_checks, verification and captured_files.
- [ ] Test then fix baseline attachments in `src/run-eval.ts`. Use native discovery for runtime targets without forcing skill instructions into the prompt.
- [ ] Persist trace, execution and category scores; fail target errors independently from rubric grades. Optional judge supports deterministic-only runs without API keys.
- [ ] Add schema-constrained judge output and preserve source assertions; enforce identity, boolean and evidence validation, retaining judge raw output.
- [ ] Add trigger confusion metrics and runtime metadata to benchmarks, and process/outcome/style/efficiency evidence to existing HTML reports.

## Chunk 3: Delivery

- [ ] Add a shared runtime example with explicit, implicit, contextual and negative cases plus Chinese documentation and tested commands for both CLIs.
- [ ] Run `npm test`, `npm run typecheck`, `npm pack --dry-run`; exercise both adapters through deterministic fixture CLI processes. Attempt real CLI smoke tests where local credentials permit and state exact limitations.
- [ ] Review implementation against approved scope and tests; fix confirmed issues. Keep changes local for review.

## Acceptance and limits

Existing API callers keep working. Both runtime modes use the same eval schema and both baseline modes receive the same inputs. Evaluation does not execute in the source repo. Native CLI user configuration can still influence agent selection and is disclosed in metadata/documentation; scratch directories are not OS security sandboxes. Skill loading evidence establishes an observed read/invocation, not proof of full adherence. Report missing metrics as unknown. No automatic permission bypass flags.

Reference: https://developers.openai.com/blog/eval-skills ; https://code.claude.com/docs/en/headless
