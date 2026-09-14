# Inventory handoff

Operations needs a machine-readable label report from `evals/files/labels.json`.
Use Node.js to trim and lowercase the labels, discard empty labels, remove duplicates,
and sort them by code point. Write only `report.json` in the task workspace.
The JSON must contain exactly `format: "runtime-report/v1"`, `count`, and `labels`.
`count` is the number of normalized labels. Leave the input unchanged.
