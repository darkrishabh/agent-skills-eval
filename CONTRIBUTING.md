# Contributing

Thanks for improving `agent-skills-eval`.

## Development

```sh
npm ci
npm test
```

Useful commands:

```sh
npm run build
npm run typecheck
npm pack --dry-run
```

## Pull Requests

Before opening a PR:

- Keep changes focused.
- Add or update tests for evaluator behavior, config parsing, CLI behavior, or artifact output.
- Run `npm test`.
- Include docs updates when public behavior changes.

## CodeQL setup for maintainers

The main ruleset requires CodeQL and the Node 18/20/22 CI checks. GitHub's
[default CodeQL setup](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types)
does not scan pull requests from forks. The advanced workflow in
`.github/workflows/codeql.yml` supports ordinary `pull_request` events, including
forks, without checking untrusted code out in a `pull_request_target` job.

Default setup stays active until the advanced workflow is merged. After it has
landed on main, a maintainer can perform the one-time transition:

1. Switch CodeQL from default to advanced setup in repository settings. Keep the
   CodeQL rule in the main ruleset enabled throughout the transition.
2. Enable the **CodeQL advanced** workflow if GitHub disabled it while default
   setup was active, and set repository variable `CODEQL_ADVANCED_ENABLED` to
   `true`.
3. Run **CodeQL advanced** on main with `workflow_dispatch` and verify both
   language scans finish and upload their results.
4. Update or reopen older pull requests to trigger their scans before merging.
   Maintainers may need to approve workflows from first-time fork contributors.

If the initial main scan fails, restore default setup while fixing the workflow;
do not remove the required scan or use a bypass to merge. Until the transition
is complete, a skipped **CodeQL advanced** job is not security-scan evidence.

## Release Process

Releases are published from GitHub releases through `.github/workflows/publish.yml`.

Maintainers should:

1. Update `CHANGELOG.md`.
2. Bump `package.json`.
3. Push to `main`.
4. Create a GitHub release tag.
5. Ensure `NPM_TOKEN` is configured in repository secrets.
