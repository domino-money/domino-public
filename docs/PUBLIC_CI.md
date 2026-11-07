# Public repository CI

The sanitized public derivative runs `Public CI` on pushes to `main`, pull
requests (including forks), and manual dispatches. Its single job uses a
GitHub-hosted Ubuntu runner, the repository's Node and Python version files,
commit-pinned setup actions, and a read-only `GITHUB_TOKEN`. Checkout does not
persist that token. No repository secrets, deployment environments, private
runners, cloud credentials, wallet keys, or live RPC endpoints are supplied.

The checks cover tracked-file hygiene, CI routing and credential boundaries,
synthetic runner-broker tests, Solidity source hygiene, and release/tunnel
configuration using synthetic responses. They do not install application
dependencies or invoke deployment commands. Runtime setup actions may download
Node or Python; the test workloads use local fixtures.

This is a limited public verification suite. Passing it does not reproduce the
full application, browser, database, EVM, or frozen release-artifact suites,
and is not an independent security audit. The existing local commands in
`README.md` remain available for those suites.

The six original workflow files remain as historical and operational source.
Every original job additionally requires both `github.repository ==
'domino-money/domino'` and `github.event.repository.private == true` before
runner allocation. Its previous event, branch, dependency, and deployment
conditions remain in place. Consequently those jobs are skipped in this public
derivative and its forks. The original broker allowlist is unchanged and does
not authorize the public workflow. No private runner group or organization
secrets should be assigned to the public repository.

The public workflow uses `pull_request`, never `pull_request_target`. Keep fork
contribution checks on hosted runners and review workflow changes before adding
credentials, broader token permissions, or deployment capabilities. Changes to
these boundaries are checked by `scripts/ci/public-workflow.test.mjs` and the
existing private runner/deployment policy tests.
