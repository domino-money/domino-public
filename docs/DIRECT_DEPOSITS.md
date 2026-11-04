# Resumable owner-signed direct deposits — issues #40, #42 and #44

[Execution policy](EXECUTION_POLICY.md) supersedes historical owner, ACK and
approval procedures here. Any authorized collaborator or agent may implement
and operate within scope, recording results alongside or after execution.
Technical controls, compatibility evidence and wallet consent still apply.

`deposit-v1` 1.1.0-rc.4 is a disabled backend/worker candidate for creating a position
in an **existing**, admitted Robinhood Uniswap v4 pool. It follows the session
and preview candidates in #39. Uniswap still calculates composition; Domino
validates the exact wallet step, stores its identity and reconciles its result.
The backend never signs or broadcasts a financial transaction.

Issue #42 qualifies deployment/RPC assumptions and corrects the candidate's
Nitro fee projection. This is an explicit coordinated **pre-release migration**
from `1.1.0-rc.2` to `1.1.0-rc.3` of the disabled candidate. Producer, worker, schemas, validators, types and fixtures
must move together and pass producer/consumer compatibility checks.
See the migration section below.

Issue #44 adds [reviewed immutable/proxy token support](REVIEWED_TOKEN_ADMISSION.md)
and a further coordinated pre-release admission/receipt migration from rc.3
to rc.4. Older headers are rejected. See the
[current evidence and remaining gates](../reports/UPGRADEABLE_ADMISSION_IMPLEMENTATION.md).

The P1 combined producer uses session-v1 3.0.0-rc.4, with stable CSRF and a
read-only browser GET `/me`. Fresh private checks remain required before and
after provider work and before payload delivery. A revoked, logged-out or
expired session invalidates the old cookie with `session_required`, including an
in-flight preparation. If a nonce was already persisted, denial keeps that
evidence; a fresh login for the same owner recovers the same effect. Per-wallet
admission is gone with the whitelist (issue #182). Migrations001–014 are
applied together in order, and 027 detaches 011's session-insert gate. This composition preserves the rc.2 recovery and session guarantees and adds
Nitro receipt fields from rc.3. This candidate adds token admission as rc.4,
requiring its own compatibility evidence and contract notice alongside or after delivery.

## Browser contract and lifecycle

All eight `/api/deposit/v1/{route}` routes use same-origin POST JSON, the existing
HttpOnly SIWE cookie and current `X-Domino-CSRF`. The optional request version
header must equal `X-Domino-Deposit-Contract: 1.1.0-rc.4`; it is always on responses.
No bearer, owner, recipient, provider URL, calldata or signature is accepted in
a browser request. Owner identity comes from the checked session.

| Route | Exact request | Result |
| --- | --- | --- |
| `create` | `idempotencyKey`, `selection` | Immutable operation; repeat with the same key/selection returns it |
| `get` | `intentId` | Durable operation and compact step/receipt history |
| `allowances` | `intentId` | The operation plus fresh pinned ERC20/Permit2 allowance observations and wallet revoke guidance; no wallet payload |
| `list` | Optional `limit` (1–20, default 20), `before` UUID (default null) | Compact summaries, `hasMore`, `nextBefore` |
| `prepare` | `intentId`, current `version` | Persisted exact next wallet step, or a fixed error |
| `report` | `intentId`, `version`, `transactionHash` | Store the hash hint, then independently reconcile |
| `reconcile` | `intentId`, `version` | Refresh chain evidence or advance a bounded recovery scan |
| `cancel` | `intentId`, `version` | Cancel an unissued draft or request cancellation of outstanding work |

Selection fields are `chainId:4663`, `poolId`, `poolKey`, `independentToken`,
`amountRaw`, `tickLower`, `tickUpper`, `slippageBps`, `budget0Raw`, `budget1Raw`,
`nativeGasReserveRaw`, `maxGasLimitRaw`, `maxFeePerGasRaw`,
`maxPriorityFeePerGasRaw`. Every field is required. PoolKey preserves
`currency0`, `currency1`, `fee_pips`, `tick_spacing`, `hooks`. Addresses/PoolId are
canonical lowercase. Amounts/gas/nonce quantities are integer strings; selectors
are strict safe integers. Both token budgets are explicit uint128 strings;
selected EVM gas is 21,000–3,000,000 units with a positive max fee and priority
fee at most that max. `slippageBps` is 10–500 basis points (0.1% to 5%), both
ends included: the person's own choice from New position or Setup, and the
tolerance the mint's amount caps are prepared with. No USD price or tariff is
inferred from these values.

Single-operation success returns `contractVersion`, `operation`, nullable
`walletStep`, `serverBroadcastAvailable:false`, `automationAvailable:false`.
`walletStep` is populated only by `prepare`. Public history omits previous
calldata; the private store retains it for effect matching. `serviceFeeBps:0`
means no Domino percentage on direct initial principal, not zero network gas.
Unknown receipt amounts/cost components remain null.

The shared [package](../api-contracts/deposit-v1/README.md) supplies the complete
nested schemas, TypeScript types, validator, narrow ABI checks and fixtures.
Frontend integration must validate the connected chain/account, immutable
selection, current version, exact step and expiration before asking the wallet
to sign. Convert raw strings to bigint/hex without Number conversion. Do not
silently replace the nonce, gas cap, target, recipient or calldata. A login
signature is not transaction authority.

## One issued transaction at a time

The preparer independently validates the provider's mint identity and both
maximum debits. It reads a fresh canonical snapshot, code/deployment links,
pool identity, balances and allowances. The next step is one of:

1. Reset an insufficient nonzero ERC20 allowance to zero when necessary.
2. Approve the exact needed ERC20 amount to canonical Permit2.
3. Approve the exact Permit2 amount to canonical PositionManager.
4. Mint the selected position and route any native refund to the owner.

Only the selected step is simulated and estimated. On Robinhood's Nitro stack,
`eth_estimateGas` bundles execution and data-posting gas. The transaction uses a
20% buffer above that bundled estimate within the owner's selected gas cap,
plus the selected fee ceilings. Native headroom covers the planned native
deposit, selected reserve and `gasLimitRaw × maxFeePerGasRaw` for this step.
Do not add a second L1/poster estimate to that bundled bound. An estimate and
buffer do not guarantee inclusion or a future fee; fee-cap or gas-limit
failures remain explicit. Native ETH and WETH are distinct identities. No
wrapped-token substitution occurs. The [RPC qualification](../reports/DEPOSIT_RPC_QUALIFICATION.md)
records the live estimate shapes and pinned Nitro source basis; ordinary local
EVM estimates do not establish Robinhood's bundled costs.

The wallet handoff is valid for at most 30 seconds. The mint's on-chain deadline
is 120 seconds. Permit2 approvals last at most one hour, allowing separate
submissions and finalized receipts without renewing after each clock tick;
expired approvals are reread. ERC20 allowances have no inherent expiration.
All amounts are bounded, with no unlimited approval. A late finality result can
still require a new bounded Permit2 approval. None of these timings promises
network inclusion or finality.

An atomic store write binds the exact transaction and nonce before any wallet
payload leaves the service. One outstanding issuance per owner spans all its
operations. Concurrent requests use optimistic versions; only one wins. A
repeated prepare can return the same payload while still fresh. It cannot
change nonce/effect or extend expiration. Failed sessions, CSRF rotation, logout
or expiration during work prevent delivery; an already persisted issuance stays
reserved if delivery becomes uncertain.

## Recovery, cancellation and receipts

`draft`, `awaiting_wallet`, `pending`, `confirmed`, `reverted`,
`cancel_requested`, `cancelled`, `superseded` and `attention` are distinct durable states.
A reported hash is only a hint. Up to eight original/replacement hints survive
restart. A mined result remains pending until a canonical RPC `finalized` head
covers it. That is explicit RPC evidence, not an independent consensus proof.
Finalized successful approvals allow the next preparation; a successful mint is
terminal and cannot be repeated by this operation.

The reconciler checks sender, chain, nonce, target, calldata, value and the actual
transaction envelope, then canonical receipt/log identity. A same-effect wallet
replacement above the selected gas/fee limits can still confirm or revert. Its
receipt includes `transaction` with observed raw gas/fee fields and the exact
`selectedLimitsExceeded` list. Prepared artifacts still enforce every selected
cap; this observation neither authorizes the override nor prepares a new step. It proves the mint through
PositionManager's NFT Transfer, PoolManager's matching liquidity change and
NFT pool/range/owner reads. Current ownership is a separate observation with its
block; it can change after the original mint. Reorgs invalidate observations and
retain evidence rather than rearming a mint automatically.

When no hash arrived, a bounded scan searches the owner's issued nonce from its
source block. Each call scans at most 16 blocks/1,024 transactions, with partial
block checkpoints and a hard 2,048-transactions-per-block admission limit. Dense
or long gaps may need repeated explicit reconciliation calls; no lifetime
indexer or background retry loop starts. Unsupported finality, uncertain state
and provider failures remain explicit instead of inventing confirmation.

Cancelling before issuance needs no chain action. Cancelling after handoff does
not prove the transaction was never signed/sent and cannot revoke its signature.
The owner can complete or cancel/replace it in the wallet. A finalized, verified
zero-value self-transfer on the same nonce can resolve requested cancellation.
A different-effect replacement remains `attention` until its owner/nonce transaction
and receipt are canonical, the RPC finalized head covers it, and the owner's
nonce is independently consumed at that finalized block. After handoff expiry,
that evidence permits terminal `superseded`. It means the original nonce/effect
cannot execute on the observed finalized chain; it never claims cancellation or
mint success. Expiry alone never releases an issued ERC20 approval. Unsupported same-call envelopes and unknown/provisional transactions remain held. No cancellation or
replacement transaction is sent by the backend.

Reconciliation of a later reorg moves a superseded/finalized row back to
`attention`, preserves initial finalized evidence and blocks new issuance. It
retains a newer outstanding reservation if one already exists. A later verified
matching result or finalized superseding effect can resolve the old attention
row. Nothing automatically reissues a previous mint or edits an old artifact.
RPC finality is a stated assumption, not proof that future reorgs are impossible.

A reported owner transaction with identical destination/calldata/value at another
nonce records a sticky `reportedEffectConflicts` entry and remains `attention`
(or `cancel_requested`). Finalized consumption of the issued nonce cannot prove
that this second effect is absent. Missing later RPC results do not clear recorded
conflicts. Hash identity is checkpointed before subsequent RPC reads. An unknown
reported hash whose identity was never saved also prevents terminal release when
its lookup is missing, including after authentication/deadline/DB interruption.
A previously verified same-nonce hash may disappear after a speed-up without
blocking a separately verified replacement. Canonical block scans can identify
reported hashes omitted by the provider's hash index. No unknown hint is dropped
to make room for a previous receipt, and no missing field is treated as an explicit
null. No automatic adoption, retry or conflict-clear procedure is provided;
an audited chain-resolution procedure is required before this case can release.

## Residual allowances and revocation

Call the private `allowances` route after approval, partial completion, mint,
cancellation or supersession. It reads both selected ERC20 currencies (native
ETH omitted), at one fresh canonical block with a final recheck. The result
separates token `allowance(owner, Permit2)` from Permit2's
`allowance(owner, token, PositionManager)`. Raw zero is distinct from a failed
read (`unavailable` and null). An expired Permit2 amount remains visible with
its expiration; it does not erase the ERC20 allowance, which has no time expiry.
These are reported contract-state observations, not a new token-admission proof
or a guarantee the allowance will remain unchanged after the snapshot.

`revocationGuidance:wallet_erc20_approve_zero_and_permit2_approve_zero` means:
use the owner's wallet on chain4663 to review `token.approve(Permit2,0)` and,
separately, `Permit2.approve(token,PositionManager,0,0)` for the returned exact
currency/spender addresses. Zeroing the token's Permit2 allowance can affect
other applications using that same Permit2 permission. Each action requires an
explicit wallet transaction; this route prepares none, signs none and asserts
no successful revoke. Refresh the pinned read after the wallet reports a
confirmed revoke. Never compute current exposure by subtracting mint amounts
from a historical Approval event, or treat cancel/superseded as revoked.

Receipt fee fields use the qualified Nitro gross model. Quantities are decimal
integer strings; fee amounts are wei and gas usage is measured in gas units:

| Field | Meaning |
| --- | --- |
| `gasUsedRaw` | Receipt gas usage, including charged poster gas and after ordinary EVM gas refunds |
| `effectiveGasPriceRaw` | Receipt effective price per gas unit |
| `grossGasFeeRaw` | `gasUsedRaw × effectiveGasPriceRaw`, before any separate ArbOS resource refund |
| `l1GasUsedRaw` | Nullable observed `gasUsedForL1`, in child-chain gas units; bounded by `gasUsedRaw` |
| `l1FeeRaw` | Nullable `l1GasUsedRaw × effectiveGasPriceRaw`; the charged poster component already included in `grossGasFeeRaw` |
| `totalFeeRaw` | Always null in this candidate: exact net fees/refunds are not qualified |

An explicit `gasUsedForL1: 0` produces known-zero L1 fields; an absent operand
leaves both L1 fields null. An unrelated provider extension named `l1Fee` is not
accepted as the source of `l1FeeRaw`. Never add `l1FeeRaw` to `grossGasFeeRaw` or
present their difference as exact net execution cost. A missing resource-usage
extension does not prove zero additional refund. Gross gas fee is not the
complete net wallet charge. See the [source and receipt analysis](../reports/DEPOSIT_RPC_QUALIFICATION.md#pinned-nitro-receipt-semantics).

Standard admitted ERC20 deposits use matching transfer events. Native net
deposit/refund cannot be established from whole-block balances and stays
unavailable without an admitted tracing source. Actual mint liquidity and NFT
identity remain separately verifiable. Original principal is never relabeled
as earned fees, and no automation service fee is collected by this flow.

## Error handling and bounds

Errors are closed `{error:code}` responses with the package's fixed status map.
Use 401/403 session/CSRF handling from the session contract; a CSRF refresh is not
an instruction to request another financial signature. Version/idempotency/owner
busy conflicts are 409. Funding/gas balance, low fee cap and excessive gas limit
are distinct 422 codes. Wallet-pending/state-changed are 409. Preserve inputs and
refresh evidence before retrying; a changed immutable budget needs a new draft
after the previous issuance is resolved. Do not force the user to increase caps.

Body/response limits are 8 KiB/256 KiB. Upload is 5 seconds; shared worker total is 25
seconds and private listener total 20 seconds, including auth and database work.
The listener admits eight actual workers; up to four more requests wait at most
2.5 seconds for one, never past their deadline. It retains capacity when HTTP
times out while underlying work finishes. Read-only deposit RPC is a
separate allowlist (160 calls/20 seconds, no broadcast methods); receipt scans
have a 15-second nested deadline. This first configuration uses the selected
primary RPC without automatic failover or retries.

SIWE's durable keyed IP/account/global preview budgets are shared with this
service (the `onboarding` kind of ONBOARDING_API.md): 120/30/1000 attempts per 60
seconds. Failures after admission retain reserved attempts; a budget's refusal
reserves none. These are development limits, not an SLA. A 429's `Retry-After` is
1 to 60 whole seconds: 2 to 5 for `deposit_capacity_busy` and the session's
capacity codes, the seconds until the window admits again for
`session_rate_limited`, 60 for the owner caps below, which no wait clears. The
Worker relays the listener's value since 3 Nov 2026; before, every 429 said 60.
The private schema separates active admission from retained audit history.
It permits 16 active and 128 retained operations per owner, 10,000 active and
50,000 retained globally; existing over-limit histories from an upgrade remain
readable but deny new admission. At most16 steps, 96KiB artifacts and 8KiB outcomes
bound each record. `deposit_owner_capacity_busy` and `deposit_owner_history_full`
are distinct429 reasons. Finalized terminal and superseded transitions release
active capacity atomically while retaining evidence. Reorgs are always recorded,
even if reopening attention exceeds the new-work admission cap. Expiry of an
issued artifact, a cancel request or a failed provider read releases nothing.

Never-issued drafts/cancelled rows are retained at least7days from creation.
Migration014 makes new creation reclaim at most32 eligible rows across all owners
under the capacity lock, including owners who never return. One eligible caller
slot (prefer an active draft) and one global active-draft slot are reserved; the
remaining slots advance oldest-first. This permits admission at both global caps
without starving cancelled rows. No handed-off history qualifies. Idempotent retries remain stable during that
retention window. Use a new UUID for a new decision, not an old request key.
Create/cancel churn remains limited by the owner's retained-history quota. Pagination is
stable by creation time/ID, and owner-bound anchors cannot read another owner.

## Audited retention and capacity recovery

The service role still cannot DELETE operation history. Before retained capacity
is exhausted, an operator may run `backend/deposit_archive.py --directory
<private-backed-up-directory> --operator-role <authorized-db-role>`. The tool
uses this checkout's explicit database settings and an operator role with SELECT
and DELETE plus explicit private-schema visibility under RLS; never grant
maintenance rights to the application role.

Provision the archive directory before running the tool: it must already exist,
be owned by the operator and have mode0700. Persist that directory and every
newly created ancestor entry as part of provisioning (including fsync of their
parent directories), and include them in the backup policy. The tool never
creates missing directories: fsync of a newly created leaf alone cannot preserve
its entry in its parent after a crash. Missing or non-private directories fail
before opening a database connection.

Each invocation handles at most 16 terminal rows older than 90 days since their
last update, never draft/attention/outstanding/unknown work. It holds the same
transaction advisory lock, serializes the complete original selection/artifacts/
receipts/reorg evidence, writes a mode0600 SHA256-named JSON file, reads back
identical bytes, and fsyncs the verified file and its private directory before deleting those
specific database rows. A failed write rolls back deletion; a crash/uncertain
commit can leave a duplicate archive. Verify the returned digest and database
state before retrying. Preserve archives with the database's backup policy.
Files contain private owner history and must never enter Git or public hosting.

Archival is explicit long-term capacity recovery, not reconciliation. It releases
retained slots only after durable evidence exists. The operator must retain the
archive digest/path and provide owner-history lookup/recovery from it. Archived
operation IDs no longer serve the online API; online idempotent replay is
guaranteed only during retention. Never replay an archived artifact or imply
that archival revokes a token allowance; the archive retains exact currencies/
spenders needed for wallet review. Recent or ambiguous work cannot be archived
to force new admission. A restored backup may duplicate an exported row; retain
both until their identity/digest agrees.

## Deployment configuration, admission and rollback

Migration `009_direct_deposits.sql` introduces private `domino_deposits` state and
the constrained `domino_deposit_service` role. Forced owner RLS and immutable
selection/idempotency triggers are exercised through real PostgreSQL and
dump/restore tests. Public read/write and session-auth roles cannot access it.
The role does not hold login bearers; only the authenticated service supplies
its owner context. Production migrations and restore drills remain deployment
work, not an automatic consequence of applying the task-local test migration.

Apply009/010/014 as the same trusted DDL role owning `domino_deposits.intents` and
its maintenance functions. This role can be NOSUPERUSER/NOBYPASSRLS:010 gives it
explicit SELECT and DELETE policies under FORCE RLS for global counter repair,
quota counting and globally bounded expiry. A maintenance UPDATE policy gives
existing rows visibility for `SELECT FOR UPDATE` locks but rejects every updated
row image with `WITH CHECK (false)`. The application retains only its
owner policy and has no direct DELETE grant. It must never be that maintenance
role or a member of it. Migrations010/014 fail closed for mismatched ownership or
application membership; set the correct migration role instead of granting the
application broader access. The DDL owner remains trusted to manage private
evidence, and its privileges are not runtime application credentials.

`backend/deposit_api.py` defaults to disabled on numeric loopback port 8881 and
reads no credentials/DB/admission files while disabled. A separate singleton
lock is below `backend/runtime/deposits`; existing bot/read/session/preview ports
are excluded. Eventual enablement uses `--enable --rpc-config <private-file>
--uniswap-config <private-file> --admission-file <private-file>` with the same
session database, `DOMINO_SESSION_ABUSE_SECRET` and `DOMINO_SESSION_ORIGIN`.
Separate `DOMINO_DEPOSIT_ACCESS_ISSUER`, `DOMINO_DEPOSIT_ACCESS_AUDIENCE` and
`DOMINO_DEPOSIT_ACCESS_SERVICE_ID` verify the deposit Access identity before work.

Admission is empty by default. A bounded, locally reviewed manifest binds its
SHA-256 ID, policy, review references/validity, fixed deployment code hashes and
up to 32 active reviewed token profiles. Legacy `direct_existing_pool_v1` requires
standard-transfer, nonrebasing, nonupgradeable tokens. The new
`direct_existing_pool_v2` also supports explicitly reviewed transparent/UUPS
profiles with implementation, authority and operative checks, plus up to 32
historical reviews for receipts. Native support is explicit. Reads/discovery remain generic, but
readability or a successful simulation never qualifies a token for signing.
Manifest claims require actual review; the file validator does not perform it.
The loader requires an owned private regular file, no symlink/hardlink, 32 KiB max.
Supported v1 approvals and mint transfer amounts are qualified against the exact
issued manifest's reviewed token hashes at the receipt block and its parent.
Successful finalized approvals release the owner reservation and return to draft
(or finish cancellation); unknown/changed reviews retain the existing recovery
guards. See [legacy receipt handling](REVIEWED_TOKEN_ADMISSION.md#receipts-and-history)
for review retention and manifest-replacement limits.

The [deployment and token review](../reports/DEPOSIT_DEPLOYMENT_REVIEW.md)
confirmed the canonical deployments and existing WETH/USDG and ETH/USDG pool
identities, but found **both WETH and USDG are upgradeable proxies**. They cannot
meet the legacy `nonUpgradeable` requirement. A constant proxy code hash does not
pin its implementation or mutable delegates. Issue #44 supplies separate
[source-backed profiles and guards](REVIEWED_TOKEN_ADMISSION.md); it does not
relabel these assets immutable or enable them publicly. MARLIN/BAG/ZZZ remain
unqualified: the bounded review did not obtain sufficient source/semantics
evidence. No production manifest was populated by that review.

The [local-fork qualification](../reports/DEPOSIT_FORK_QUALIFICATION.md) separates
protocol characterization from production eligibility. An explicitly controlled,
in-memory test admission override can exercise deployed mint/approval mechanics
behind the local-only fork transport, with a missing-manifest negative control.
It exports no admission manifest and grants no production eligibility. Success
under those test assumptions cannot qualify proxy immutability or Nitro net gas
costs. Deployment/source, RPC/finality and token-admission evidence must all be
assessed separately.

The [reviewed-profile fork runs](../reports/UPGRADEABLE_ADMISSION_IMPLEMENTATION.md)
then exercise the same qualification paths with v2 admission and no test override.
Historical #42 evidence remains unchanged. Issuer controls, transient same-block
upgrades, USDG payout-group restrictions and public activation gates remain
explicit in the new review.

The example Worker config has no deploying route and keeps
`DEPOSIT_BRIDGE_ENABLED=false`, workers.dev and preview URLs disabled. Proposed
`vm-deposit.domino.money` is the selected but unprovisioned origin; its Access identity, service token and Tunnel mapping are deferred until the deposit gates pass. Eventual secrets are
`DEPOSIT_ACCESS_CLIENT_ID`/`DEPOSIT_ACCESS_CLIENT_SECRET`, with `APP_ORIGIN` and
`DEPOSIT_GATEWAY_ORIGIN`. Do not reuse read/login Access identities.

For activation, validate the exact contract/digest, actual frontend hooks and
wallet behavior, admitted Robinhood contracts/tokens, execution safety and
HTTPS/Cloudflare staging. Record the evidence alongside or after delivery;
no named consumer or peer approval is required for the authorized work.
Credentials for domino.money remain deferred. Synthetic EVM fixtures and
controlled local-fork execution do not establish production admission.

## Issue #42 candidate migration

The receipt projection changes are breaking within the development candidate:
`executionFeeRaw` is removed in favor of `grossGasFeeRaw`; `l1GasUsedRaw` is
introduced; `l1FeeRaw` now requires the observed Nitro poster-gas operand and is
an included component; `totalFeeRaw` is restricted to null. The route/header
version changes from `1.1.0-rc.2` to `1.1.0-rc.3`; the previous candidate
header is rejected. Pin the version and exact package manifest together.

Update the producer, BFF, exported schemas/types/runtime validators and fixtures
as one candidate, regenerate the package manifest, and communicate the exact
commit/digest and field changes under [API compatibility](API_COMPATIBILITY.md).
Any authorized collaborator may integrate the corrected contract and validate
affected receipt rendering, then record the results without waiting for an ACK.
Read/session/onboarding contracts and frontend hooks are unchanged by this
backend migration. Future changes to a released contract follow the normal
version/overlap policy including explicit new version identifiers.

Existing private receipt evidence is preserved. Summary projection recomputes
gross gas from stored raw usage and price; old `executionFeeRaw`, standalone L1
values and additive totals are not reinterpreted as qualified costs. Records
without the new observed poster-gas operand return null L1 fields, and all
summaries retain null net totals. The migration does not rewrite historical
receipts, clear issued nonces or require reissuing a wallet transaction. The
historical issue #41 implementation report remains a record of that earlier
candidate; the issue #42 qualification reports describe the correction.

Rollback disables the worker/listener and restores matching API builds while
preserving operation/nonce/receipt evidence. Disabling a service does not cancel
a wallet transaction or revoke allowances. Never drop the private schema to
clear a stuck operation. Assisted swaps, tariff selection, new-pool initialization,
vault automation and public activation are separate deliverables.
