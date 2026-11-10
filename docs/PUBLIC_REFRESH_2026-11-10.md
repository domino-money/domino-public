# Public source refresh — 10 November 2026

This refresh publishes the reviewed file changes from private `main` between
`8504ab6507ae6679830c3e8391e2f9dda6a4d6d9` and
`adae30373a36d9c3bb1f74a0b6165a311757bdc3`. It builds on public commit
`4afbc85a23a56a630dddd2d0ea9ead1f2aed97ac`, preserving the sanitized public
history and its six existing `sanitized/` tags. Private commit identifiers are
provenance references; their objects and ancestry are not imported.

## Included changes

The source range includes 24 merged pull requests: #462–467, #469, #472–488.
Open pull requests are outside this snapshot. The main additions are:

- Elysium, chain ID **99901**, with an enabled Uniswap v4-only profile, its
  recorded deployment, read APIs, token configuration and app flows.
- Elysium S2 cross-chain funding through **Relay and USDC only**, in both
  directions. Native HYPE transfers and Across are not enabled for Elysium.
- Points Season 1 accounting and snapshots, authenticated API transport, a
  Points page and signed referral links. Points are not money or tokens and
  carry no promise of future rewards.
- Session and rate-limit fixes, collector and ledger improvements, and app,
  navigation and search metadata updates.

The [README](../README.md) describes the current public snapshot. Dated rollout
notes describe the state at the time they were written: the Elysium deployment
record predates the later S2 activation. For current behavior, consult the
[enabled chain profile](../api-contracts/v2/chains/elysium-99901.json), its
`bridge.providers` field, app activation code and tests together.

## Publication controls

The import copies reviewed source files onto the public branch. It does not
merge private Git history, branches, tags, pull request discussions, Actions
logs or repository settings. Existing public license terms, font notices,
sanitization manifests and CI protections are preserved.

The review replaces the new protected Points gateway with a documentation
endpoint and removes private host identities, operational release logs and
local paths from the affected documentation. Matching examples and tests use
the same placeholder; gateway validation retains an exact allowlist. Operators
must provide real endpoints and credentials outside Git. Global IP fixtures
used to test egress validation are synthetic, offline test data. Three pre-existing
host-label references were also generalized in current files. This refresh does
not retroactively rewrite earlier public commits or tags.

The four Elysium deployment JSON artifacts are byte-for-byte identical to the
source snapshot. Public contract addresses, transaction hashes and unsigned
creation calldata are retained for inspection. The app-pinned SHA-256 of
`docs/deployments/v2-elysium-99901-2026-11-09/deployment.json` remains:

```text
d3d4f694d316f53d169cccbb4063a76ef19b2015cde2b3369fa9ce4a99e0c76d
```

There are no Solidity contract source changes in this refresh. Historical audit
claims retain their original scope; this publication is not a new external
audit, deployment or verification of current on-chain state.

## Validation

- Backend: 3,137 tests passed; 1,000 PostgreSQL/Anvil integration cases skipped
  because they require explicit opt-in and isolated services.
- App: 3,971 tests passed and 7 cases skipped under Node 24.22.2; typecheck,
  lint and production build passed. Six skipped cases concern superseded
  prelaunch behavior; one requires a forced Elysium test build.
- Bridge and shared API contracts: 1,645 tests passed.
- Sanitization-specific checks: 65 tests passed, plus the committed bridge
  configuration validator. No production validator was weakened.
- Public CI checks passed locally: 93 Node tests, 87 Python tests, shell syntax
  and Solidity hygiene. The public workflow retains its existing limited scope;
  see [PUBLIC_CI.md](PUBLIC_CI.md).
- The final source changes were scanned with Gitleaks using an explicit default
  configuration, archive/encoded-content inspection and no repository exclusions.
  Findings were reviewed as public addresses, checksums or synthetic test data;
  no operational credentials were confirmed. Repository hygiene passed.

Validation uses local fixtures and filtered environments without operational
credentials. Browser suites, database/EVM integrations and live RPC or production
service verification are outside this refresh validation. Private backups,
replacement maps, scan triage and detailed execution logs are retained separately.
