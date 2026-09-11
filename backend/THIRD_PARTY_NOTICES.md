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
