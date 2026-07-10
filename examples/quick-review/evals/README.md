# quick-review evals

`quick-review` is a fully agentic skill — it runs `git`/`uv` commands via
`scripts/review-tools.py` and, in glab/gh mode, shells out to `glab`/`gh` — not
a single text-in/text-out transform like `basic-skill`. That changes how it
has to be tested in this framework.

## Why these evals need `--run-mode opencode`

The default `api` run mode sends the skill as a system prompt and gets back
one chat completion — there's no real Bash/file execution, so
`uv run scripts/review-tools.py get-staged` etc. can't actually run. Testing
this skill for real means using `--run-mode opencode`, which shells out to a
real `opencode` agent with real tool access, running in a real git repo.

## The fixture

Because `--run-mode opencode` shares one `opencode.dir` across every eval and
every `with_skill`/`without_skill` run in a single CLI invocation, the three
evals here can't each get their own repo. Instead, `setup_fixture.py` builds
**one** repo with three independent diffs baked in simultaneously:

| Diff | git state | Eval | Planted issues |
|---|---|---|---|
| branch vs `origin/main` | `feature/456-add-transfer`, 1 commit ahead | `review-branch-transfer-endpoint` | SQL injection (f-string), missing authorization check, no amount validation, no transaction/rollback |
| staged (index) | `git add`-ed on top of the branch commit | `review-staged-remember-me` | plaintext password in a "remember me" cookie, unauthenticated destructive `reset_all_balances()` |
| working tree (unstaged) | on top of the staged changes | `review-working-tree-audit-logging` | logs the raw password, deeply nested duplicate conditionals, missing docstring |

A `CONTRIBUTING.md` is committed alongside with conventions that each planted
issue actually violates (authorization checks required, never log secrets,
wrap multi-step balance updates in a transaction), so the skill's
convention-discovery step has something real to find and the reviews can be
graded on whether they connect findings back to it.

Rebuild the fixture any time with:

```bash
uv run examples/quick-review/evals/setup_fixture.py
```

It deletes and recreates `evals/fixture-repo/` from scratch, so it's safe to
re-run after a run that left the repo dirty (e.g. a `without_skill` baseline
that "fixed" something instead of just reviewing it — see the caveat below).

## Running

```bash
uv run examples/quick-review/evals/setup_fixture.py
npx agent-skills-eval --config examples/agent-skills-eval.quick-review.yaml
```

The config pins `runMode: opencode`, `opencode.dir` at the fixture repo, and
`concurrency: 1`. **Don't raise concurrency for this skill** — every run
shares the same working directory, so running more than one at a time means
concurrent git operations (checkouts, staging, commits) against the same
working tree, which will corrupt the fixture state mid-run.

`opencode.auto: true` is also load-bearing here: without it, the opencode
subprocess has no human to approve its Bash/file-edit tool calls and will
hang. It's scoped to the throwaway fixture directory, but it is a real,
unattended auto-approval of tool use — see the "opencode run mode" section of
the main README before reusing this pattern against a real repo.

## A note on the `without_skill` baseline

`--baseline` (set via `baseline: true`) runs both `with_skill` and
`without_skill` against the same prompts and the same fixture repo. The
prompts ask for a *review*, not a fix, so a reasonable agent should only read
the repo — but nothing stops a baseline run without the skill's instructions
from deciding to "helpfully" edit the code instead of just describing what's
wrong. If a run looks suspicious (e.g. `git diff` output doesn't match what
`setup_fixture.py` printed), re-run the setup script before evaluating again.
