// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";

/// @dev Synthetic test doubles for the V2 vault suites. None of them is
/// evidence about a real token, pool or manager; the behaviour the vault relies
/// on is modelled on the deployed Uniswap contracts as docs/v2/F0_INTERFACES.md
/// and contracts/src/v2/external describe them.

/// An ERC20 whose transfers to a chosen recipient can misbehave: revert
/// (`blocked`), return false without moving (`falseTo`) or move and return no
/// data at all (`silentTo`, as USDT does).
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    mapping(address => bool) public falseTo;
    mapping(address => bool) public silentTo;
    /// Called during a transfer to this recipient, with this data (reentrancy probe).
    address public hookTo;
    address public hookTarget;
    bytes public hookData;
    bytes public hookResult;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function setFalseTo(address account, bool value) external {
        falseTo[account] = value;
    }

    function setSilentTo(address account, bool value) external {
        silentTo[account] = value;
    }

    function setHook(address to, address target, bytes calldata data) external {
        (hookTo, hookTarget, hookData) = (to, target, data);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        require(!blocked[to], "blocked");
        if (falseTo[to]) return false;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (to == hookTo && hookTarget != address(0)) {
            (, bytes memory result) = hookTarget.call(hookData);
            hookResult = result;
        }
        if (silentTo[to]) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}

/// The registry surface the vault reads.
contract MockRegistry {
    mapping(address => bool) public isOperator;
    mapping(address => uint8) public chargeCurrencyRank;
    bool public automationHalted;
    address public feeRecipient;

    function setOperator(address account, bool allowed) external {
        isOperator[account] = allowed;
    }

    function setRank(address token, uint8 rank) external {
        chargeCurrencyRank[token] = rank;
    }

    function setHalted(bool value) external {
        automationHalted = value;
    }

    function setFeeRecipient(address recipient) external {
        feeRecipient = recipient;
    }
}

/// IDominoPriceAnchor.anchor with a settable answer; it records nothing (the
/// vault calls it as a view), so suites check its arguments with expectCall.
contract MockAnchor {
    error SpotOutsideBand();

    uint160 public anchorPrice = uint160(1 << 96);
    uint160 public spotPrice = uint160(1 << 96);
    bool public outside;

    function set(uint160 anchor_, uint160 spot_) external {
        anchorPrice = anchor_;
        spotPrice = spot_;
    }

    function setOutside(bool value) external {
        outside = value;
    }

    function anchor(DominoV2Types.PoolRef calldata, bytes calldata, uint32, uint16)
        external
        view
        returns (uint160, uint160)
    {
        if (outside) revert SpotOutsideBand();
        return (anchorPrice, spotPrice);
    }
}

contract MockV3Factory {
    mapping(uint24 => int24) public feeAmountTickSpacing;

    constructor() {
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10000] = 200;
    }

    /// A pool address for every enabled tier; the unit model needs no pool.
    function getPool(address token0, address token1, uint24 fee) external view returns (address) {
        if (feeAmountTickSpacing[fee] == 0) return address(0);
        return address(uint160(uint256(keccak256(abi.encode(token0, token1, fee)))));
    }
}

/// The NonfungiblePositionManager surface, v1.0.0 semantics: decrease, collect
/// and burn need the owner or an approval; mint and increase are open and paid
/// by the caller; fees accrue in the pool and reach tokensOwed only when the
/// position is poked; decreased principal waits in tokensOwed until collect.
/// Liquidity costs `unit0`/`unit1` tokens per unit, a flat model of an in-range
/// position that keeps the arithmetic of the suites readable.
contract MockV3PositionManager {
    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 growth0Last;
        uint256 growth1Last;
        uint128 owed0;
        uint128 owed1;
    }

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    address public immutable factory;
    uint256 public unit0 = 1;
    uint256 public unit1 = 1;
    uint256 public nextId = 1;
    mapping(uint256 => Position) internal _positions;
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => address) internal _approved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    /// Fee growth per unit of liquidity inside the position's range, Q128, as
    /// the pool reports it: a poke credits (growth - growthLast) x liquidity /
    /// 2^128 to tokensOwed and moves growthLast, as v3-periphery does.
    mapping(uint256 => uint256) public growth0;
    mapping(uint256 => uint256) public growth1;

    constructor(address factory_) {
        factory = factory_;
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96,
            address,
            address,
            address,
            uint24,
            int24,
            int24,
            uint128,
            uint256,
            uint256,
            uint128,
            uint128
        )
    {
        require(_owners[tokenId] != address(0), "Invalid token ID");
        Position memory p = _positions[tokenId];
        return (
            0,
            _approved[tokenId],
            p.token0,
            p.token1,
            p.fee,
            p.tickLower,
            p.tickUpper,
            p.liquidity,
            p.growth0Last,
            p.growth1Last,
            p.owed0,
            p.owed1
        );
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _owners[tokenId];
        require(owner != address(0), "ERC721: owner query for nonexistent token");
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_owners[tokenId] != address(0), "ERC721: approved query for nonexistent token");
        return _approved[tokenId];
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "ERC721: approve caller is not owner");
        _approved[tokenId] = to;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_isApprovedOrOwner(msg.sender, tokenId), "ERC721: transfer caller is not owner nor approved");
        require(ownerOf(tokenId) == from, "ERC721: transfer of token that is not own");
        _approved[tokenId] = address(0);
        _owners[tokenId] = to;
    }

    /// Test setup: a position minted to `owner` without payment.
    function mintFor(
        address owner,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity
    ) external returns (uint256 tokenId) {
        tokenId = nextId++;
        _owners[tokenId] = owner;
        _positions[tokenId] = Position(token0, token1, fee, tickLower, tickUpper, liquidity, 0, 0, 0, 0);
    }

    /// The pool earned exactly fee0/fee1 for the position at its current
    /// liquidity (growth rounded up, so a poke credits exactly these); the
    /// manager holds the tokens.
    function accrue(uint256 tokenId, uint256 fee0, uint256 fee1) external {
        uint256 liquidity = _positions[tokenId].liquidity;
        if (liquidity == 0) return;
        growth0[tokenId] += ((fee0 << 128) + liquidity - 1) / liquidity;
        growth1[tokenId] += ((fee1 << 128) + liquidity - 1) / liquidity;
    }

    /// Fees accrued since the last poke, as the next poke credits them.
    function pending0(uint256 tokenId) public view returns (uint256) {
        Position storage p = _positions[tokenId];
        return (growth0[tokenId] - p.growth0Last) * p.liquidity >> 128;
    }

    function pending1(uint256 tokenId) public view returns (uint256) {
        Position storage p = _positions[tokenId];
        return (growth1[tokenId] - p.growth1Last) * p.liquidity >> 128;
    }

    /// Test setup: the id the next mint takes.
    function setNextId(uint256 id) external {
        nextId = id;
    }

    /// Test setup: what an owner's decrease would leave in tokensOwed.
    function setOwed(uint256 tokenId, uint128 owed0, uint128 owed1) external {
        _positions[tokenId].owed0 = owed0;
        _positions[tokenId].owed1 = owed1;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        liquidity = _liquidityFor(params.amount0Desired, params.amount1Desired);
        require(liquidity > 0, "mint zero");
        (amount0, amount1) = (liquidity * unit0, liquidity * unit1);
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");
        _pull(params.token0, amount0);
        _pull(params.token1, amount1);
        tokenId = nextId++;
        _owners[tokenId] = params.recipient;
        _positions[tokenId] = Position(
            params.token0, params.token1, params.fee, params.tickLower, params.tickUpper, liquidity, 0, 0, 0, 0
        );
    }

    /// Open to anyone, as on the deployed manager.
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        Position storage p = _positions[params.tokenId];
        require(_owners[params.tokenId] != address(0), "Invalid token ID");
        _poke(params.tokenId);
        liquidity = _liquidityFor(params.amount0Desired, params.amount1Desired);
        (amount0, amount1) = (liquidity * unit0, liquidity * unit1);
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");
        _pull(p.token0, amount0);
        _pull(p.token1, amount1);
        p.liquidity += liquidity;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        require(_isApprovedOrOwner(msg.sender, params.tokenId), "Not approved");
        require(params.liquidity > 0);
        Position storage p = _positions[params.tokenId];
        _poke(params.tokenId);
        p.liquidity -= params.liquidity;
        (amount0, amount1) = (params.liquidity * unit0, params.liquidity * unit1);
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");
        p.owed0 += uint128(amount0);
        p.owed1 += uint128(amount1);
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        require(_isApprovedOrOwner(msg.sender, params.tokenId), "Not approved");
        Position storage p = _positions[params.tokenId];
        _poke(params.tokenId);
        amount0 = params.amount0Max < p.owed0 ? params.amount0Max : p.owed0;
        amount1 = params.amount1Max < p.owed1 ? params.amount1Max : p.owed1;
        p.owed0 -= uint128(amount0);
        p.owed1 -= uint128(amount1);
        if (amount0 != 0) MockToken(p.token0).transfer(params.recipient, amount0);
        if (amount1 != 0) MockToken(p.token1).transfer(params.recipient, amount1);
    }

    function burn(uint256 tokenId) external payable {
        require(_isApprovedOrOwner(msg.sender, tokenId), "Not approved");
        Position storage p = _positions[tokenId];
        require(p.liquidity == 0 && p.owed0 == 0 && p.owed1 == 0, "Not cleared");
        delete _positions[tokenId];
        delete _owners[tokenId];
        delete _approved[tokenId];
    }

    function _liquidityFor(uint256 amount0, uint256 amount1) private view returns (uint128) {
        uint256 l0 = unit0 == 0 ? type(uint128).max : amount0 / unit0;
        uint256 l1 = unit1 == 0 ? type(uint128).max : amount1 / unit1;
        return uint128(l0 < l1 ? l0 : l1);
    }

    function _poke(uint256 tokenId) private {
        Position storage p = _positions[tokenId];
        if (p.liquidity == 0) return;
        p.owed0 += uint128(pending0(tokenId));
        p.owed1 += uint128(pending1(tokenId));
        p.growth0Last = growth0[tokenId];
        p.growth1Last = growth1[tokenId];
    }

    function _pull(address token, uint256 amount) private {
        if (amount != 0) MockToken(token).transferFrom(msg.sender, address(this), amount);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) private view returns (bool) {
        address owner = ownerOf(tokenId);
        return spender == owner || _approved[tokenId] == spender || isApprovedForAll[owner][spender];
    }
}
