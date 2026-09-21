# Robinhood mainnet gas funding: ecosystem qualification

Research date: 2026-09-21. Application baseline: `60c946519fcc582a9fa32713b2372ee47f455ade`; deployed-contract source candidate remains `aaf33947e7aeccf902b311c6d2282a742a929c2b`. This is a read-only feasibility study, not a production admission or provider purchase. No account, policy, signing key, transaction, token approval, or sponsorship request was created.

**Account-abstraction sponsorship is available in the Robinhood mainnet ecosystem, but Domino cannot adopt it by changing its gas-funding address.** Alchemy and Pimlico document mainnet sponsorship; Pimlico's public bundler and ZeroDev's public inventory independently recognize chain 4663. Domino's current release admission, signing, and receipt reconciliation require direct EOA execution. Treasury funding of the existing operator and independent publisher therefore remains the compatible immediate path. Sponsorship is a separate integration project that can later replace some native-ETH working capital with provider billing or treasury-owned token payments.

## Chain and gas mechanics

Robinhood identifies mainnet as **4663**, testnet as **46630**, and the native gas asset as **ETH**. Mainnet uses the Arbitrum stack with Ethereum blobs for data availability. Robinhood recommends Alchemy for RPC and account abstraction; its public RPC is rate limited and not recommended for production. Other listed RPC vendors are not evidence of bundler or paymaster support. [Official connection information](https://docs.robinhood.com/chain/connecting/).

Robinhood describes first-come-first-served transaction ordering, so paying a higher fee does not buy ordering priority. Its documentation explicitly presents ERC-4337 support. This establishes a chain capability, not compatibility with every smart-account implementation or provider product. [Robinhood overview](https://docs.robinhood.com/chain/).

Nitro's transaction estimate includes child-chain execution and the parent-posting charge converted into child-chain gas. In simplified notation, `feeWei = P × (executionGas + postingBufferGas)`. `NodeInterface.gasEstimateComponents` separates the estimated total and parent portion. Use an estimate for the exact transaction, sender and current state; do not add an independent parent fee again to an already inclusive estimate. A plain Anvil gas count does not qualify this chain-specific estimate. Parent-price estimates can be zero on some chain configurations; code must not divide by that value. [Arbitrum estimation method](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas).

The posting estimate depends on compressed transaction size and dynamically adjusted pricing; a small public-RPC snapshot is not a guarantee of future fees. [Arbitrum gas accounting](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees).

### Timestamped public observations

The official public RPC, `https://rpc.mainnet.chain.robinhood.com`, returned the following values. State calls used EIP-1898 `{blockHash, requireCanonical: true}` at the indicated latest block, followed by a canonical block-hash recheck. This was **latest**, not a finalized-state qualification. `ArbGasInfo` is at `0x000000000000000000000000000000000000006c`; the tuple names below follow the [official interface](https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbGasInfo.sol).

| Measurement | Captured value |
| --- | --- |
| Capture started | `2026-09-21T16:10:46.391Z` |
| Block number / timestamp | `68929980` / `1790007046` |
| Block hash | `0x6eb23b6d1636f2f4ce318b5fa5773dc9714211b227d8f05963d158b4e1c17d01` |
| Block base fee | `52,798,000 wei/gas`, or `0.052798 gwei` |
| `getMinimumGasPrice()` | `20,000,000 wei/gas`, or `0.02 gwei` |
| `getL1BaseFeeEstimate()` | `0` |
| `getPricesInWei()` | `[0, 0, 1055960000000, 20000000, 32798000, 52798000]` |
| Tuple interpretation | per L2 transaction; per L1 calldata byte; per storage allocation; base; congestion; total per ArbGas |
| Canonical hash recheck | matched |

The observed parent-price fields are zero, not unavailable. They do **not** establish that parent costs will remain zero. Use the measured `0.02 gwei` floor rather than importing a historical Arbitrum minimum. Base fee `0.052798 gwei` is a dated scenario input, not a long-term budget cap or a completed Domino execution quote.

The [Coinbase Exchange ETH-USD ticker](https://api.exchange.coinbase.com/products/ETH-USD/ticker) returned `price=2748.79`, `bid=2748.79`, `ask=2748.8`, trade ID `844520101`, trade time `2026-09-21T16:10:47.868047798Z`; retrieval completed at `2026-09-21T16:10:48.068Z`. It is a timestamped USD reference for arithmetic, not a current guaranteed conversion price, evidence that USDG equals USD, or a qualified input for DominoPriceGuard. [Ticker semantics](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker).

## Provider qualification

| Provider | Mainnet 4663 evidence | What remains unqualified |
| --- | --- | --- |
| Alchemy | Its wallet matrix explicitly lists Robinhood Mainnet separately from testnet, with bundler, gas sponsorship, ERC-20 gas and Bundler Sponsored Operations (BSO). [Official matrix](https://www.alchemy.com/docs/wallets/supported-chains) | Project entitlement, policy configuration, exact account and EntryPoint combination, live operation estimate, commercial fee schedule and service commitment. No authenticated account was accessed. |
| Pimlico | Official chain page lists Robinhood `4663` / slug `robinhood`. Public mainnet bundler read returned four EntryPoints; see below. [Official support matrix](https://docs.pimlico.io/guides/supported-chains) | Domino's chosen account/version, project access, sponsorship policy, final quote and production service agreement. No sponsorship or send method was invoked. |
| ZeroDev | Official status API defines its chain inventory as bundler support. `GET https://status-api.zerodev.app/uptime` returned HTTP 200 at `2026-09-21T16:16:05.023Z`, including `{networkId:"4663",networkName:"Network_4663"}` and testnet `46630` separately. [Status API semantics](https://docs.zerodev.app/api-and-toolings/tools/status) | Project paymaster availability, account/EntryPoint versions, commercial terms and an operational endpoint for this application. Inventory presence alone proves none of those. |

ZeroDev's manually maintained [chain FAQ](https://docs.zerodev.app/api-and-toolings/faqs/chains) did not list Robinhood when inspected, but warns that it can be incomplete. The live inventory is stronger evidence than that omission. Its separate [smart-routing/onramp list](https://docs.zerodev.app/onramp/smart-routing-address/supported-chains) includes Robinhood for v1; that product listing is not a paymaster entitlement. No claim that ZeroDev is unsupported follows from the FAQ.

### Pimlico EntryPoint and token evidence

Pimlico's mainnet matrix marks bundler and paymaster support for EntryPoints v0.6, v0.7 and v0.8; v0.9 has bundler support but no paymaster check. Account versions have their own matrix: support for an EntryPoint does not imply support for every Kernel, Safe or Light account version. Robinhood is also marked for EIP-7702. [Version matrix](https://docs.pimlico.io/guides/supported-chains).

Read-only `eth_supportedEntryPoints` at `https://public.pimlico.io/v2/4663/rpc` returned the following four addresses. The official Robinhood RPC returned nonempty code at all four in the pinned block above. These hashes record presence; they are **not independently reconstructed or audited EntryPoint provenance pins**.

| Version | Address | Bytes | Observed runtime keccak256 |
| --- | --- | ---: | --- |
| 0.6 | `0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789` | 23689 | `0xc93c806e738300b5357ecdc2e971d6438d34d8e4e17b99b758b1f9cac91c8e70` |
| 0.7 | `0x0000000071727de22e5e9d8baf0edac6f37da032` | 16035 | `0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58` |
| 0.8 | `0x4337084d9e255ff0702461cf8895ce9e3b5ff108` | 21738 | `0xa4b1c865a4a45b99ebaaf4bd06e0036ad489eb521786f59765e4e6a3c0524b03` |
| 0.9 | `0x433709009b8330fda32311df1c2afa402ed8d009` | 22425 | `0x9cfce1fd999cc13670ec0579b34f6f10f8ef0d1e9f732de3c7726e4e14c72c09` |

The same public bundler returned a standard gas quote of `maxFeePerGas=0x4065348` and `maxPriorityFeePerGas=0x526d1`. These are operation fee-cap suggestions, not settlement costs. The endpoint is unauthenticated, limited to 20 requests/minute/IP, and does not provide public mainnet paymaster access. [Public endpoint documentation](https://docs.pimlico.io/references/bundler/public-endpoint).

Pimlico explicitly lists Robinhood **USDG**, `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, in its ERC-20 token detail. However, the same page's universal-access summary does not include this pair, and the PAYG pricing summary lists a narrower default token set. Therefore technical listing is confirmed; default account entitlement, enabled token quote and commercial terms are not. Do not label it unsupported, free, or immediately usable without confirmation. [Supported tokens](https://docs.pimlico.io/references/paymaster/erc20-paymaster/supported-tokens).

## Cost and treasury implications

Pimlico's PAYG mainnet plan requires a card, has no subscription charge, and includes 10 million monthly API credits, then $1 per 100,000 credits. Its illustrative sponsored operation uses about 1,050 credits: roughly 9,500 included operations, then approximately **$0.0105 per operation** for API usage, dependent on actual calls and polling. The verifying-paymaster charge is **10% above EntryPoint `actualGasCost`**. Thus `sponsorshipCharge = 1.10 × actualGasCost`, with API charges separate. It manages paymaster funding and invoices usage; this does not make gas free. PAYG has no SLA; enterprise terms are custom. These terms do not establish USDG access under the default plan. [Pimlico pricing](https://docs.pimlico.io/guides/pricing).

Alchemy supports USD-billed sponsorship with configurable policies and spending limits. [Sponsorship overview](https://www.alchemy.com/docs/wallets/transactions/sponsor-gas/overview). Its BSO product sponsors at the bundler level without an onchain paymaster, supports eligible sponsorship chains including Robinhood, and requires a policy and sufficient credits. Documented `eth_sendUserOperation` usage is 3,000 compute units with BSO versus 1,000 without. BSO billing is settlement cost **plus a service fee**; the examined page gives no numeric rate. Budget that fee as unknown, not zero. Automatic retries require explicit spend limits and careful reconciliation with Domino's intent deadlines. [BSO documentation](https://www.alchemy.com/docs/wallets/transactions/sponsor-gas/bundler-sponsored-operations).

For planning, use:

`AA recurring cost = network cost of complete UserOperations + provider surcharge + API usage + failed/retried operations + any treasury conversion cost + operations overhead`.

Smart-account deployment, account validation, EntryPoint execution and paymaster processing can add gas; batching or BSO can remove some costs. The net difference is unknown until the actual account/version and exact Domino call are estimated. Do not apply the 10% example to bare Domino EVM gas and call the result a sponsored-operation quote. A treasury-paid USDG paymaster would move payment into a treasury-owned token balance with provider conversion/markup and allowance risks; it would not authorize charging user vault principal or changing the existing service fee.

Both sponsorship and native-ETH funding still need treasury working capital. Sponsorship exchanges some onchain ETH refills for provider limits, billing and availability. Independent publisher activity, deployment, owner administration and recovery may still require ETH even after operator execution is sponsored. Full numerical scenarios belong in the accompanying economics study; the inputs above are dated evidence rather than forecasts.

## Concrete Domino compatibility work

The following conclusions come from the cited application baseline, not provider marketing:

1. **Change admission deliberately.** `scripts/prepare-financial-release.mjs:227-228` rejects nonempty code for deployer, operator, current publisher and guardian. Publisher re-admission still enforces a plain EOA. An account contract needs a new explicit admitted profile binding implementation, owner, upgrade/delegation authority, EntryPoint and provider assumptions. Keep operator/publisher independence. Preserve the eight original deployment transactions and constructor bindings; changing execution transport does not replace their proof.
2. **Build a UserOperation signer and policy boundary.** `backend/execution_signer.py:118-140` derives the acting address from a private key; `:197-222` simulates a direct vault call, budgets native ETH and emits a type-2 transaction addressed to the vault. A UserOperation needs account-call encoding, account and EntryPoint nonces, validation and sponsorship fields, new estimation, replacement handling and separate cost caps. A provider's automatic retry must never silently extend the authorized plan or rebuild a different intent.
3. **Extend receipt proof rather than skipping it.** `backend/execution_v4.py:252-261` requires the outer transaction and receipt to target the vault with exact plan calldata; `:340` checks its sender against owner/operator authority. A normal ERC-4337 bundle instead has a bundler sender and EntryPoint destination. New reconciliation must bind the UserOperation hash, admitted account, inner call, exact plan and matching events; isolate the operation from other bundled operations; preserve canonical/finality and source-state checks; and attribute its own gas and sponsor cost. Current `:307-313` deliberately leaves full L2 cost unqualified. The entire bundle receipt gas must not be charged to one vault operation.
4. **Qualify authorization at each vault.** `contracts/src/DominoVaultV4.sol:276-277` checks `msg.sender`. `:410-416` lets an owner set a new nonzero operator and advances state/authority generation; it does not forbid contract accounts. A qualified smart-account operator could therefore use the existing vault interface after owner authorization, but current admission and backend flows need migration. Existing plans become stale. A generic relayer cannot preserve the old EOA sender merely by paying for a forwarded call.
5. **Keep publisher migration independent.** Sponsoring only the operator can leave the price publisher as a separately funded EOA. Migrating publisher authority adds its own profile, rotation and submission work; sponsorship does not supply trustworthy prices. Neither treasury tooling nor a paymaster may collapse the existing role-separation policy.

EIP-7702 is not an escape from the release's EOA restriction: it assigns a delegation designator (`0xef0100` plus the delegate address) as account code, so current `eth_getCode == 0x` admission rejects a delegated account. Keeping an address does not preserve plain-EOA trust assumptions. Delegate implementation, upgrades and authorization need explicit qualification. [EIP-7702 specification](https://eips.ethereum.org/EIPS/eip-7702).

## Bounded recommendation and remaining evidence

Use treasury-funded EOAs for the present release. Treat sponsorship as an optional next project if avoiding native refills, enforcing provider spend policies or batching produces enough operational value. The current evidence is sufficient to shortlist **Alchemy and Pimlico**, with **ZeroDev** requiring more project-level qualification. It is not sufficient to select the cheapest production provider or promise availability.

An engineering estimate, **not a measured delivery commitment**, is 3–5 engineer-days for a local/provider-estimation prototype, then 2–4 engineer-weeks for one production-quality operator path, new admission and receipt proof, retry/failure handling and tests. Independent review, provider onboarding, external delays and a separate publisher migration are additional. A custom paymaster or new account implementation would materially expand scope.

Before any future production enablement, select and verify the account/EntryPoint versions, obtain exact mainnet commercial terms, estimate representative complete UserOperations, demonstrate receipt isolation and stale-plan rejection, preserve recovery access, and qualify provider limits/outage behavior. This study performed public reads only; it does not claim a successful sponsored Domino transaction, account source verification, commercial entitlement, or provider SLA.
