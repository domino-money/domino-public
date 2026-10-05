# Reference arithmetic and test sources

`v4_math.py` adapts the MIT-licensed TickMath, SqrtPriceMath and SwapMath integer
arithmetic from Uniswap v4-core, pinned to commit
`46c6834698c48bc4a463a86d8420f4eb1d7f3b75`. Copyright 2023 Universal Navigation Inc.
The complete [MIT notice](tests/reference/v4/MIT_LICENSE) is retained.

The original files under `tests/reference/v4` are pinned differential-test
dependencies only, identified by SHA-256 in `provenance.json`. Individual SPDX
identifiers govern those files. Pool, Position and LiquidityMath retain their
BUSL-1.1 notices and the complete [license](tests/reference/v4/BUSL_LICENSE).
They are compiled solely into a temporary local EVM test harness, with no fork,
public deployment or runtime backend dependency. They are excluded from the
backend's runtime import path and do not form the product vault implementation.

Source: [Uniswap v4-core at the pinned revision](https://github.com/Uniswap/v4-core/tree/46c6834698c48bc4a463a86d8420f4eb1d7f3b75).

## Wallet-session dependencies

The disabled session backend imports the official `siwe` package 4.4.0 for its
ABNF parser/serializer and `eth-account` 0.13.7 for local EIP-191 recovery; their
upstream packages retain their license notices. No SIWE or recovery source is
vendored. `abnf` is pinned to 2.2.0 for tested SIWE grammar compatibility. The
complete transitive installation is pinned in `requirements-api.lock` and the
synthetic tests assert the selected versions. This documents dependency use,
not an external audit or a claim of contract-wallet support.

Sources: [Spruce SIWE Python](https://github.com/spruceid/siwe-py),
[Ethereum eth-account](https://github.com/ethereum/eth-account).

## The Uniswap Labs Default token list

`data/token-lists/uniswap-default.json` is a subset of the Uniswap Labs Default token list
(<https://tokens.uniswap.org>, version 22.24.0 of 2026-10-01): the Base and Arbitrum One entries' address,
symbol, name and decimals, which read-v6's `chain-tokens` searches (`v2_chain_reads.py`; the owner's decision of
5 Oct 2026). The list is published under the GNU General Public License v3.0 by
[Uniswap/default-token-list](https://github.com/Uniswap/default-token-list); its complete
[license](data/token-lists/LICENSE-uniswap-default-token-list) is retained beside the subset, and the subset
records its source, version, timestamp and the SHA-256 of the exact bytes read.
`scripts/update-uniswap-token-list.py` regenerates it. Symbols and names are served as untrusted text.

