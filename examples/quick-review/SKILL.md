---
name: quick-review
description: 'Single-pass bird''s-eye code review across 5 dimensions: Correctness, Design, Maintainability, Security, Risk & Operations. Use when asked to "quick review", "fast review", "review my MR", "review PR", "review staged", "review my branch", "check my code". Lower token usage than super-review: no sub-agents, no forensic line-by-line pass — bird''s view only. Auto-discovers conventions. Posts results via glab or gh, or renders a Markdown report locally. Skips mechanical concerns (linting, formatting, compilation) — CI owns those.'
---

# Quick Review

Single-pass 5-dimension code review, bird's-view only. All evaluation happens in one inline pass.

There are 4 steps, use a todo list to mark progress:

1. context
2. changeset
3. bird's-eye evaluation
4. output

---

## Step 1 — Context

### Platform Detection

| User mentions | Mode | Requirement |
|---|---|---|
| MR / merge request | `glab` | glab skill required — **abort if unavailable** |
| PR / pull request | `gh` | gh CLI required — **abort if unavailable** |
| staged / working / branch / nothing specific | `local` | none |

**glab:** identify the MR → glab skill *Identifying the Current MR*.  
**gh:** `gh pr view --json number,title,body`.

---

### Issue Context (best-effort)

Run `uv run scripts/review-tools.py extract-issue-ref` to extract an issue number from the branch name.  
Also scan MR/PR title and description for refs (`Closes #123`, `Relates to #456`).

Fetch issue details if found:
- glab → glab skill *Fetching Related Issues*
- gh → `gh issue view <N>`

On failure: set `context = {}`, note "Issue context unavailable".

Result: `context = {problem, constraints, expected_outcomes}`

---

### Convention Discovery (best-effort)

Run `uv run scripts/review-tools.py find-conventions` to locate and print relevant guideline files. Summarise as `coding_guidelines`.

---

## Step 2 — Changeset

| Mode | Action |
|---|---|
| `glab` | glab skill: *Fetching MR Data* (diffs endpoint) |
| `gh` | `gh pr diff <number>` |
| `local` — staged | `uv run scripts/review-tools.py get-staged` |
| `local` — working tree | `uv run scripts/review-tools.py get-working` |
| `local` — branch / default | `uv run scripts/review-tools.py get-branch` |

**Abort** if the diff is empty.

Produce a **mental model** (≤150 words): what changed, why, key data flows affected. This is the only input to Step 3.

---

## Step 3 — Bird's-Eye Evaluation

Evaluate all 5 dimensions in a **single inline pass** using the mental model, `context`, and `coding_guidelines` from the previous steps.

For each dimension, answer the probe questions below and emit any issues found.

---

### Correctness

**Core question:** Is the overall approach algorithmically correct?

- Is the algorithm or flow fundamentally correct for the stated requirement?
- Are entire categories of input or state systematically unhandled (empty collections, unauthenticated paths, concurrent modifications)?
- Does the change implement the right thing — or the right thing incorrectly?
- Are domain invariants preserved across the whole change?

---

### Design

**Core question:** Is this a good way to solve the problem in this system?

- Does the overall approach fit the existing architecture, or does it introduce a conflicting pattern?
- Is responsibility correctly assigned — or is this logic in the wrong layer / component?
- Does the change increase coupling between components that should be independent?
- Are new abstractions the right level, or are they leaking or premature?
- Does the design leave room to evolve, or does it bake in assumptions?

---

### Maintainability

**Core question:** Will the next maintainer understand this?

- Does the overall change increase or decrease cognitive load?
- Is it consistent with existing patterns, or does it introduce a new idiom without justification?
- Is complexity growing in a compounding way (deeply nested conditionals, growing god classes)?
- Is the intent self-evident from the structure, or does it require tribal knowledge?
- Do new or modified public APIs (functions, classes, modules) have accurate docstrings?
- Is non-obvious logic accompanied by a WHY-comment (motivation, not just mechanics)?
- Does the change affect user-visible behavior, configuration, or public APIs in a way that requires README or external doc updates?
- If user-visible behavior changed, is a changelog entry present?

---

### Security

**Core question:** Are trust boundaries preserved?

- Are trust boundaries maintained across the change? Does it shift who is trusted?
- Is the authorization model consistent, or does this path skip a check every other path enforces?
- Does the change expose a new attack surface (endpoint, input path, integration)?
- Are secrets, credentials, or PII handled with the same care as the rest of the system?
- Does the change violate least privilege at the architectural level?

---

### Risk & Operations

**Core question:** What happens when this fails in production?

- What is the blast radius if this fails? Scoped or cascading?
- Does the change introduce a new failure mode the on-call team is unprepared for?
- Is observability coherent — are the right signals present for the new behavior?
- Is the deployment safe? Does it require a coordinated release, migration, or feature flag?
- Can this be rolled back without data loss or breaking dependents?

---

### Issue Format

Emit each finding as:

```
severity: must-fix | should-fix | consider | optional
category: <dimension name>
title: <one line, concrete>
description: <what is wrong and why it matters>
file: <path or null>
line: <number or null>
suggestion: <concrete fix or null>
```

Do not flag: linting, formatting, compilation, test coverage — CI owns those.

Deduplicate: remove exact duplicates; keep the most specific when two dimensions flag the same concern, note "(also flagged by {Dimension})".

---

## Step 4 — Output

### glab mode

Use glab skill patterns *Posting Review Threads* and *Updating an MR*.

- `must-fix` + `should-fix` → one inline thread each
- `consider` + `optional` → batched into the final summary note
- Fall back to MR-level note if inline positioning fails
- Post one summary note via `glab mr note`
- **Confirm with the user before posting**

Inline thread format:

```
**[{Category}] {Severity label}** {title}

{description}

**Suggestion:**
```lang
{suggestion}
```
```

---

### gh mode

- Any `must-fix` → `gh pr review --request-changes`
- `should-fix` / `consider` only → `gh pr review --comment`
- Inline where file+line are available; general comment otherwise
- **Confirm with the user before posting**

---

### local mode

Render the report below in the chat response.

---

### Severity Labels

| Value | Label | Action |
|---|---|---|
| `must-fix` | 🔴 Must Fix | Blocks merge |
| `should-fix` | 🟠 Should Fix | Address before merge |
| `consider` | 🟡 Consider | Worth discussing |
| `optional` | 🔵 Optional | Minor preference |

---

### Report Template

See: `references/report_template.md`



---

### Rules

- Never post without explicit user confirmation
- Skip findings already in existing review threads
- Always include "What's Working Well"
- Omit empty severity sections
