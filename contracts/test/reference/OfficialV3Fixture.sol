// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IOfficialV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96,
        bytes calldata data) external returns (int256 amount0, int256 amount1);
}

interface IOfficialV3Token {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice TEST ONLY. Swaps an exact input on a v3 pool and pays it from its own balance in the callback.
/// No Domino policy, fee ledger, economic gate or deployment eligibility is supplied.
contract OfficialV3SwapDriver {
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    address public immutable owner;
    address private pending;

    constructor() { owner = msg.sender; }

    function swap(address pool, bool zeroForOne, uint256 amountIn) external {
        require(msg.sender == owner, "fixture swap owner");
        pending = pool;
        IOfficialV3Pool(pool).swap(address(this), zeroForOne, int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, "");
        pending = address(0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == pending, "fixture swap callback");
        IOfficialV3Pool pool = IOfficialV3Pool(msg.sender);
        if (amount0Delta > 0) require(IOfficialV3Token(pool.token0()).transfer(msg.sender, uint256(amount0Delta)));
        if (amount1Delta > 0) require(IOfficialV3Token(pool.token1()).transfer(msg.sender, uint256(amount1Delta)));
    }
}
