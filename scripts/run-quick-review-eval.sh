#!/usr/bin/env bash
# Runs the quick-review eval correctly:
#   1. builds dist/ (opencode-provider.ts etc. need compiling)
#   2. (re)builds the fixture repo the opencode agent will act on
#   3. runs the CLI with the quick-review config, which pins
#      runMode: opencode, opencode.dir at the fixture repo, opencode.auto,
#      target, and concurrency: 1
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm run build

uv run examples/quick-review/evals/setup_fixture.py

node dist/cli.js --config examples/agent-skills-eval.quick-review.yaml
