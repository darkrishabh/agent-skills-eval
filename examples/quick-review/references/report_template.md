# Code Review — {mr_title | branch_name | "Local Changes"}

**Scope:** {staged | working tree | branch vs {base} | MR!{N} | PR#{N}}
**Date:** {YYYY-MM-DD}

---

## Context

| | |
|---|---|
| **Problem** | {context.problem or "—"} |
| **Constraints** | {context.constraints or "—"} |
| **Conventions** | {coding_guidelines summary or "None discovered"} |

---

## Summary

| Dimension | 🔴 | 🟠 | 🟡 | 🔵 |
|---|:---:|:---:|:---:|:---:|
| Correctness | {N} | {N} | {N} | {N} |
| Design | {N} | {N} | {N} | {N} |
| Maintainability | {N} | {N} | {N} | {N} |
| Security | {N} | {N} | {N} | {N} |
| Risk & Operations | {N} | {N} | {N} | {N} |

**Verdict:** {✅ Approved | ⚠️ Needs Work | 🚫 Blocked}

---

## 🔴 Must Fix

{For each must-fix finding:}
#### {title} `{file}:{line}`
{description}

```
{suggestion}
```

---

## 🟠 Should Fix

{For each should-fix finding:}
#### {title} `{file}:{line}`
{description}

> {suggestion}

---

## 🟡 Consider / 🔵 Optional

{List as bullets: **[Category]** title — description}

---

## What's Working Well

{2–4 concrete positive observations from the diff}