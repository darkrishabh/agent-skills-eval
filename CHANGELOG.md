# Changelog

All notable changes to this project are documented here.

## Unreleased

- Add an experimental native-runtime lifecycle with isolated task copies, pre-verification snapshots, and separate verifier workspaces. Native adapters and CLI integration remain pending.

- Identify outgoing OpenAI-compatible requests with the installed package and Node versions.
- Compare nested tool arguments without treating object-key order as significant.
- Give baseline runs the same evaluation fixtures as skill-enabled runs.
- Upgrade js-yaml to the patched 4.3.2 line while retaining YAML merge-key behavior.
- Document configuration options, artifact fields, and MCP/identity integration boundaries.

- Add eval ID filtering through `--eval-id`, `evalIds` config, and the SDK.

## 0.1.1

- Improve npm package discoverability metadata.
- Add repository, homepage, bugs, funding, and expanded package keywords to the publish payload.
- Align package metadata with the GitHub repository and documentation site.

## 0.1.0

Initial public release.

- SDK for loading and evaluating agentskills.io-style skills.
- CLI with OpenAI-compatible model provider support.
- YAML and JSON config support.
- Pretty, JSONL, and silent logging modes.
- Static HTML reports.
- Baseline comparison with `with_skill` and `without_skill` modes.
- Official `iteration-N` artifact layout.
- Tool-call assertions and custom provider interface.
