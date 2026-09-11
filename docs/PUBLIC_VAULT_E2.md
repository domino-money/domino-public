# Public vault and factory — E2 custody candidate

11 September 2026 · [#86](https://github.com/domino-money/domino/issues/86) · implementation version 1

E2 implements owner-bound initialization, NFT custody, authority transitions and direct recovery in [DominoVault](../contracts/src/DominoVault.sol) and [DominoVaultFactory](../contracts/src/DominoVaultFactory.sol). It uses the reviewed [E1 identities](execution-v1.md) and existing PolicyValidation. This is a locally tested custody implementation, **not an activated public executor**: there is no compound, liquidity modification, mint, router, external credit, signing or upgrade method. It does not implement the draft `compoundSelf` interface or pretend the draft's withdrawal signature is this ABI.

## Atomic owner-bound creation

The factory is created for chain 4663 with immutable PoolManager, PositionManager, StateView and fee-recipient addresses. Managers must have code; PositionManager and StateView must report the same PoolManager. The implementation records the three runtime code hashes. Those checks do not qualify deployed manager versions, proxy dependencies, tokens or financial operations; admission remains separate.

Each caller creates only its own vault. The factory derives `sequenceId = keccak256(abi.encode(keccak256("DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)"), chainId, factory, caller, ownerNonce))`. The sequence ID is the CREATE2 salt for an exact EIP-1167 clone with a fixed implementation target. `predictVault(owner, nonce)` allows an individual root-NFT approval to the predicted address before creation. No global NFT or token approval is requested or granted.

`createVault(params, expectedOwnerNonce)` deploys and initializes in one transaction, guarded against reentry. The owner is `msg.sender`, never a supplied owner field. The registry and owner nonce are updated only after initialization succeeds. Failure rolls back the clone, subscription, nonce and registry together; the owner may retry the same prediction. Another caller has a different owner/salt domain and cannot take that address. Owner nonce exhaustion never wraps.

The implementation itself is initialization-locked. A clone can be initialized once, only by its immutable factory. There is no later owner change, admin implementation change, arbitrary migration or delegatecall endpoint. An E4/E7 implementation will be a separately reviewed version; E2 is not intended to receive production funds ahead of that work.

## Registration, ownership and source identity

Initialization checks the root's current holder, **individual** vault approval, complete PoolKey/hash, packed PoolId prefix, signed aligned ticks, native/ERC20 ordering and core liquidity consistency. Supported identity shape is hookless fixed-fee v4. Pool fee and token discovery do not establish asset admission. Root ID zero is rejected.

The sequence binds owner, vault/factory/implementation/version, managers, full PoolKey/PoolId, immutable base/quote orientation and immutable service-fee recipient with the exact E1 encoding. The initial owner's policy and limits are explicit, without deployment defaults. PoolKey/PositionIdentity/FeeSourceIdentity ABI types and word order remain aligned with E1.

The root NFT stays in the owner's wallet. `adoptChild(tokenId, parentId, true)` is an **owner-initiated** transfer of an already-owned NFT into the vault; it cannot pull another holder's NFT or be called by the operator. It verifies the same full pool, an active parent, capacity, individual approval and absence of a foreign subscriber. Registration happens after the expected safe-transfer callback and actual holder check. This is not an automatic Domino mint or a principal-to-fees conversion. E6 supplies actual fee-funded minting later.

Every initial registration requires explicit consent to the NFT's currently uncollected fees. The on-chain checkpoint records core liquidity, last/current fee-growth values and block number. Its commitment plus NFT/range/generation forms the permanent position/source identity. Registration **credits zero fees**. Last/current growth measurements and callback deltas alone are not proven earned income: donations and ownership/baseline changes must be handled by E4's measured collection and E5's ledger.

Source records remain after a child leaves the vault. A previously registered NFT cannot be adopted again into this same sequence in E2; the historical record is not overwritten. Root rearm preserves its initial registration/source IDs while recording a fresh checkpoint and incrementing authority generation. A collector must treat that rearm checkpoint as a new opening/consent observation, not automatically classify its uncollected baseline as newly earned performance. A new root holder needs a separately owned sequence. Root transfer never conveys the original owner's already-tracked vault balances or child NFTs.

## Root continuity and callbacks

The vault subscribes to the root after clone deployment, when receiver code exists. Initial registration and `rearmRoot(true)` check current owner/individual approval and full NFT identity, open a narrow subscription context, refresh the checkpoint and verify the subscription after return. A foreign subscriber causes rejection; its removal is an explicit owner action, not an automatic takeover by Domino.

`notifySubscribe` accepts only the pinned manager, expected root and open context with the exact sequence/generation data. Arbitrary direct subscriptions cannot rearm the vault. Every authority validation independently checks current holder, individual approval, `rootArmed` and `subscriber(root) == vault`, plus deployment pins. It does not rely on delivery of an unsubscribe callback.

Official v4-periphery [transferFrom](https://github.com/Uniswap/v4-periphery/blob/dce236d4e2057422d0791d9a973a58765eb46f65/src/PositionManager.sol#L549) clears the subscriber even if its [limited-gas unsubscribe notification](https://github.com/Uniswap/v4-periphery/blob/dce236d4e2057422d0791d9a973a58765eb46f65/src/base/Notifier.sol#L67) fails. Away-and-back transfers, including self-transfer, therefore require explicit owner rearm. The tests suppress the callback and still prove that authority remains unavailable.

External modify/burn/unsubscribe callbacks invalidate an armed root and advance state/generation once; repeats while disarmed do not create additional authority transitions. Callback amounts are ignored for fee credit. Expected subscribe/unsubscribe callbacks during rearm use an explicit context; unexpected reentry into state-changing entrypoints is rejected. Callback selectors/ABI match the pinned [ISubscriber interface](https://github.com/Uniswap/v4-periphery/blob/dce236d4e2057422d0791d9a973a58765eb46f65/src/interfaces/ISubscriber.sol). This is upstream-source verification and synthetic EVM evidence, not Robinhood deployed-bytecode qualification.

An ERC721 `approve(0)` followed by `approve(vault)` without transfer can restore the same current approval while keeping the subscription. Upstream exposes no per-NFT counter for that history. **Durable stopping requires vault pause/revocation**; do not describe temporary external approval changes as permanently revoking the operator. A root burn or unavailable root blocks automation but cannot block recovery of assets already in the vault.

## Authority, policy and exhaustion

| Operation | Caller and effect |
| --- | --- |
| `setPolicy` | Owner only; existing PolicyValidation guards, consecutive policy version, preserved pause state and actual membership cap. |
| `setExecutionLimits` | Owner only; consecutive limits version, explicit bounded upside/slippage/impact/gas/age/horizon. Orientation remains immutable. |
| `setOperator` / `revokeOperator` | Owner only; rotate/revoke a single narrow operator and advance authority generation/state. No recipient, withdrawal, resume or policy power is granted. |
| `pause` | Owner or current operator; stops authority without blocking exits. |
| `resume` / `rearmRoot` | Owner only; require valid root conditions and nonterminal counters. Rearm does not silently change pause state. |
| `validateAuthority` | Read-only check for owner/current operator, policy version, vault state nonce, authority generation, pause and root permission. Passing it is not financial eligibility; E2 exposes no financial action. |

Initialization starts state nonce and authority generation at 1. A successful normal policy, limits, operator, membership, pause/resume or recovery operation advances state nonce once. A revert preserves it. Operator changes and root rearm/invalidation also advance authority generation. These are distinct from factory owner nonce, database fences and signer transaction nonces.

Exhaustion of either uint64 state nonce or authority generation is terminal for new authority, resume/rearm and adoption. No wrap/reuse occurs. Pause, revocation and owner exits still work, emitting `TerminalRecovery` alongside their specific receipt. State nonce advances if it has room; a saturated counter remains saturated. An owner recovery transaction is identified by its transaction/receipt-local log ordinal, not by assuming an exhausted nonce is unique. This is the explicit E1-required recovery exception to the old synthetic policy harness, which remains a historical boundary test.

## Fee balances, donations and owner recovery

Balances are keyed by immutable original source and current currency, retaining separate original/charged uint128 amounts. `accountedCurrency` aggregates backed liabilities. The protected credit sinks check membership/source/currency, overflow and actual backing. **They do not prove provenance** and no external E2 method exposes them. E4 must record measured fee-only realization atomically; E7 must prove conversion debit/output before crediting charged proceeds. Tests expose sinks only in `VaultE2TestHarness` to exercise actual asset-backed withdrawals. Do not deploy that harness or call its synthetic events financial collection evidence.

| Recovery method | Bound effect |
| --- | --- |
| `withdrawFeeReserves(sourceId, currency, originalAmount, chargedAmount)` | Owner only; known historical source, registered currency and sufficient amounts. Reduces those exact classes and pays the immutable owner without a service cut. All-zero requests are rejected. |
| `withdrawChildPosition(tokenId)` | Owner only; transfers an active child NFT to the immutable owner, updates active count and retains historical source balances. Cannot substitute the root. |
| `recoverUntrackedCurrency(currency, amount)` | Owner only; recovers surplus above accounted liabilities, for the registered pair or native ETH. It cannot touch fee balances or reclassify donations as fees. Native ETH remains recoverable even for ERC20/ERC20 pairs. Unrelated ERC20s are outside this candidate's recovery allowlist. |
| `recoverUnmanagedPosition(tokenId)` | Owner only, pinned PositionManager only; recovers NFTs sent with unsafe `transferFrom`, including withdrawn/unregistered NFTs and an accidentally transferred root. Active children must use the normal exit. Root rescue desarms it, advances state once/generation and requires fresh approval/rearm; source history is preserved. |

Safe-transfer callbacks accept only a pending owner-authorized child adoption. Unsolicited safe transfers revert. Unsafe transfers can bypass that receiver, which is why the separate fixed-manager recovery exists. No caller can choose a payout address. Treasury/operator have no recovery authority. Ordinary native donations remain untracked; token donations cannot increase withdrawable fee reserves.

ERC20 withdrawals require a successful optional-return transfer and exact vault debit/owner credit. False returns, reverts, transfer taxes and mismatched amounts revert accounting and transfer together. Native receiver/NFT receiver failure also rolls back the complete operation. Reentry from tokens or owner receivers cannot spend another source or NFT. Unsupported token behavior can prevent its own transfer; qualification and issuer controls remain release dependencies.

## Direct recovery without the public service

Recovery requires the owner's wallet and a working chain connection, not Domino's frontend, API, indexer, operator, oracle or administrator. Read `owner`, `position`, `source`, `feeBalance`, `policy`, `stateNonce` and `authorityGeneration` directly from the verified vault address/ABI. Confirm the address through the factory's `isVault`/`vaultForSequence` registry and its immutable implementation/version, then use the verified contract's write interface or a wallet capable of sending the typed owner call.

To stop new authority, send `pause()` or `revokeOperator()` from that immutable owner. Recover each active child with `withdrawChildPosition`; recover each original/charged balance using the exact `sourceId`, current currency and raw units from its getter. A withdrawn child's historical source remains valid. Root NFT already in the wallet is controlled directly in Uniswap; an accidentally transferred root uses `recoverUnmanagedPosition` and stays disarmed afterward. No operator signature or second approval is necessary for the owner withdrawal itself. Receiver rejection must be fixed by the owner wallet; it is not bypassed by redirecting funds to an arbitrary address.

There is no deployed E2 address to use today. A real recovery drill, deployed-manager/token qualification, verified artifacts and the independent EX-08/EX-09 release evidence remain required before funding. Frontend recovery controls will be coordinated with Decimal through the existing compatibility handoff; none are added here.

## Size, evidence and next implementation

With pinned solc 0.8.26, optimizer 200 and Cancun settings, the measured implementation runtime is **23,582 bytes** (994 bytes below EIP-170's 24,576 limit); factory runtime is **2,535 bytes**, and each clone runtime is 45 bytes. Factory creation code is 27,694 bytes. No compiler setting or code-size override was changed. **E4 cannot assume execution/swaps can simply be appended to this runtime**: split/refactor appropriate logic and remeasure/review a new immutable version before financial integration. This is an engineering dependency, not a reason to weaken the size limit or add an upgrade backdoor.

The [implementation report](../reports/PUBLIC_VAULT_E2_IMPLEMENTATION.md) records exact tests, sources and build evidence. #99 tracks the E1 review follow-ups before derived-record, planner and receipt integration: validation bypasses/duplicate keys, receipt-local indexing and unique credit/lot lineage, additional encoding vectors, shortfall reverts and actual receipt minimum checks. E2 does not invoke those Python validators or infer spending authority from them. E3/E4/E5/E6/E7 and public financial activation remain separate work.
