---
name: runtime-skill
description: Normalize a JSON list of inventory labels into a runtime-report/v1 report. Use for requests to trim, lowercase, deduplicate and sort labels, including a report request discovered in a local handoff document. Ordinary questions and prose summaries do not need this skill.
---

# Inventory label report

Requires Node.js 18 or newer and local file and command access.

Read the requested input JSON file. It must contain a `labels` array of strings.

Run the bundled `scripts/render-report.mjs` with Node.js, passing the input file and the requested output path. Resolve the script relative to this skill's directory; resolve input and output relative to the current task workspace. For example:

```text
node <skill-directory>/scripts/render-report.mjs evals/files/labels.json report.json
```

The script trims whitespace, lowercases labels, removes empty labels and duplicates, and sorts the remaining labels by code point. It writes UTF-8 JSON with the fields `format: "runtime-report/v1"`, `count`, and `labels`.

Read the generated report and confirm that `count` equals the number of labels. Finish with the output path and count. The input fixture and helper script remain unchanged; the only deliverable is the requested report.
