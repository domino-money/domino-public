# Frontend integration checkpoint — 12 September 2026

Source checkpoint: main `4592e67` (merged #112), recovered consumer commit
`79abefb` for #124. This is an integration map, not evidence of a deployment
or a complete audit of every repository file. GitHub/VM states below were
observed during this pass and must be rechecked before activation.

| User-facing feature | Existing implementation | Remaining connection |
| --- | --- | --- |
| Selected pool TVL and 24h volume | `MarketsTable`, shared read source, `token` and `pool-market` | #123: Rugged is diagnosing stale provider observations on the VM. Preserve attribution and age. |
| NFT position lookup by ID | #112 merged: `ChainPositionsSection`, `positions.ts`, `nft-positions` and token metadata | #126: VM route qualification, then matching Worker scope after readiness confirmation. Ownership at a block is public data, not a session. |
| Token candidates, pool catalogue and ranges | #112: `TokenPicker`, `WalletCandidates`, `PoolPicker`, `ChainSelectionPanel` | #126 for routes; a customer entry point and selection handoff are still needed. #124 does not mount this selection into a live funding flow. |
| Pool provenance and activity | #112: figure dialog/notes and activity projection | Qualify `pool-activity` through #126; preserve coverage and freshness. |
| Onboarding quote/position previews | #124: `LivePreview`, `onboarding/client`, session port | Test-build surface with synthetic initial inputs. Real selection, session/onboarding staging and activation remain separate. |
| Deposit operation states and receipts | #124: `Deposits`, deposit consumer and fixture scenarios | Fixture-only; real transport, wallet handoff and release gates remain separate. |
| Public APR estimate | Backend candidate #127 with opt-in read-v2 | Review exact contract/manifests and consumer semantics before adapting the table. An estimate must not be labelled a position return. |
| Price chart identity | Backend candidate #128 | Review token-address identity and fixtures before adding a chart consumer. |
| Private financial history / automated execution | Separate #97/#114/#117/#120/#125 work | Backend dependencies and reviewed public execution remain outside this read-only pass. |

## Delivery environments

The app release scripts record the built artifact and require preview deployment
before promotion of that artifact to production. PR #121 proposes CI publication
of the gated preview on merges to main; it was still open when checked here.

Current `app/wrangler.toml` binds the four bridge services only in production.
`app/functions/_lib/bridge.ts` accepts only the canonical application origin.
Consequently the current preview can validate presentation and unavailable-data
states, but cannot validate a real backend interaction. A read-only staging
entrance needs an explicit reviewed ingress design; adding production bindings
to arbitrary branch previews is not an integration shortcut.

Rugged confirmed the VM order on #45: diagnose/fix #123, then qualify the five
routes in #126, publishing evidence and the capacity budget. The Worker scope
must follow that readiness confirmation. Session/onboarding/deposit activation
is not included in that read-only extension.

## Provider decision

The backend already uses Uniswap's liquidity API for pool state. That adapter
does not by itself replace GeckoTerminal's reported USD TVL, 24h volume and
price history. Resolve the observed availability problem, then qualify any
analytics replacement for Robinhood coverage, source identity and freshness.
Provider changes belong in the backend contract and its fixtures before the
frontend labels or calculations change. API credentials stay server-side.
