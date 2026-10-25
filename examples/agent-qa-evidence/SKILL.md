---
name: agent-qa-evidence
description: Reviews supplied agent-qa run evidence and distinguishes application results from selection checks, setup failures, and incomplete records.
license: MIT
compatibility: Works with text-capable chat models and supplied evidence; no agent-qa installation or tool execution is required.
metadata:
  owner: vostride
  domain: software-testing
---

# Review agent-qa evidence

[agent-qa](https://github.com/vostride/agent-qa) combines natural-language web/mobile tests with advanced memidex memory and self-improvement. Review the supplied command observations and run records without executing tests or changing the application.

## Decide what the evidence establishes

1. Identify the requested test, target, revision, and expected observable outcome. Bind the evidence to that scope; do not inherit another run's result.
2. Separate configuration/YAML validation, test discovery, application execution, and memory inspection. Successful validation and `--dry-run` selection do not prove application acceptance or a JUnit artifact.
3. Inspect the selected run's completed verdict and relevant observations. An empty failed-run list can omit incomplete or healed runs. Missing verdicts and `evidence-incomplete` knowledge remain unresolved.
4. Interpret exit status alongside the command and error: `0` can mean passed or healed; `1` can mean a failed/timed-out test or a missing required file; `2` means the run could not start; `130` means cancellation. A setup error is not proof of an application defect.
5. For a healed run, preserve the distinction from a clean pass and explain the recorded correction. Verify that the original expected outcome still holds. Do not weaken assertions or erase memory to create a passing result.
6. Treat memidex observations as diagnostic context, not an independent acceptance oracle. Missing knowledge evidence does not establish what was supplied or learned.

Use these report labels for this example; they are not additional agent-qa CLI verdicts:

- `PASSED`: a completed passing run and its observed assertion establish the requested outcome for the stated scope.
- `HEALED`: a completed healed run retains the original assertion and has evidence of the correction and resulting outcome.
- `FAILED`: observed application behavior contradicts the expected outcome in a completed run.
- `UNVERIFIED`: selection-only output, unavailable execution, incomplete evidence, mismatched scope, or missing required observations prevent a supported outcome.

Return the label, evidence supporting it, and the specific remaining check if any. Retain the run ID and relevant command/error when supplied. Distinguish provided observations from inference; do not invent execution, screenshots, reports, or completion. Preserve sensitive-data redaction.

The command semantics above follow agent-qa 0.2.3. Consult the [CLI reference](https://vostride.com/docs/agent-qa/cli) and [memory inspection guide](https://vostride.com/docs/agent-qa/memory/inspect) when interpreting a different version. The evaluator supplies files as text; this skill does not fetch those links.
