# Direct-deposit deployment and token review

Issue #42 · read-only evidence collected 2026-09-10 · **production execution remains disabled**.

The configured Uniswap deployments and three existing pool identities match real Robinhood Chain state. The two primary fork candidates, **WETH/USDG and ETH/USDG, do not meet the current token-admission policy**: both WETH and USDG are upgradeable proxies. Successful minting in a fork can qualify protocol mechanics under stated test assumptions; it cannot establish `nonUpgradeable: true` for these currencies.

The report changes no admission manifest, production configuration or financial permissions. Its companion [sanitized evidence](deposit-deployment-review-2026-09-10.json) contains public addresses, hashes, code fingerprints, pool state and read results, with no provider endpoint or credentials.

## Scope and reproducibility

All real-network operations were HTTPS source retrieval or `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, `eth_getStorageAt` and `eth_call`. No real transaction was signed, submitted or simulated through a state-changing RPC. Calls to `approve` and zero-value `transfer` were nonpersistent `eth_call` probes from a synthetic address; they did not change allowances or token balances.

The public Robinhood RPC answered the initial height query through the repository's `discovery.json_http` transport. A subsequent public request exceeded its deadline. Detailed evidence used the separately authorized development **product** read provider, loaded locally without retaining its endpoint. No personal-bot configuration, signer, wallet or runtime was used.

Pinned state:

- Chain ID: **4663** (`0x1237`).
- Block: **59,676,121** (`0x38e95d9`), timestamp **2026-09-10 20:06:38 UTC**.
- Hash: `0x555260f7a9698a6bf555a089f956d05fae853123edefd4a40e412328134604d0`.
- Numeric-block reads were followed by two checks that this block still had the same canonical hash.
- The provider's then-current `finalized` head was behind this snapshot. This report therefore describes an observed canonical snapshot, **not a finalized transaction or permanently immutable state**. The exact finalized-head response is retained in JSON.

The [official Robinhood connection guide](https://docs.robinhood.com/chain/connecting/) identifies ETH as native gas currency, chain 4663 and the public RPC, and recommends archive-capable infrastructure for historical reads. Native ETH is represented by the zero currency address in v4; it has no ERC20 proxy, approval or transfer semantics.

## Protocol deployments and source versions

All four deployment addresses agree with the [official Uniswap deployment table](https://developers.uniswap.org/docs/protocols/v4/deployments#robinhood-chain-4663) and the repository constants. Bytecode was read at the pinned block and fingerprinted with Ethereum Keccak-256.

| Contract | Address | Runtime bytes | Runtime code hash |
| --- | --- | ---: | --- |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 24,009 | `0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | 23,877 | `0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 3,531 | `0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6` |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` | 9,152 | `0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca` |

The [official deployment record](https://github.com/Uniswap/contracts/blob/e34ba78b05663c8c342cce69b0039067ace75691/deployments/json/4663.json) points the v4 deployments to deployment-tool commit `56928a9bb63d4b94fa41bbb104c22b5f759997e0`. Its [locked dependencies](https://github.com/Uniswap/contracts/blob/56928a9bb63d4b94fa41bbb104c22b5f759997e0/foundry.lock) identify:

| Dependency | Recorded source revision |
| --- | --- |
| v4-core | `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` |
| v4-periphery | `60cd93803ac2b7fa65fd6cd351fd5fd4cc8c9db5` |
| Permit2 | `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219` |

PoolManager, PositionManager and StateView use solc 0.8.26, IR compilation and Cancun. Optimizer runs are 44,444,444 for PoolManager/StateView and 30,000 for PositionManager. Their complete observed runtime matches the runtime embedded in the official deployment initcode **after normalizing only the compiler-declared constructor immutable locations**. There were no remaining differing bytes. Locations, observed immutable values and initcode hashes are retained in JSON. Sources: [PoolManager deployer](https://github.com/Uniswap/contracts/blob/56928a9bb63d4b94fa41bbb104c22b5f759997e0/src/briefcase/deployers/v4-core/PoolManagerDeployer.sol), [PositionManager deployer](https://github.com/Uniswap/contracts/blob/56928a9bb63d4b94fa41bbb104c22b5f759997e0/src/briefcase/deployers/v4-periphery/PositionManagerDeployer.sol), [StateView deployer](https://github.com/Uniswap/contracts/blob/56928a9bb63d4b94fa41bbb104c22b5f759997e0/src/briefcase/deployers/v4-periphery/StateViewDeployer.sol).

This is an independent byte comparison against published deployment artifacts; it is **not a fresh independent compilation of the entire dependency tree**. The recorded source revisions refer to the deployment tooling's lockfile, not an assertion that today's latest GitHub source was deployed. Permit2 is explicitly described in the official deployment record as pre-existing; this deployment run does not prove its original creation revision. Its separately retrieved Sourcify verification uses solc 0.8.17, IR, London and 1,000,000 optimizer runs, with documented immutable/metadata transformations. Do not call that an exact metadata match.

At the same pinned block, direct getter calls verified:

- `PositionManager.poolManager()` and `StateView.poolManager()` → the canonical PoolManager above.
- `PositionManager.permit2()` → canonical Permit2 above.
- `PositionManager.WETH9()` → WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73`.
- `PositionManager.tokenDescriptor()` → `0x9639443158e8c5efa35bd45287bf2effd3d8dc06`.

The descriptor is recorded as a transparent upgradeable proxy in the official deployment record; it supplies NFT presentation metadata. Its existence does not make the PositionManager itself a proxy or qualify token-transfer semantics. Standard EIP-1967 implementation/admin/beacon slots were zero in the four operational protocol contracts at the observed block. Zero slots alone would not prove absence of arbitrary upgrade mechanisms; the protocol conclusions also rely on the source/artifact checks above.

## Token findings

### WETH: canonical address, upgradeable bridge wrapper

Currency: `0x0bd7d308f8e1639fab988df18a8011f41eacad73`, 18 decimals.

- Proxy runtime: 2,202 bytes; code hash `0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353`.
- EIP-1967 implementation: `0xc6b81b429797e0f555440b70cd99e032d7ae947e`.
- EIP-1967 admin: `0xa3acd31afb851b4eb9dad00f5204c01d924267df`; its `owner()` returned `0x2a153c6a1b66dbc930a8d7017230ab0253005c09`.
- Current implementation code hash: `0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650`.

The [proxy's published verification](https://sourcify.dev/server/v2/contract/4663/0x0bd7d308f8e1639fab988df18a8011f41eacad73?fields=all) reports `exact_match` for TransparentUpgradeableProxy, solc 0.8.16. Its full on-chain runtime equals the bytes independently read from the pinned RPC. The [current implementation's verification](https://sourcify.dev/server/v2/contract/4663/0xc6b81b429797e0f555440b70cd99e032d7ae947e?fields=all) reports `match` for Arbitrum `aeWETH`, with a metadata difference rather than an exact match.

The reviewed `aeWETH` source mints `msg.value` on `deposit()`/`depositTo()` and burns the specified amount on withdrawal. It also exposes bridge controls and a separate `transferAndCall` extension. Ordinary transfers/approvals use the ERC20 implementation; the existence of a callback extension must not be confused with ordinary `transfer` behavior. On-chain `l1Address()` returned Ethereum WETH `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2`; `l2Gateway()` returned `0x1d187c3e2da52d72bc9c41e3aba0fdfa6a7bf055`.

**Admission result: blocked by current `nonUpgradeable` requirement.** A hash of only this proxy cannot detect a future implementation change. Fork wrapping is useful test setup; it does not remove that constraint.

### USDG: UUPS implementation and configurable behavior

Currency: `0x5fc5360d0400a0fd4f2af552add042d716f1d168`, 6 decimals.

- Proxy runtime: 170 bytes; code hash `0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6`.
- EIP-1967 implementation: `0x68184c449e1a8f34fa18d289737129fd27b66f8f`.
- EIP-1967 admin and beacon slots are zero. **That does not make this proxy nonupgradeable:** upgrade authorization resides in the UUPS implementation.
- Current implementation code hash: `0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf`.

The [proxy verification](https://sourcify.dev/server/v2/contract/4663/0x5fc5360d0400a0fd4f2af552add042d716f1d168?fields=all) is a runtime `match`, with compiler/metadata differences. The submitted wrapper has a generic ERC1967 proxy implementation despite its submitted contract name; that name is not evidence that USDG is an ERC1155. The [implementation verification and sources](https://sourcify.dev/server/v2/contract/4663/0x68184c449e1a8f34fa18d289737129fd27b66f8f?fields=compilation,abi,sources,runtimeBytecode.onchainBytecode,runtimeBytecode.recompiledBytecode,runtimeBytecode.transformations) identify `USDG`, solc 0.8.28, inheriting `PaxosTokenClaimableRewards` and `UUPSUpgradeable`.

The reviewed code restricts upgrades to `DEFAULT_ADMIN_ROLE`, can change additional selector-to-facet delegates, and implements pause/frozen-address restrictions. Current `balanceOf` returns the base ERC20 balance and **excludes unclaimed rewards**. Current `_transfer` debits/credits the requested base amount and separately updates payout bookkeeping. The shares/rewards code and a high-level “auto-compounding” description are insufficient grounds to call the observed base balance rebasing; this review makes no such claim.

**Admission result: blocked by upgradeability.** Standard base transfer behavior in the inspected implementation does not establish a permanent nonrebasing/standard-transfer guarantee. Supporting this token would need an explicitly reviewed policy for implementation/facet identity, mutability, controls and reconciliation. This task neither designs nor activates that policy.

### Other ERC20 candidates: evidence is incomplete

| Currency | Address | Runtime code hash |
| --- | --- | --- |
| MARLIN | `0xab35d04e1ee39c789c4a65d522417b3c7f2e4723` | `0xe6abae219423b67e5d0449b963f961aba48608000a56c50c04a2cab5249a0ada` |
| BAG | `0x792ff19204ef6c756b4d8efe2441d050f5ece818` | `0x5aff554209d625c32d4c7b768bbfa4db78c2ca51da59808a00acbe55c6660a0e` |
| ZZZ | `0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a` | `0x3d5ba33c3a94f655c16348011ff2c72f6ce8085239454ce4a6c4bf284e84a597` |

All three have 3,248 runtime bytes, zero standard EIP-1967 slots, matching metadata and matching executable bytes except three embedded address regions. They are not the 45-byte EIP-1167 template tested by this probe. These facts do **not** prove immutability, standard transfers or lack of callbacks/transfer controls. Their direct Sourcify records returned 404. The official Blockscout API required an interactive Cloudflare challenge; no bypass was attempted. Referenced IPFS metadata was unavailable through the attempted public gateways. Additional source lookups for TRADOOR, CRUMBS, RUBEN and MAD also returned no Sourcify verification during this bounded check.

For WETH, USDG, MARLIN, BAG and ZZZ, pinned `eth_call` of `approve(Permit2, 1)` and zero-value `transfer(syntheticAddress, 0)` returned ABI boolean true. These narrow probes establish return-shape compatibility for those calls at that block. They do not exercise positive-value debit/credit accounting, subsequent upgrades, all transfer branches, rebase behavior or every account-control state. **None of these probes creates a production-admitted token.**

## Existing pools ready for controlled fork characterization

The complete PoolKey was reread from canonical PositionManager, rehashed with the existing repository `PoolKey.checked`, and its initialized state/fee reread from canonical StateView. All three hashes and fixed LP fees matched. Active liquidity is a raw protocol quantity, **not TVL or USD valuation**.

| Candidate | PoolId | Fee pips | Tick spacing | Observed tick | Production eligibility |
| --- | --- | ---: | ---: | ---: | --- |
| WETH / USDG | `0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6` | 200 | 4 | -198233 | Blocked: both currencies upgradeable |
| ETH / USDG | `0x3b0cbf0603ecc67b5fc9bb4fbb6ac9e08d3b2f406b63d1662a36063a7fe5e866` | 87 | 1 | -198231 | Blocked: USDG upgradeable |
| ETH / MARLIN | `0xbf0fe39ec46400f36455eae199696e1009af2182f62bfb256b559b1f3e11afec` | 9000 | 90 | 160546 | Unqualified: token source/semantics incomplete |

All have hook zero. Currencies are sorted by address: WETH then USDG; native zero then USDG; native zero then MARLIN. Exact `sqrtPriceX96`, liquidity and packed protocol fees are in the evidence. The earlier [generic-token report](generic-token-qualification-2026-09-09.json) supplied discovery seeds only; it was never token admission. No ETH/WETH pool is claimed by this review.

## What the fork evidence may establish

The issue #42 harness can test deployed v4 ABI, selected range/debit caps, ERC20 and Permit2 approval sequencing, real deployed mint logic, receipt/NFT association, accounting and failure recovery against local fork state. Because the useful existing pools above cannot pass today's production admission, any in-memory test override must be labeled **controlled admission override for protocol characterization**. It must remain behind the local-only fork transport, export no manifest, change no production guard and retain `executionEligible: false` in the result. A negative control using the production preparer with no manifest must reject preparation before the override is used.

A successful overridden test means “the protocol path executed with these observed token implementations and test assumptions.” It must not be reported as “WETH/USDG is production qualified,” “token admission passed” or “the alpha is ready for deposits.” The fork cannot itself certify Arbitrum sequencer/finality economics, future proxy implementations, external admin actions, market suitability, APR or production gas pricing. Native spend/refund needs exact transaction evidence; whole-block wallet deltas are not a substitute.

The remaining human-reviewed admission decision is concrete: retain the current immutable-token scope and obtain source-qualified candidates, or separately design support for controlled upgradeable assets. Neither choice is silently made by this report. Protocol deployment identity evidence and token eligibility evidence remain distinct.
