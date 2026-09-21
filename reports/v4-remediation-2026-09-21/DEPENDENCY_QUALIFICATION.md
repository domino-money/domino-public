# Dependency runtime qualification — 21 September 2026

The three expected runtime hashes are independently supported by Uniswap's official address book and Sourcify's existing source-verification records. The hashes were derived from Sourcify's verified runtime/recompiled bytecode records before comparison with a fresh pinned Robinhood mainnet observation. They were not copied from the Domino preflight's RPC output.

Use [dependency-pins.json](dependency-pins.json) as the public `dependencyCodeHashes` input. [dependency-verification-evidence.json](dependency-verification-evidence.json) records the source URLs, response fingerprints, verification IDs, compiler settings, complete immutable transformation records, and comparison results. This qualifies expected runtime identities; it does not authorize a deployment or qualify owner roles, publisher operation, funding, finality, or economic limits.

## Qualified values

| Dependency | Robinhood address | Runtime bytes | Expected Keccak-256 |
| --- | --- | ---: | --- |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 24,009 | `0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | 23,877 | `0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 3,531 | `0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6` |

All three addresses appear under `ROBINHOOD_ADDRESSES` in the [official Uniswap SDK address book, pinned at commit 358d9debee46d39e5ab7935dbe27e1589b320557](https://github.com/Uniswap/sdks/blob/358d9debee46d39e5ab7935dbe27e1589b320557/sdks/sdk-core/src/addresses.ts). Its [chain mapping](https://github.com/Uniswap/sdks/blob/358d9debee46d39e5ab7935dbe27e1589b320557/sdks/sdk-core/src/chains.ts) binds Robinhood to chain 4663. Retrieved file SHA-256 values are `8151bc19d912e758f6952714922b4c8dda6e98bc844ccbe74ad3a20665d771f7` and `a72600356b051cba24ee6ff8427091ae294c737f2d1c528f22c1eaec7df6d722`, respectively.

## Source verification and reconstruction

Read-only requests used the [documented Sourcify v2 contract lookup API](https://docs.sourcify.dev/docs/api/#contract-lookup), with `fields=all`. No verification request or transaction was submitted.

| Contract record | Match ID | Verified at UTC | Runtime / creation status | Optimizer runs |
| --- | --- | --- | --- | ---: |
| [PoolManager](https://sourcify.dev/server/v2/contract/4663/0x8366a39cc670b4001a1121b8f6a443a643e40951?fields=all) | 47290695 | 2026-09-08 09:35:27 | `match` / `match` | 44,444,444 |
| [PositionManager](https://sourcify.dev/server/v2/contract/4663/0x58daec3116aae6d93017baaea7749052e8a04fa7?fields=all) | 46997905 | 2026-09-01 15:16:54 | `match` / `null` | 30,000 |
| [StateView](https://sourcify.dev/server/v2/contract/4663/0xf3334192d15450cdd385c8b70e03f9a6bd9e673b?fields=all) | 47290694 | 2026-09-08 09:35:25 | `match` / `null` | 44,444,444 |

All records report Solidity `0.8.26+commit.8a97fa7a`, via IR, Cancun, optimizer enabled, metadata bytecode hash `none`, empty runtime link references, and no proxy. These are Sourcify's verification results, not a local source recompilation performed during this bounded check. The returned level is `match`, not `exact_match`; absent creation results are not a successful creation verification.

For each record, local code started with `runtimeBytecode.recompiledBytecode`, required each recorded transformation to be an immutable-only 32-byte replacement of a zero slot, rejected overlapping offsets, and checked that the transformation offsets exactly covered the supplied `immutableReferences`. Applying only the recorded immutable values produced byte-for-byte equality with `runtimeBytecode.onchainBytecode`, including auxiliary bytecode. There were 1, 40, and 12 replacement locations, respectively. Keccak-256 of that reconstructed runtime produced the pins above.

The PoolManager immutable is its own address. Both consumer runtimes contain the expected PoolManager address. PositionManager also records the canonical Permit2 address, Robinhood WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73`, chain ID `0x1237`, and additional descriptor/domain/gas-limit immutable words preserved in the evidence. This check does not separately qualify those transitive dependencies.

PoolManager's verification record includes creation transaction `0x4fb28d4935866f462582c6c931c6f2705e55f5be5eb178c7d8d9329a95c44c41` at block 9070. PositionManager and StateView return null deployment fields; no creation provenance is inferred for them.

## Current-chain comparison

The [official Robinhood connection documentation](https://docs.robinhood.com/chain/connecting/) identifies the public mainnet RPC used for the comparison. At `2026-09-21T15:32:02.611Z`, latest block **68,906,748**, hash `0x1db507555d5cd84cb376e8dc0cb67a0a6886e8d967f86aee621c1e7dc4428205`, all three `eth_getCode` calls used the same EIP-1898 `{blockHash, requireCanonical:true}` selector. Each response equaled the corresponding Sourcify runtime byte for byte. A subsequent block-number lookup confirmed the pinned hash remained canonical. This observation is explicitly **latest**, not finalized; the unavailable finalized-state result in the mainnet preflight remains unchanged.

## Scope and evidence gaps

- The explorer identified by [Robinhood's wallet documentation](https://docs.robinhood.com/chain/add-network-to-wallet/) returned HTTP 403 for `/api/v2/smart-contracts/{address}` for all three contracts. No explorer source verification is claimed. Sourcify supplied the independent verification evidence.
- The source contents returned by Sourcify differ from the repository's vendored `official-v4` fixtures. Those fixtures must not be described as a byte-for-byte reproduction of these deployed source builds. Fresh deployment runtime pins are qualified here; equivalence of every vendored-source behavior is a separate claim.
- Sourcify's deduplicated compilation paths and its returned verification metadata paths differ for PoolManager and StateView. Comparing source contents by Keccak-256 found all 45 PoolManager metadata source hashes, all 69 PositionManager hashes, and 22 of 24 StateView hashes in the supplied source set. The recorded immutable IDs also differ between StateView's compilation references and transformation records, although their offsets agree exactly. These records support runtime reconstruction and Sourcify's reported `match`; they do not establish exact original build metadata/source-tree identity. The two absent StateView metadata source contents remain an explicit provenance gap.
- Full API response SHA-256 fingerprints are retained for reproducibility, but multi-megabyte source bundles are not committed. Re-fetch the linked API records and verify fingerprints or review any changed record before reusing this evidence. No local dependency recompilation was run.

Validation executed: three immutable-only reconstructions, three exact live-bytecode comparisons at one canonical pinned block, address-book/chain mapping checks, and JSON validation. No keys, private configuration, signing, broadcasting, or service activation were used.
