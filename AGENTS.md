# Shared assistant instructions

This file applies to the entire Domino repository. Read README.md and CONTRIBUTING.md first, then the relevant module README. The user's instructions take precedence; these rules organize implementation and do not create additional approval requirements.

## Product and accounting

- Robinhood Chain only for this alpha. English product copy; generic token/address handling, never a MARLIN-only runtime allowlist.
- Preserve the approved Tangerine direction, readable cards, one activity card per row at every viewport, semantic signed amounts and progressive modal/card procedures. No long scrolling wizard.
- No fabricated APR, TVL, token prices or zeroes for missing data. Distinguish zero, unavailable, stale, partial and unqualified. Preserve snapshot and source coverage.
- Fees should be reinvested to the greatest economically eligible extent, including bounded swaps when implemented. No fixed idle reserve. Charge the 2% earned-fee service cut only on consumed fees, once; never on principal. Read PRICING_POLICY.md and REINVESTMENT_POLICY.md before changing calculations.
- Self-compound and Domino are both in approved alpha scope, but the current UI is practice-only and the public execution contract is not implemented. Do not enable live capabilities based on a mock or a personal-bot deployment.

## Boundaries

- Never import a sibling personal bot, use its signer/configuration, or read its runtime for application behavior/tests. Development credentials stay in ignored local configuration.
- Do not commit credentials, RPC URLs containing keys, wallet keystores, database files, logs or browser sessions. Do not print secrets in diagnostics. Preserve third-party licenses and reference provenance.
- Token symbols and provider metadata are untrusted text. Currency identity is chain plus address, not symbol. Raw token amounts are integer strings; absent decimals must not be guessed.
- The local read API does not authenticate wallets and deliberately rejects browser origins. Browser integration needs a separately reviewed bridge and security contract; do not bypass this boundary to make a frontend demo work.
- NFT owner read at a block is not a signed user session. Public catalogue tables are not the private tenant schema.

## Collaboration and verification

Both collaborators may work in every directory. Coordinate overlapping files and API contracts in the issue/PR; there are no folder access restrictions. Use one branch per task (`codex/<issue>-<topic>` for assistant-created branches), small reviewable PRs and the relevant acceptance criteria. Do not silently change another task's API contract or deployment configuration.

Run relevant checks: `npm run check:web`, `npm run test:contracts`, and/or the Python suite in README. Changes to ledger, reorg, migrations or EVM parity require the full PostgreSQL/EVM suite. Report what actually ran and any skipped checks. Keep backend/openapi-read.json aligned with validated API requests.

Keep GitHub Actions unprivileged and independent of real RPC keys/wallets. Never use pull_request_target to execute contributed code. Deployment and financial operations are outside ordinary test/PR workflows; follow the user's explicit scope.
