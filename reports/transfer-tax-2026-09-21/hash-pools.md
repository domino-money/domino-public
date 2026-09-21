# HASH: pool-specific trading fees

Read-only qualification, 21 September 2026. Requested token: Robinhood Chain 4663, `0xca75082b85bb7bec8325d513f615b16bda260020` (HASHCATS / HASH). **Two ETH/HASH pools were confirmed. Neither observation establishes a 3% ERC-20 transfer tax.** The hooked pool's observed trading charge is 5%; the second pool is hookless and has a 2.098% combined Uniswap swap fee at the captured block.

The own-node snapshot is block **69,029,709**, hash `0xfc39a8ef84fb3a7dc256bb52cd14c5728c70ac53419d2a321a6b1c22f31c8425`, timestamp `2026-09-21T18:57:11Z`. State calls used EIP-1898 with `requireCanonical: true`; the block hash was rechecked afterward. This is a pinned canonical latest snapshot, not a finalized qualification or a promise of future fees.

## Confirmed pools

Both pools use PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`, currency0 `0x0000000000000000000000000000000000000000` (**native ETH**, not WETH), and currency1 the requested HASH address.

| Property | Project-declared pool | Other pool observed in a real swap |
|---|---|---|
| Pool ID | `0x42b009f327076bc462dc1725c29221938f8f96307f356121a8445b889d036ea7` | `0x4f746505d7ade28eb64160e1a0a30da02e00c4c5c3e4fb70b037f69e279a847e` |
| Hook | `0xca757986e932bc55776492cca0b413e9b3d02acc` | zero address |
| PoolKey fee | 0 | 20,000 pips = 2% |
| Tick spacing | 60 | 200 |
| Current core LP fee | 0 | 20,000 pips = 2% |
| Current core protocol fee, each direction | 0 | 1,000 pips = 0.1% |
| Combined core swap fee, each direction | 0 | 20,980 pips = **2.098%** |
| Separate hook charge | **500 bps = 5%**, observed on the ETH leg | none |
| Active liquidity, raw units | 2,236,067,977,499,789,696,409 | 126,890,329,650,623,350,543 |
| Domino implication | Nonzero hook is rejected | Passes this pool's hook/native-currency structural checks; full position/route qualification still required |

Uniswap pool fees use a denominator of **1,000,000**; the hook's observed basis points use **10,000**. The protocol fee acts before the LP fee: `1000 + 20000 - floor(1000 * 20000 / 1000000) = 20980`, rather than adding percentages directly. This matches the 20,980 fee in the actual PoolManager `Swap` event and the vendored official [`ProtocolFeeLibrary.calculateSwapFee`](https://github.com/Uniswap/v4-core/blob/main/src/libraries/ProtocolFeeLibrary.sol). These figures exclude price impact, gas and any additional fee from a particular router or multi-pool route.

The collection candidate discovered through the [project website](https://hashcats.fun/) ecosystem was `0xca75df55cc9c476db27a7375d1fc8e794cf80721`. Own-node calls confirmed `collection.hashToken()` equals the requested token and `collection.hook()` equals the nonzero hook above. The hook's `key()` returned its PoolKey, and its computed pool ID had initialized PoolManager state and nonzero liquidity. The second PoolKey was extracted as a candidate from packed transaction calldata; its ABI-encoded keccak256 exactly equals the other pool ID emitted by the official PoolManager in the same transaction. Independent PoolManager storage reads confirmed its initialized state, fees and liquidity. This does not rely on a catalogue's pool label.

## The 5% charge is supported by actual receipts

The [project-delivered ABI asset](https://hashcats.fun/assets/params-B8MSnpYK.js) declares `currentFee()`, `feeBps()` and `FeeTaken(bool buying,uint256 amount)`. The pinned reads returned `currentFee=500`, `feeBps=500`, `FEE_DEFAULT=250`, `FEE_MAX=500`, `FEE_MIN=6`, `DECAY_FEE_MAX=5000`, `DECAY_WINDOW=600`, and a past `decayEndsAt`. These getters alone are not proof of every hook branch or a permanent fee cap. In particular, the [project statistics page](https://stats.hashcats.fun/) search snapshot described 2.50%; that is not the captured current rate.

Two historical mainnet receipts provide direct incidence evidence using the official project's event ABI:

| Direction | Core ETH leg | Hook `FeeTaken`, wei | Observed calculation |
|---|---:|---:|---|
| Sell HASH | 829,915,569,117,650,711 wei ETH output | 41,495,778,455,882,536 | `ceil(core ETH output × 500 / 10000)` |
| Buy HASH | 20,121,900,839,464,030 wei ETH consumed by core | 1,059,047,412,603,370 | `ceil((core ETH input + hook fee) × 500 / 10000)` |

Sell transaction: [`0x05ec1def88411b9fe8a00d2396d4505fa45b22a262330577005dd57902ce578f`](https://robinhoodchain.blockscout.com/tx/0x05ec1def88411b9fe8a00d2396d4505fa45b22a262330577005dd57902ce578f), block 68,979,840. PoolManager swap log 16 precedes hook fee log 17. A later swap log 19 belongs to the hook's separately emitted `BoughtAndBurned` operation; it is not used as the sell fee basis.

Buy transaction: [`0xfad65a42b7961d17ae9dfe2f9648955b457ada65411b5e4e870e1761d07e2d59`](https://robinhoodchain.blockscout.com/tx/0xfad65a42b7961d17ae9dfe2f9648955b457ada65411b5e4e870e1761d07e2d59), block 68,979,841. The hookless pool's swap is log 12; the hooked pool's buy is log 13 and its hook fee log 14. Gross ETH attributable to the hooked buy is 21,180,948,252,067,400 wei. In both examples the observed rounding matches a ceiling, not a floor. This receipt evidence does not assert that exact-input, exact-output, privileged, buyback and all other branches have identical rules.

## Compatibility and limits

The existing [`TOKEN_READS.json`](TOKEN_READS.json) separately records token runtime/source qualification; the root's token-transfer replay is also separate. A pool hook charge is not evidence of a haircut on a wallet-to-wallet token transfer. HASH should **not** be rejected globally because its project-declared pool has a hook.

At this checkout, `DominoVaultReadHelper.sol:93` and `DominoRoutingHelperV4.sol:154` reject nonzero hooks. The project-declared pool therefore cannot be used by current Domino. Native ETH itself is accepted by the current read/setup validation. The second, hookless pool satisfies those particular structural properties, but this note does not qualify an NFT's permission, range, liquidity, price guard, execution plan, token behavior on every route, or economic eligibility. Zero core LP fees in the hooked pool also must not be represented as 5% fees earned by ordinary LP accounting; the 5% goes through the hook's distinct mechanism.

Hook implementation source could not be retrieved: Sourcify returned HTTP 404 and the Blockscout smart-contract API returned HTTP 403. The captured hook runtime is 17,821 bytes, keccak256 `0x1268af223335991f027d39baa16dc862e39469916d4dd99d0bd69c9f55effdf5`. Its full control logic, fee changes and privileged exemptions remain **unqualified**; no source-verification claim is made for that hook. A nonzero `owner()` was observed. The source failure is preserved explicitly rather than interpreted as a zero fee.

This is a bounded two-pool discovery, not an exhaustive inventory. Three address-and-event-filtered windows covered 60,000 recent blocks and found three hook fee events; discovery stopped after one buy and one sell. No chain-wide scan was performed. The final run made 28 serial RPC calls, with at least 0.3 seconds after every preceding call; all methods were read-only. No private configuration, credentials, transaction signing, chain writes or Forge compilation were used.

## Reproduction and preserved records

Run `backend/.venv/bin/python reports/transfer-tax-2026-09-21/hash-read-pools.py` from the repository, with the already configured own-node SSH alias. It pins a fresh block and may produce changed point-in-time fees. The script explicitly limits event queries to 20,000 blocks per query and at most five windows. Do not infer completeness from an empty window.

- [`hash-pool-reads.json`](hash-pool-reads.json): exact RPC requests/responses, current state, raw code, event receipts and integer calculations; source unavailability is explicit.
- [`hash-pool-buy-transaction.json`](hash-pool-buy-transaction.json): read-only transaction lookup containing the packed second-pool candidate.
- [`hash-hook-project-abi.json`](hash-hook-project-abi.json): ABI extracted as data from the official project frontend, without executing its JavaScript.
- [`hash-discovery.json`](hash-discovery.json): public source URLs, ABI asset/extracted-file SHA256s and unavailable source endpoints.
- [`hash-read-pools.py`](hash-read-pools.py): bounded read-only reproducer, whose SHA256 matches the final raw record.

Pure local checks passed: script SHA linkage, canonicality flag, two receipt fee calculations using integers, permitted-method inventory, second-pool fee arithmetic. No broad test suite was needed for these read-only records.
