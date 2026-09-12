# Vault v2: space prerequisite for public execution

Status: **implementation candidate for independent review**, part of [#88](https://github.com/domino-money/domino/issues/88). It changes the E2 custody implementation and build, not the public execution status. Compound, Domino minting and automated swaps remain unimplemented. This is a new immutable deployment version, not an upgrade mechanism for existing clones.

## Decision

Keep all custody, storage, permission transitions, subscriptions, callbacks and owner recovery in `DominoVault`. Extract position/checkpoint reads and E1 identity encoding into a constructor-created `DominoVaultReadHelper`. Compile the Solidity package with the pinned solc 0.8.26, Cancun, optimizer 200 and `via_ir = true`.

The vault holds immutable `readHelper` and `readHelperCodeHash` values. Each helper call is a typed `STATICCALL` after the hash check. The helper has fixed PositionManager/StateView identities and no writable state, asset transfers, approvals, arbitrary execution, implementation setter or privileged administrator. It receives a typed sequence context directly; it does not call back into the clone to reconstruct that context. Anyone may query the helper: its output alone proves neither registered membership nor earned income.

This adds no delegate execution boundary. The existing EIP-1167 clone still delegates to its one fixed vault implementation. In particular, PositionManager asset mutations continue originating from the vault, whose individual NFT approval and custody remain meaningful. No router or module obtains that approval.

Live authority fails closed if the helper's code is missing or changed. Registration/rearm cannot bypass the pin. Owner reserve, surplus and NFT exits, pause/revoke and root invalidation do not depend on the helper. This preserves recovery if an auxiliary read fails, including paused/revoked or exhausted-counter states. Existing exact ERC20 debit/credit checks, fixed owner recipient and callback lock remain local.

## Identity and compatibility

`implementationVersion` is **2**. The E1 sequence, position and fee-source field orders and domain strings stay unchanged; the sequence includes the actual version and implementation address. An independent reconstruction test pins version 2 rather than reading it back as its own oracle. Stored registration baselines remain immutable across rearm; current checkpoints are still separate opening observations, never fee-credit evidence.

The two helper metadata getters and `ReadHelperUnavailable()` are additive contract ABI changes. Existing custody method signatures and storage declarations are retained. A different factory/implementation produces different clone predictions and sequence identities; version-1 identities, plans and approvals must not be relabelled as version 2. There is no in-place migration or upgrade, and this PR selects no production address.

There is no browser API, frontend hook, database schema or admission flag change. Future executable-vault admission must independently bind the reviewed factory, implementation, version, helper code and manager identities. A passing `validateAuthority` remains an authority preview, not a compound method.

## Space and tradeoffs

The preceding implementation at main `710b52f13ef06b77ddc122fcbbadb19d2c29f7be` has a 24,113-byte runtime, only 463 bytes below the 24,576-byte [EIP-170 limit](https://eips.ethereum.org/EIPS/eip-170). Compiler-only experiments recover some space but leave all duties in the same contract. Extracting only position/checkpoint reads has limited benefit because external ABI encoding also consumes bytecode.

The selected extraction includes identity encoding and uses direct context rather than helper-to-vault getter callbacks. Although getter callbacks benchmark smaller in code size, direct context makes the call graph simpler and avoids repeated clone round trips. The helper is deployed once per implementation and shared by its clones. Its deployment and external read overhead must be included in costs; smaller vault bytecode is not evidence of cheaper compounding.

The committed size gate verifies runtime and constructor bytecode, including each contract's constructor arguments, against [EIP-3860's 49,152-byte initcode limit](https://eips.ethereum.org/EIPS/eip-3860). Factory initcode already embeds the nested vault/helper creation code. The gate also requires at least **4,000 bytes of vault runtime headroom for this architecture candidate**. This is a review budget, not a promise that E4/E6/E7 fit. A later reviewed execution increment must measure actual bytecode, justify its use of this budget and preserve the protocol limits. Do not disable or silently lower the gate to append execution.

Measured profiles, tests and limits are recorded in the [verification report](../reports/PUBLIC_VAULT_V2_ARCHITECTURE.md). The compiler profile affects the entire Solidity test package, so existing custody, identity, policy, accounting and callback-gas tests are rerun; a successful size measurement alone is insufficient.

## Sequence after this review

1. **#88 compound:** actual fee collection and explicit-liquidity addition, first general then narrowly eligible net path. Bind a precise expected modify callback context; prove measured fees, no principal/wallet top-up, once-only charge, residual preservation, net/general parity and pinned PositionManager effects. The current callback guard and internal test credit sinks do not implement this.
2. **#90 Domino:** source-local routing, independent trigger/overlap bounds, a single unresolved successor, actual mint reconciliation and retained owner exits. Integrate durable recovery from #89 before retries can create positions.
3. **#91 swaps:** fixed typed route identities, capped exact input, minimum output, price/impact/deadline bounds, fixed recipients, allowance cleanup and converted source/charge lineage. No arbitrary router calldata or new tariff on internal fee-balancing swaps.

Each stage needs its own implementation, bytecode measurement, financial evidence and independent review. Public execution stays unavailable until those gates and deployment/admission qualification are complete.
