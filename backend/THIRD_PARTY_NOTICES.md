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
