#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || process.argv.length !== 4) {
  throw new Error("Usage: node render-report.mjs <input.json> <output.json>");
}
if (path.resolve(inputPath) === path.resolve(outputPath)) {
  throw new Error("Input and output paths must differ");
}
const input = JSON.parse(readFileSync(inputPath, "utf8"));
if (!Array.isArray(input?.labels) || input.labels.some(label => typeof label !== "string")) {
  throw new Error("Input must contain a labels array of strings");
}
const labels = [...new Set(input.labels.map(label => label.trim().toLowerCase()).filter(Boolean))].sort();
const report = { format: "runtime-report/v1", count: labels.length, labels };
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}: ${report.count} labels`);
