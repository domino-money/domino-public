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

## Proportionate review and owner fast path

The owner approved a fast path on 11 September 2026 after PR #64. Small, reversible changes made by the responsible area owner need that author's validation and current-head CI, **not a second manual review or approval**. OxDecimal owns frontend presentation; rugged97 owns backend, contracts and integration. Ownership is coordination, not a restriction on repository access.

- Examples: spacing, colours, typography, decorative backgrounds, static artwork and local copy adjustments that preserve product meaning and behavior. Judge the semantic change; re-indentation alone is not a reason for a full audit.
- The author briefly records what changed and the relevant check. Reuse passing CI and existing exact-head evidence. Do not repeat the full suite locally, create a browser-size matrix, add mirrored tests or delegate an independent review just to recheck a small owner change. Use a focused visual check only if the author has not already covered the changed state or there is a concrete unresolved regression.
- Keep a PR, passing required CI, an up-to-date base and resolved conversations. The responsible owner may merge an eligible PR without waiting for the other collaborator. If explicitly asked to assess it, check eligibility and existing evidence briefly; do not turn this into a second audit.
- Require independent review for money/amount/state semantics, wallet/session/access controls, signatures/approvals/swaps/deposits, API/schema contracts, database migrations or historical accounting, provider trust/qualification, dependencies/build/deployment/CI, security or this policy. These exclusions apply even inside a presentation file. Substantial or cross-area changes also use normal review.
- GitHub's native path rule implements a narrow UI-file exception; it cannot prove change size, semantics or author responsibility. Being in an exempt path is necessary for that automatic exception, not sufficient to claim eligibility. Unlisted files retain the normal review requirement until the file boundary is deliberately updated. Do not use admin bypass or move sensitive code into exempt paths.

See [review policy](docs/REVIEW_POLICY.md) for the exact path boundary and GitHub configuration.

## Subagent delegation

The project owner authorizes subagents to accelerate issue work. Delegate concrete, independent subtasks when parallel work materially helps, while the coordinating agent continues useful work. This permission does not start every open issue or connect separate collaborators' sessions automatically.

- Before starting, read the issue, recent comments, related PRs and the current branch state. Respect work already assigned or in progress; coordinate overlap before editing the same files or API contract.
- Give each subagent a bounded objective, relevant context, allowed files, read-only/edit scope and expected result. Keep exploratory research and independent review read-only unless edits are needed.
- Use one writer per file. Simultaneous implementation tasks should use separate branches/worktrees with explicit ownership; independent GitHub issues retain separate PRs. Do not switch a shared checkout while another agent is writing in it.
- The coordinating agent integrates results, checks source evidence, resolves conflicts and runs the relevant checks on the combined change. A subagent's claim that work passed is not a substitute for reviewing its evidence.
- Return concise handoffs: findings or changes, file/commit references, tests actually run, unresolved dependencies and the next action. Preserve durable decisions in reviewed repository documentation and the issue/PR when publication is authorized as part of the task.
- Internal subagent messages do not automatically reach the other collaborator's assistant. That assistant must read the shared issue/PR and updated repository. Do not claim a notification, background monitor or automatic handoff exists unless it was configured and verified.
- Delegation preserves existing credential, financial-operation, deployment and PR-review boundaries. It does not authorize self-approval or bypassing protected `main`.

## Verification

Run relevant checks: `npm run check:web`, `npm run test:contracts`, and/or the Python suite in README. Changes to ledger, reorg, migrations or EVM parity require the full PostgreSQL/EVM suite. Report what actually ran and any skipped checks. Keep backend/openapi-read.json aligned with validated API requests.

Keep GitHub Actions unprivileged and independent of real RPC keys/wallets. Never use pull_request_target to execute contributed code. Deployment and financial operations are outside ordinary test/PR workflows; follow the user's explicit scope.
