# Public MVP security specification

Process update, 12 September 2026: [EXECUTION_POLICY.md](docs/EXECUTION_POLICY.md) supersedes mandatory collaborator/owner review and external-audit approval queues. Any authorized collaborator may implement and operate within the task scope. The wallet consent, cryptographic authorization, isolation and accounting requirements below remain technical behavior, not area ownership.

**Draft requirements · 9 September 2026 · Robinhood Chain / Uniswap v4**

This specifies a new public deployment. It is not a claim that the current personal bot satisfies public-service requirements. The existing [internal review](../AUDITORIA_DOMINO_V2.md) provides reusable evidence, not independent certification.

The first invited functional alpha includes Auto-compound and opt-in Domino under [ALPHA_SCOPE.md](ALPHA_SCOPE.md). Domino and its admitted swap paths must satisfy their applicable evidence gates before that alpha is considered complete; a read-only prototype does not satisfy them. Initial compatibility is assessed per verified pool and operation, with hookless pools as the initial admission proposal.

## 1. Assets, authority, and trust

| Actor or component | Allowed authority | Forbidden authority |
|---|---|---|
| Owner wallet | Create/import position, grant individual authority, configure policy, pause, revoke, withdraw | Affect another owner or sequence |
| Operator | Submit a narrow set of fee-only actions inside the owner's policy; pay gas | Pull wallet balances, withdraw principal, choose arbitrary recipients, execute arbitrary calldata |
| Vault | Account for one owner's sequence and enforce its approved rules | Share collateral, fee budgets, or approvals across customers |
| Public API | Read public state; serve quotes and authenticated preferences | Sign operator transactions or treat a client request as financial authority |
| Planner | Propose typed intents from canonical observations | Bypass independent policy checks or on-chain limits |
| Signing service | Rebuild and approve tightly constrained operator transactions | Expose a raw signing endpoint to the API or accept unvalidated hashes |
| Administrator/guardian | Admit reviewed configurations, maintain service, pause bounded automation | Confiscate assets, force principal moves, block direct owner escape, silently increase agreed fees |
| Treasury | Receive the agreed protocol cut, fund gas, manage its own balances | Sweep customer reserves or classify donations as earned fees |

Calling the model user-controlled does not by itself settle legal custody or service classification. Verify actual powers in contracts, keys, recovery mechanisms, and operational control.

## 2. Contract invariants — release blocking

**C01 — principal preservation.** Operator actions cannot reduce existing position liquidity, transfer owner NFTs, or consume owner-wallet tokens. A new initial deposit is separately authorized by the owner. Changes caused by market trading inside Uniswap are not withdrawals by the operator.

**C02 — customer isolation.** A sequence has an immutable owner identity and validated pool/currency identities. Assets, accrued fees, reserves, checkpoints, limits, and NFT membership cannot be borrowed from another sequence. An address supplied by the client never establishes ownership.

**C03 — fee provenance and conservation.** Budgets arise from measured earned fees and explicitly tracked fee reserves. Direct token donations and arbitrary wallet transfers do not become compoundable fee revenue. For a no-swap path, reconcile per currency: prior reserve + realized fees = net liquidity additions + protocol cut + remaining reserve, accounting explicitly for rounding and any owner withdrawal outside the automation action. Swap paths must add exact swap-in and swap-out legs and their costs to this identity; USD valuation cannot establish token conservation or spending authority.

**C04 — charge once.** For the 2% simple / 4% Domino mode policy, charge only the consumed gross fee amount. Untouched reserves stay uncharged. Partial additions, conversions and retries cannot produce double charging. A revert rolls back the service cut. The automation cut never applies to appreciation, deposited principal or direct withdrawal of untouched reserves. A conversion does not create a second chargeable fee lot. An internal automated swap cannot receive an additional assisted-swap service charge. Owner-requested setup swaps have a separate, explicitly authorized fee boundary below.

**C05 — equivalent execution paths.** The self-compound and general paths enforce the same permissions and produce equivalent financial outcomes for the same inputs, within specified rounding. Preserve internal netting without confusing token transfers with gross realized fees. Benchmark the new cut's gas overhead before claiming savings.

Use integer token base units and explicit decimal/tick conventions for financial authorization and accounting. Round conservatively at each contract boundary; UI floating-point estimates must never become signed spending limits without exact-unit reconstruction and validation.

**C06 — constrained interaction.** Allow only verified pool managers, position managers, currencies, hooks if specifically admitted, and fixed operation selectors. No arbitrary external-call facility or caller-selected payout address. Exact transient allowances must be consumed or cleared. Protect callbacks and token transfers against reentrancy and nonstandard behavior.

**C07 — policy freshness.** Bind intents to chain ID, vault address/version, sequence state, owner policy version, action identity, and deadlines. Owner changes invalidate outstanding proposals. Enforce frequency, sequence length, exact fee-token spending budgets, price movement, and fee-rate caps on-chain where relevant; off-chain limits alone are not financial boundaries. The public design has no fixed 15% addition cap: all spending remains bounded by proven fee balances and the signed plan. Existing personal-contract caps remain unchanged.

**C08 — owner independence.** Owners can pause and withdraw tracked reserves and child positions without the public API, operator, or administrator. Revocation stops future authority on the root. Clearly document which NFTs reside in the wallet and which reside in the vault. Pausing automation must not pause owner exits.

**C09 — version and initialization safety.** No personal root ID, previous deployment, or migration balance in the public constructor. Factory-created instances must be initialized atomically to the intended owner and policy. Prefer immutable versioned instances initially; a migration requires explicit owner action. Measure runtime size with the exact reproducible compiler settings.

**C10 — revenue authority.** Enforce a hard protocol-fee cap and the owner's agreed rate/version. Increasing an active owner's rate requires new consent; routing and fee recipients cannot be silently changed to enlarge operator powers. Treasury collection cannot sweep balances belonging to customers.

**C11 — fee-balancing swap boundary.** The intended public MVP must compare direct reinvestment, bounded swaps and waiting under the [reinvestment policy](REINVESTMENT_POLICY.md). Require an owner-benefit margin after costs in addition to operator gas coverage. Enforce admitted routes/currencies, exact input budgets, minimum outputs, price-impact and slippage bounds, deadlines, and fixed recipients. No external wallet funding or principal consumption. Validate token-level conservation, residual allowances, failed swaps and stale-quote behavior before activation. The current prototype and draft interface do not implement this path.

## 3. Price integrity and admitted markets

The current personal design values the volatile token from the same pool. That is a material gap for a public service interacting with adversarial tokens and markets; multiple RPCs returning the same manipulated pool state do not fix it.

Uniswap v4 has no built-in oracle equivalent to v3's price observations. Do not specify “use the pool TWAP” without identifying and reviewing a real source on Robinhood Chain. [Uniswap oracle documentation](https://developers.uniswap.org/docs/protocols/v3/concepts/price-oracles)

For each admitted pair, document depth and concentration, token controls, source of valuation, source freshness, sequencer status handling, and resistance assumptions. Time-series observations from our own indexer help detect sudden movements but are not automatically a manipulation-resistant oracle.

At minimum, bind execution to a recent reviewed state, set strict quote-to-execution price bounds and minimum outputs, and stop on stale, inconsistent, or unavailable information. Public Domino, swaps, and USD-based permission limits require an explicitly reviewed price-integrity design. If adequate pricing cannot be established for a meme pair, withhold those features or the pair; do not weaken slippage bounds to force execution.

Token review includes proxy/upgrader authority, transfer restrictions and taxes, supply changes, pause/blacklist powers, decimals, actual transfer behavior, and relevant hook behavior. Detect material changes and stop new operator actions pending review. Listing is neither a return forecast nor a guarantee against token or stablecoin failure.

Wallet discovery and contract-address search are open to candidates outside a starter list under [ONBOARDING_AND_POOL_DISCOVERY.md](ONBOARDING_AND_POOL_DISCOVERY.md). Execute only operations qualified by versioned integration rules, current contract checks and simulations; unknown behavior needs review. Creating a hookless pool cannot make an unsupported token compatible. Separate discovery, setup, swap, Auto-compound, Domino and suggestion capabilities.

Pool suggestions cannot bypass execution checks. Negligible volume, incomplete history, unreliable valuation or insufficient executable depth exclude a suggestion regardless of APR. Version inputs and reasons; invalidate them on stale data or reorgs. Pool APR is a historical analytics statistic, not an oracle or spending authorization. Do not use the singleton PoolManager's token balance as an individual pool's TVL.

## 4. Transactions, chain reads, and recovery

1. Create a durable, uniquely identified intent before signing or broadcasting. Record the decision inputs, source block hash, policy version, signer, nonce, costs reserved, and expected financial effects.
2. Serialize nonce allocation per operator across all workers. Database leases must have fencing and recovery; a lease alone does not make sending exactly once.
3. Reconcile ambiguous sends by deterministic transaction hash and canonical chain state. Never use a fresh nonce merely because an RPC timed out. Replacement transactions must remain linked to the original intent and respect spend limits.
4. Store observations with block numbers and hashes, detect reorgs, roll back provisional events, and re-plan only after reconciliation. Display submitted, included, sufficiently confirmed, and settled states distinctly; an L2 confirmation count is not Ethereum finality.
5. Read a coherent block snapshot and compare independent providers for suspicious state or failures. Do not combine fee data from one block with permissions from another and label the result atomic.
6. Preserve valid measurement history across isolated read failures. Require sufficient fresh data before execution; after prolonged gaps, reuse only observations whose meaning remains valid and rebuild the necessary recent window.
7. Include failed transactions, replacements, and outstanding reservations in operator gas budgets. Retain history across worker restarts and software upgrades. Alert before gas exhaustion and stop new sends while an unresolved nonce blocks the signer.

## 5. Signer and application controls

- Separate public API, planner, and signer credentials and deployments. The API cannot reach a general-purpose sign endpoint. KMS access is limited to the signing service role; a KMS key is not itself a transaction-policy engine.
- The signer decodes typed proposals and independently verifies registered vaults, selectors, policy versions, recipients, token movements, deadlines, gas caps, and economic limits. Rebuild the transaction rather than signing a caller-provided digest blindly.
- Hold bounded operator gas per cohort, separate from protocol treasury and customer assets. Define key rotation, on-chain revocation, compromised-key response, and recovery authority before launch.
- Authenticate owner settings with single-use signed challenges binding domain/origin, chain, nonce, and expiry. Verify wallet signatures correctly, including contract-wallet signatures only if supported and tested. Reauthenticate when account or network changes. [Sign-In with Ethereum](https://eips.ethereum.org/EIPS/eip-4361)
- Authorize every private record, quote mutation, and action by verified owner and sequence. Use server-side checks and database isolation; hiding buttons is not access control. Test cross-user object references, replay, CSRF, and rate-limit evasion.
- Apply strict content security policy, dependency and build integrity checks, signed/verifiable release manifests, input/output escaping, and separate admin access. Do not turn arbitrary token metadata into trusted HTML or links.
- Minimize stored personal data. Do not log seed phrases, key material, session credentials, raw signed transactions, or unrestricted payloads to public observability. Public-chain data can still reveal sensitive user behavior when linked to account metadata.

## 6. Initial deposit and exit behavior

The creation flow must survive every partial state: declined approval, approved token but canceled swap, swap confirmed but mint canceled, NFT minted but automation approval declined, and delayed or replaced transaction. Derive progress from receipts and ownership, not browser memory. Show residual allowances and how to revoke them.

Keep automatic mint recipients bound to the owner or their verified vault. Review screens display chain, asset contract identities, exact allowances, minimum outputs, fee rate, principal amount, and current quote age. A materially changed quote requires renewed owner review; silently widening bounds is forbidden.

An initial balancing swap may consume only the owner-selected deposit budget. Keep it distinct from fee-only operator plans and from earned-fee lots: the mode’s automation cut does not apply to initial capital, its conversion or unused deposit dust. Recompute range-dependent mint amounts after the swap and retain recoverable owner control if mint or activation is declined. Bind quotes to chain/account, full pool identity, budget, tick-rounded range, recipient and expiry; invalidate on account/network/pool changes. No default unlimited wallet approval or automatic use of unselected quote-asset balances.

The separately proposed assisted-swap fee in [PRICING_POLICY.md](PRICING_POLICY.md) must have its own explicit rate cap, policy version, consumed-input base and fixed recipient in the owner-reviewed transaction. It cannot charge directly deposited tokens or returned unconsumed budget. Quote DEX output after this fee, with no repeat charge on intermediate hops. Reverts roll back the service charge; a successful separate swap followed by a canceled mint retains its real receipt and must not repeat the swap or charge upon resumption. The current fee-split library does not implement this collection path. Changes to future setup pricing cannot alter existing automation consent.

Native ETH requires exact msg.value accounting, fixed refund destinations, no unrelated-balance sweep and an owner gas budget outside the deposit amount. Verify any WETH address and explicit wrap/unwrap path independently; it is not the same PoolKey currency as native ETH.

Advanced new-pool creation is approved alpha scope. Its owner review includes initial price, quote orientation, full PoolKey and first-deposit composition. Initialize and add first liquidity in one bounded transaction; check actual pool state if a competing initialization wins. Enforce price and token bounds so an unexpected price cannot silently determine the first mint. Do not fabricate prior volume, TVL or APR, assume an empty pool supplies its own balancing route, or infer automation eligibility from a successful initialization.

Provide a small static recovery interface and verified-contract instructions independent of the main API. It must let an owner inspect authority and prepare pause/withdraw/revoke actions. Explain that withdrawing liquidity returns its current token mix; converting it to one asset is a separate user choice and trade.

## 7. Failure response

| Trigger | Automatic response | Operator response |
|---|---|---|
| RPC outage or stale source | Stop new affected sends, keep historical observations, show freshness | Fail over, reconcile before resuming |
| Price/depth anomaly or token change | Suspend affected pair's new automation | Review sources and limits; preserve owner exits |
| Unknown transaction or nonce divergence | Hold the signer queue | Reconcile original intent/hash; do not reset history |
| Low gas or exhausted subsidy | Wait with an explicit economic reason | Refill within treasury policy or reduce service load |
| Suspected signer compromise | Revoke/pause operator authority by prepared procedure | Rotate key, preserve evidence, identify affected intents, inform affected users |
| Contract vulnerability | Halt applicable automation through documented controls | Assess exposure, publish specific status, support direct exits; do not promise reversibility |

Maintain a responsible-disclosure channel, contact coverage for incidents, severity definitions, and a public status page. Routine waits should not create incident fatigue; security or accounting discrepancies should page the operator.

## 8. Evidence required for each release

| Evidence | Required scenarios |
|---|---|
| Contract unit, fuzz, invariant tests | C01–C11; multiple owners and children; partial fees; donations; malicious callbacks; dust; maximum/minimum ticks |
| Mainnet-state forks | Actual managers/tokens; allowances/ownership; both strategies; owner swaps, native ETH/refunds, competing initialization and bounded first mint; setup and exit |
| Economic and gas benchmarks | Protocol cut included; L1 data and L2 execution cost; small reserves; repeated failed attempts; lower fee accrual |
| Recovery tests | Crash before/after sign and send; duplicate jobs; RPC disagreement; reorg; replacement; backup restore |
| Application security review | Cross-tenant access; signatures/replay; frontend transaction substitution; admin and signer isolation |
| Owner recovery drill | Frontend/API/indexer unavailable; owner can stop and recover positions/reserves using the alternate path |
| Optional independent audit | If commissioned: exact source, compiler, deployment pattern, configuration and retested remediation; report only the actual scope |
| Limited mainnet reconciliation | Every receipt and reserve matches the ledger; real gas limits and alerts operate |

Address actual critical/high findings promptly through correction, isolation or rollback; record remaining impact and disposition. Publish the deployed version, known limitations and verified addresses. If an audit was performed, publish its actual scope and changes since review. An external audit is not a procedural prerequisite under the current owner policy and does not replace runtime monitoring or guarantee absence of defects.

Do not reuse personal test counts as proof that public fee collection, multi-user isolation, or remote signing has been verified. Each new authority and money flow needs its own evidence.
