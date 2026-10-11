# Wallet, fees and receipt consistency

## Scope

Use only the existing Domino endpoints backed by Rugged. No new RPC, public RPC fallback, additional service, infrastructure configuration change, contract change or VM access. Publication is app-only, using the recorded build for preview and production.

## Findings and corrections

- The position list hid actual collectible token amounts when their USD estimate was unavailable. It now shows those amounts, matching the position detail. A missing USD price does not mean missing fees. Qualified USD continues to take precedence when present.
- Wallet discovery can return a successful but incomplete list. An omitted token is not evidence of a zero balance. Wallet refresh must reconcile known holdings and explicit balance reads without silently converting older balances or expired prices into current totals.
- A quiet refresh may retain one atomic last-complete valuation with an explicit updating label. It never combines partial new balances with an old total. Original balance/price expiry, a changed balance, a confirmed action or a terminal incomplete read removes that snapshot. Current zero balances still remove holdings immediately.
- Indexed finality and a locally remembered inclusion are distinct. A validated finality update must be allowed to advance the matching local receipt instead of leaving it indefinitely in Confirming. Unfinalized, stale or conflicting evidence must not manufacture confirmation.
- Base and Arbitrum automation finality previously changed only the setup component's step label and stopped following it when the view closed. The existing bounded receipt follower now publishes the exact transaction's finality into shared proof state, pausing on a different chain/account and rejecting conflicting blocks. Robinhood retains its existing Rugged confirmation reader.
- A reviewed approval with a known submitted hash can resume that exact transaction after a review refresh. The UI shows waiting/checking states instead of a silent already-sent dead end. An uncertain send without a hash triggers only a new read/review; it never automatically sends the approval again.
- Verified setup events appear immediately in Receipts and the position's Activity while the public index catches up. They retain included/finalized status and show no invented block timestamp. The matching indexed setup replaces the temporary row without duplication.
- Pending creations keep the Open tab available even when all older indexed positions are closed.

## Existing network scope

Deployed creation profiles cover Robinhood Chain (4663), Base (8453) and Arbitrum One (42161). Ethereum (1) and OP Mainnet (10) are additional funding origins, not deployed position-creation destinations. Both availability and route/token support remain subject to existing capability checks; a funding network does not imply a deployed position manager/automation profile there.

## Financial data that still cannot be supplied by this app-only change

The connected multichain infrastructure is real. Read-v6 publishes portfolio, activity, chain-pools, chain-balances and chain-tokens. Its current positions include raw principal, collectible balances, current pool price and block references. It does not expose historical NFT accounting or price candles for Base and Arbitrum.

Robinhood's Fees/Your APR uses `/api/fees/v1/state` and `/api/fees/v2/ledger`, with its chain-specific RPC/manager. Simply sending Base NFT #6238157 to that transport would read the wrong network. Turning on the unrelated disabled performance-v2 service would not fix it.

`backend/v2_rpc.py` already has historical RPC support, and automation uses historical price reads. Those capabilities have no corresponding exposed multichain accounting/history route in the current bridge contract. No VM was accessed to add one. The frontend must retain genuine measured observations and unavailable APR until a supported accounting response exists. Even a position created through Domino can later have direct external collections not covered by Domino activity. In v3, tokens owed can also contain principal from liquidity reductions; neither all collections nor changes in owed balances can safely be called earned fees.

The BASECAT producer does not currently qualify its USD price under the existing executable-liquidity policy. DEX Screener's reported market liquidity is a different measure. The app preserves token amounts; it does not weaken the depth threshold, substitute an unqualified price, or equate estimated pool APR with personal APR.

## Validation

Tests use local fixtures, never user signatures or financial transactions. The complete unit file set ran 3,301 tests: one view-shape expectation needed the new inventory-availability field; its full 293-test file passed after that correction. The Windows test server leaves handles open, so this complete run used Node's `--test-force-exit` after all tests finished. Focused additions cover wallet omission/zero/price expiry, all-chain finality, safe approval recovery and immediate activity scoping/pagination.

The final automation integration passed 14/14 browser cases and 27/27 recovery/finality unit cases. Session activity passed 8/8 unit cases; the combined list/detail/Wallet browser run passed 46/46. CI on the first candidate passed all jobs except six Wallet browser regressions. Those failures led to the labelled atomic-total refresh correction and corrected fixture timestamps. The full affected bridge screen file passed 24/24, the additional terminal-incomplete/pending-price regression passed 1/1, Wallet refresh passed 3/3 again and Wallet units passed 81/81. Final CI and release results are recorded with the delivery PR.

The corrected head passed all 90 tests of the complete read browser suite. Visual checks at 1280 and 360 px place the updating label below the Wallet value without overflow. A later CI pages failure reported home overflow at 320 px; the exact test passed 10/10 locally and 100 alternating resizes passed with CPU throttled 4x. Its original assertion is retained with element diagnostics and a CI failure screenshot; no speculative layout workaround was added. CI reruns this condition before delivery.

Explicit runtime imports remove 298 bytes gzip of unused namespace exports. The final legacy test build's all-lazy total is 387,774 bytes after Wallet reconciliation and the atomic snapshot; its ceiling moves by the minimum 1 kB (0.26%), with no change to initial-entry, financial or V2 ceilings and no new dependency. Typecheck, lint, production build and all seven bundle checks pass. Production and V2 retain their existing margins.
