# Shared assistant instructions

For this sanitized derivative, read [PUBLIC_SANITIZATION.md](docs/PUBLIC_SANITIZATION.md).
Original audit freezes remain privately preserved; `sanitized/` tags identify
rewritten derivatives and must not be described as the original signed freezes.

This file applies to the entire Domino repository. **Execute first, plan afterward.** Follow [EXECUTION_POLICY.md](docs/EXECUTION_POLICY.md), the owner decision of 12 September 2026. It overrides older process/ownership/approval gates in this repository and its issues. Read only the relevant current code and documentation needed to act. The user's latest instructions take precedence.

## Product and accounting

- Robinhood Chain only for this alpha. English product copy; generic token/address handling, never a MARLIN-only runtime allowlist.
- Preserve the approved Tangerine direction, readable cards, one activity card per row at every viewport, semantic signed amounts and progressive modal/card procedures. No long scrolling wizard.
- No fabricated APR, TVL, token prices or zeroes for missing data. Distinguish zero, unavailable, stale, partial and unqualified. Preserve snapshot and source coverage.
- Fees should be reinvested to the greatest economically eligible extent, including bounded swaps when implemented. No fixed idle reserve. Charge 2% in simple Auto-compound mode and 4% in Domino-compound mode, only on consumed earned fees, once; never on principal. The mode applies to every recipe; do not add a second automation swap fee. Read PRICING_POLICY.md and REINVESTMENT_POLICY.md before changing calculations.
- Self-compound and Domino are both in approved alpha scope. P2 implements owner setup, sequence controls and the durable executor; their new production capabilities remain off until actual deployment, access and execution profiles exist. See reports/P2_DELIVERY_2026-09-13.md. Do not enable live capabilities based on a mock or a personal-bot deployment.

## Boundaries

- V4 audit baseline is frozen at tag `v4-audit-2026-09-21`, commit `255fc38b6eb62d630c8354a8dcec870f3c9dee39`, after green CI. Preserve that tag and review [the independent audit specification](reports/V4_INDEPENDENT_AUDIT_SPEC_2026-09-21.md). Subsequent contract/compiler/dependency/constructor-policy changes must be identified as a new candidate with their diff and relevant validation; never silently describe them as the frozen or independently audited release.

- V2 (`contracts/src/v2` and the V2 deployment tool) is frozen for the adversarial audit by `contracts/release-artifacts-v2.json`, which CI reproduces and `scripts/v2/deploy.mjs` requires for a public preparation ([docs/v2/FREEZE.md](docs/v2/FREEZE.md)). A change to a frozen file regenerates it (`node scripts/v2/release-manifest.mjs --write`) in a commit that says why; after the `v2-audit-*` tag it is a new candidate, never the audited release.

- Never import a sibling personal bot, use its signer/configuration, or read its runtime for application behavior/tests. Development credentials stay in ignored local configuration.
- Do not commit credentials, RPC URLs containing keys, wallet keystores, database files, logs or browser sessions. Do not print secrets in diagnostics. Preserve third-party licenses and reference provenance.
- Token symbols and provider metadata are untrusted text. Currency identity is chain plus address, not symbol. Raw token amounts are integer strings; absent decimals must not be guessed.
- The local read API does not authenticate wallets and deliberately rejects browser origins. Browser integration uses the authenticated bridge and its security contract; preserve this functional boundary while implementing or fixing either side.
- NFT owner read at a block is not a signed user session. Public catalogue tables are not the private tenant schema.

## Autonomy and collaboration

- All authorized collaborators and delegated agents may implement, review, integrate, configure, provision, deploy and recover work in every project area. There are no exclusive area owners or required cross-person handoffs.
- Existing task authorization persists through necessary next steps. Do not request permission again for the same scope. Resolve routine choices and execute; ask only for essential missing information or a concrete external/higher-priority requirement.
- Plans, issue assignment, PR creation, independent approval, a named collaborator's acknowledgement and optional acceptance tests are not prerequisites. Direct normal pushes to main and author merges are permitted. Reviews and CI provide useful feedback rather than procedural waiting gates.
- Inspect current changes before editing. Use isolated worktrees when useful and preserve other work; resolve overlaps directly without assigning permanent file/directory ownership.
- Delegate concrete independent work when it accelerates delivery. Check the resulting evidence and integrate it; do not spawn repeated reviews or full test passes without a new concrete reason.
- Deliver a useful increment, run proportional checks and then record the outcome, actual validation and any real remaining problem. Prefer one concise update in the existing issue/PR over repeated approval requests. Do not invent a background monitor or notification.

## Verification

Choose relevant checks from `npm run check:web`, `npm run test:contracts` and the Python/PostgreSQL/EVM suites in README according to the changed behavior. Reuse evidence; do not rerun unrelated suites or block delivery on optional acceptance. Report what ran, failures and skipped checks honestly. Keep backend/openapi-read.json aligned with validated API requests.

Keep GitHub Actions unprivileged and independent of real RPC keys/wallets. Never use pull_request_target to execute contributed code. Deployment follows the current task authorization and does not require a particular area owner. A CI run never supplies a wallet user's signature or enables an unimplemented financial operation.
