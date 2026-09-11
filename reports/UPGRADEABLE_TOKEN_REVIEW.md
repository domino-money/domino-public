# Robinhood reviewed upgradeable-token candidates — 2026-09-10

This review supports the issue #44 change from an immutable-only policy to **address-bound reviewed proxy profiles**. WETH and USDG can be candidates under the finite checks below. They remain upgradeable, issuer-controlled assets. The JSON profiles are review inputs for the isolated fork qualification, not an activated production manifest or a promise about future token behavior.

The earlier [deployment review](DEPOSIT_DEPLOYMENT_REVIEW.md) accurately describes the immutable-only blocker at the time of #42. This review supplies a new policy scope; it does not rewrite that historical result. See also [fork qualification](DEPOSIT_FORK_QUALIFICATION.md) and [RPC/fee qualification](DEPOSIT_RPC_QUALIFICATION.md).

## Evidence and provenance

- Read-only Robinhood chain **4663**, block **59,702,441**, hash `0x7e18a93cf71e6bb1f094f4a5552475590034e763e7154c1cac16a35cba8108a7`, timestamp **1789073456 / 2026-09-10 20:50:56 UTC**. The block hash was checked again after the reads. No transaction, signature, impersonation, token transfer or wallet connection was sent to the live network.
- Public chain evidence and source digests are in [upgradeable-token-review-2026-09-10.json](upgradeable-token-review-2026-09-10.json). Candidate profiles are in [robinhood-reviewed-token-profiles-2026-09-10.json](robinhood-reviewed-token-profiles-2026-09-10.json). The explicit account `0x1111111111111111111111111111111111111111` is a synthetic test identity, **not the user's wallet**. Its result cannot authorize any other owner.
- The verified WETH and USDG implementation sources were obtained from Sourcify, compiled independently using **solc 0.8.16+07a7930e** and **0.8.28+7893614a**, and compared with runtime bytecode read directly from the implementation addresses at the pinned block. All executable bytes matched. WETH differs only in the compiler metadata trailer; USDG additionally contains the compiler-declared UUPS implementation-address immutables. The independent compiler storage layouts equal the verified layouts.
- USDG's compiled source is tied to the [issuer repository at commit 74999fc56a91c6e78e829ed5b5b7da4ada9a79d4](https://github.com/paxosglobal/paxos-token-contracts/tree/74999fc56a91c6e78e829ed5b5b7da4ada9a79d4). Fifteen of sixteen project source files match byte for byte. `ClaimableRewardsBase.sol` differs only because the deployed verified source omits `virtual` on `DOMAIN_SEPARATOR()`. The deployed source, not a guessed release, was recompiled. The [USDG v3.0.0 release](https://github.com/paxosglobal/usdg-contract/releases/tag/v3.0.0) points to wrapper commit `5afb581e076f69ae46eb2e360f4dc63a71514a78` and that submodule commit; this is provenance context, not a claim that every release file is identical to the deployment.
- The observed USDG `TokenAdminFacet` was **independently recompiled from the issuer's pinned facet source plus the verified implementation dependencies**. Its executable runtime matches the deployed facet, with only compiler metadata differing. Sourcify did not have a verification record for that facet; the independent bytecode comparison closes that particular source gap.
- The WETH governance implementation, WETH ProxyAdmin and USDG default-admin contract have pinned on-chain code hashes, but their full source and authorization membership were **not independently authenticated here**. Sourcify returned no verification record and content-addressed metadata retrieval was unavailable. Their observed getters are change tripwires, not proof of a complete governance audit or guaranteed response window.

## WETH

| Identity | Address | Runtime Keccak-256 |
| --- | --- | --- |
| Transparent proxy | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` | `0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353` |
| aeWETH implementation | `0xc6b81b429797e0f555440b70cd99e032d7ae947e` | `0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650` |
| ProxyAdmin | `0xa3acd31afb851b4eb9dad00f5204c01d924267df` | `0xa4b2186ab82fa36fb4ae158582e5615ea519e757c26c13ba4a33daaaed8902a7` |
| ProxyAdmin owner / governance proxy | `0x2a153c6a1b66dbc930a8d7017230ab0253005c09` | `0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353` |
| Governance implementation | `0x3c3e52bc8c181d06a76e2518bbc655c5bb3ce7cd` | `0x0d88feac198ef1b50b99fddf06aa9f6b1050bfe7211d6f04173de9b6d8953bcb` |

The WETH and governance proxies use the same ProxyAdmin and have zero EIP-1967 beacon slots. Pinning only `ProxyAdmin.owner()` would miss an implementation change inside the owner contract; the profile therefore pins the governance implementation, its code and its implementation/admin/beacon slots as well.

The [verified aeWETH source package](https://sourcify.dev/server/v2/contract/4663/0xc6b81b429797e0f555440b70cd99e032d7ae947e?fields=all) defines the ordinary ERC-20 path through `ERC20Upgradeable`. `approve` sets the exact allowance and returns true. `transfer` and `transferFrom` subtract/add the exact amount and return true. There is no transfer tax, rebasing step, pause/freeze control or callback in these ordinary paths. The inherited transfer hook is empty. The separately exposed `transferAndCall`, deposit/withdraw and bridge methods are outside the direct-deposit calldata scope.

The initialized flag is slot 0, byte 0; initializing is byte 1. Require the low 16 bits to equal **1**. Pin slot **204** (`l2Gateway`) to `0x1d187c3e2da52d72bc9c41e3aba0fdfa6a7bf055` and slot **205** (`l1Address`) to Ethereum WETH `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2`. The getter outputs agree with these authenticated layout positions. The gateway can burn for the bridge; aeWETH explicitly rejects bridge minting. This review does not qualify the bridge or prove collateral solvency.

## USDG

| Identity | Address | Runtime Keccak-256 |
| --- | --- | --- |
| ERC-1967 / UUPS proxy | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | `0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6` |
| USDG implementation | `0x68184c449e1a8f34fa18d289737129fd27b66f8f` | `0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf` |
| `defaultAdmin()` / `owner()` | `0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f` | `0xe616a4f66608354a45be3af2f82e909a1e000f4360eeb909defd830ee43c554b` |
| Observed TokenAdminFacet | `0x58cab81e3d8468a0e90df8cbfacb34535e1de942` | `0xe59c8f48b9198212d26a62177e6f49eedd46d0005b3a7b4f1ff282b11f82d5a4` |

The proxy's EIP-1967 admin and beacon slots are zero. This does **not** mean that USDG has no upgrade authority: the compiled UUPS implementation requires `DEFAULT_ADMIN_ROLE` to authorize an upgrade. That role also controls `setFacet`/`batchSetFacet`.

### Authenticated layout and finite operational checks

The [verified implementation package](https://sourcify.dev/server/v2/contract/4663/0x68184c449e1a8f34fa18d289737129fd27b66f8f?fields=compilation,abi,sources,storageLayout,runtimeBytecode.onchainBytecode,runtimeBytecode.recompiledBytecode,runtimeBytecode.transformations) and the independent build establish these positions. Offsets below count from the least significant byte of a 32-byte storage word.

| Field | Location | Predicate for this profile |
| --- | --- | --- |
| `globalTransferSettings.paused` | slot **4**, byte **20**, mask `0xff << 160` | Zero |
| `frozen[account]` | mapping base slot **6**, low byte mask `0xff` | Zero for actual owner, Permit2 and PoolManager |
| `balanceData[account].payoutGroupId` | mapping base slot **1**, bytes **16–17**, mask `0xffff << 128` | Zero for actual owner and PoolManager |
| V3 initialization | slot **61**, initialized byte 0 / initializing byte 1 | Recorded initialized value 3, initializing false |
| Pending default admin and schedule; admin transfer delay | slot **212** | Pin the recorded word: no pending transfer; delay 10,800 seconds |
| Current default admin; pending delay and schedule | slot **213** | Pin the recorded word: observed admin, no pending delay change |

An address mapping location is `keccak256(abi.encode(account, uint256(baseSlot)))`, with the address left-padded to 32 bytes. The source comments incorrectly label `frozen` as slot 7; the compiler and executable runtime establish **slot 6**. The published comments also contain outdated aggregate slot descriptions, so none of the policy offsets are taken from comments alone.

At the pinned block, pause was false; the synthetic owner, Permit2 and PoolManager were unfrozen. Both the synthetic owner and PoolManager had payout group 0. This proves the narrow path is usable in that snapshot; it does not estimate how many holders are enrolled in rewards. A real owner with a nonzero payout group is explicitly unsupported by this first profile and must receive a clear restriction result, not be silently treated as standard.

### Ordinary transfer path

- `balanceOf` reads the packed base balance, a uint64 in the low eight bytes of `balanceData[account]`. It does not automatically credit pending rewards. `allowance` reads mapping slot 3.
- `approve` requires an unpaused token and unfrozen owner and spender. Domino approves Permit2, so both identities must be checked.
- `transferFrom`, invoked by Permit2, additionally checks the caller's freeze state; its internal transfer checks the source and destination. The relevant addresses for this mint path are owner, Permit2 and PoolManager. PositionManager is the Permit2 allowance spender but is not the ERC-20 `msg.sender` in the token transfer. The owner and PoolManager are the actual balance endpoints.
- With both payout groups zero, the compiled implementation writes `fromBalance - value` and `toBalance + value`, and emits that exact value. There is no facet call, transfer fee, automatic reward credit, token callback or supply-control call. Standard balance/allowance/nonzero-address checks still apply. USDG's uint64 balance bound can cause a transfer to revert; simulation remains required and this profile does not make arbitrary uint256 deposits executable.
- A nonzero payout group enters additional mutable state: payout records, multipliers, reward shares, claim timestamps and global reference/maturity settings. Those internal paths still compute the same base transfer amount, but can fail for additional reward-state reasons. The group-zero requirement deliberately keeps those paths outside this initial qualification rather than pretending a pause/freeze check fully covers them.

### Facets and governance

The compiled main implementation owns the ordinary `approve`, `transfer`, `transferFrom`, `balanceOf`, `allowance` and `getFacet` selectors. Its fallback dispatches **other** selectors through mapping slot **274**. Changing a facet entry cannot replace an already compiled ordinary selector. Operational checks therefore read the authenticated raw pause/freeze/payout storage, rather than trusting `isFrozen` or `paused`, whose implementation can be changed through facet routing.

The independently matched [TokenAdminFacet source](https://github.com/paxosglobal/paxos-token-contracts/blob/74999fc56a91c6e78e829ed5b5b7da4ada9a79d4/contracts/facets/TokenAdminFacet.sol) has these controls:

- `PAUSE_ROLE` permits pause/unpause.
- `ASSET_PROTECTION_ROLE` permits freeze/unfreeze, their batch variants and wiping a frozen address. Freezing can detach reward membership; unfreezing can restore it. Thus a later unfreeze need not preserve payout group 0.
- `DEFAULT_ADMIN_ROLE` permits supply-control configuration and token reclaiming; the main implementation also uses this role for upgrades and facet changes.

`DEFAULT_ADMIN_ROLE` is zero bytes32. The observed admin holds it. `PAUSE_ROLE` is `0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d`; `ASSET_PROTECTION_ROLE` is `0xe3e4f9d7569515307c0cdec302af069a93c9e33f325269bac70e6e22465a9796`. Both have default admin as their role administrator. The default-admin address itself did not hold these two operational roles at the observation block. The token does not expose enumerable role-member getters; this review does not claim to have enumerated all holders or authenticated their signing policies.

The candidate pins the facet's code and the seven observed routing entries for `isFrozen`, `paused`, `pause`, `unpause`, `freeze`, `unfreeze` and `setSupplyControl`. They are conservative change tripwires, not an exhaustive inventory of every facet selector. Other facets may write shared storage; an authorized new facet can potentially write arbitrary storage through delegatecall. Checks on the fields used by the selected transfer path detect relevant state at the observation block, but do not prove that all possible future administrative behavior is benign.

The token's default-admin transfer delay is **10,800 seconds**, and no pending transfer/delay change was observed. This is a delay for transferring the admin role, **not an upgrade timelock**. The admin contract's `getMinDelay()` returned **86,400 seconds** and is pinned as an observed identity call. Without source/authentication of that contract's complete execution and role paths, this review does not assert that every upgrade, freeze or facet change must wait that long. Pause/freeze roles can act independently of token-default-admin transfer scheduling.

## Policy boundaries and residual risk

1. Profiles identify **chain, exact address, proxy/implementation/dependency code, governance identities and finite source-derived state**, never symbol or provider metadata. A change requires a new reviewed content digest. Code alone is not an assertion of permanent behavior or administrative trustworthiness.
2. Evaluate the profile for the authenticated owner at the same canonical source block as the prepared deposit. Revalidate before re-exposing a stored artifact and after each approval before preparing the next step. A mismatch or unavailable check denies preparation; it is not a reason to silently drop a predicate.
3. These are snapshot checks for wallet-issued transactions. The issuer can upgrade, pause, freeze, change reward membership, alter roles or execute a facet after preparation and before mining. Exact calldata and simulation do not lock the issuer's state. A failed transaction can still spend gas.
4. Matching identities at two block ends cannot exclude a transient upgrade/change/revert within a block. Event-based receipt amounts remain an explicitly qualified observation for the reviewed semantics, not transaction-trace proof that a proxy never changed. Do not portray those amounts as immutable-token certainty or infer native refunds from a block balance.
5. The profile qualifies ordinary direct-deposit ERC-20 transfer/approval semantics only. It does not qualify USDG rewards, issuer solvency, bridge security, all future implementations, arbitrary routers, hooks, taxes on other tokens, or swap execution.
6. This task produces no production admission, hosted activation, mainnet allowance, key, RPC credential or automatic token selection. Activation and public use must retain the visible upgrade/issuer-control limitation and the existing reviewed deployment process.
