// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroTestSetup} from "./shared/NitroTestSetup.sol";

import {DominoVaultReadHelper} from "../src/DominoVaultReadHelper.sol";
import {DominoVaultTypes as T} from "../src/DominoVaultTypes.sol";
import {DominoExecutionTypes as E} from "../src/DominoExecutionTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {MockPoolManager, MockPositionManager, MockStateView, MockERC20} from "./E2Mocks.sol";
import {VaultV4TestHarness, StubEngineV4} from "./DominoVaultV4Custody.t.sol";

interface VmInvariant {
    function deal(address account, uint256 balance) external;
    function chainId(uint256 chain) external;
}

/**
 * The owner of one V4 vault, driven by the fuzzer.
 *
 * Every action an owner or the engine can take against the custody ledger,
 * with arguments bounded so that most calls succeed and the rest revert
 * harmlessly: credits through the harness sinks, converted credits, reserve
 * withdrawals, donations the ledger must not see, untracked recovery,
 * successor mints through the real executionMint, and child exits. The
 * handler keeps the ghost state the invariants are checked against - every
 * source it has seen, every child, and the highest state nonce observed.
 */
contract CustodyHandler {
    VmInvariant private constant vm = VmInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public constant OPERATOR = address(0xB0B);
    address public constant RECIPIENT = address(0xFEE);

    MockPoolManager public poolManager;
    MockPositionManager public positions;
    MockStateView public stateView;
    DominoVaultReadHelper public readHelper;
    StubEngineV4 public engine;
    MockERC20 public token;
    VaultV4TestHarness public vault;
    T.PoolKey public key;

    uint256[] public members;        // root and every child ever minted
    bytes32[] public sources;        // every source id ever registered
    mapping(uint256 => bool) public everWithdrawn;
    uint64 public highestNonce;
    uint256 public calls;
    // Successes per action, so a run that only ever reverted cannot pass quietly.
    uint256 public credits; uint256 public conversions; uint256 public withdrawals; uint256 public donations;
    uint256 public recoveries; uint256 public mints; uint256 public exits;

    constructor() {
        NitroTestSetup.install();
        poolManager = new MockPoolManager();
        positions = new MockPositionManager(address(poolManager));
        stateView = new MockStateView(address(poolManager), positions);
        readHelper = new DominoVaultReadHelper(address(positions), address(stateView));
        engine = new StubEngineV4(address(this));
        token = new MockERC20();
        key = T.PoolKey(address(0), address(token), 3000, 60, address(0));
        positions.mint(address(this), 11, key, -600, 600, 1000);
        VaultV4TestHarness implementation = new VaultV4TestHarness(address(this), address(poolManager),
            address(positions), address(stateView), RECIPIENT, address(readHelper), address(engine));
        bytes memory creation = abi.encodePacked(hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73",
            address(implementation), hex"5af43d82803e903d91602b57fd5bf3");
        address clone;
        assembly ("memory-safe") { clone := create(0, add(creation, 32), mload(creation)) }
        require(clone != address(0), "clone deployment failed");
        vault = VaultV4TestHarness(payable(clone));
        positions.approve(clone, 11);
        T.InitParams memory params = T.InitParams({
            rootTokenId: 11, expectedPoolId: keccak256(abi.encode(key)), baseCurrency: key.currency0,
            quoteCurrency: key.currency1, operator: OPERATOR, consentToUncollectedFees: true,
            policy: IDominoVaultDraft.Policy(400, 500, 1000, 1, 4, 1, false),
            limits: T.ExecutionLimits(1, 5000, 100, 100, 1 ether, 60, 3600)
        });
        vault.initialize(address(this), keccak256("invariant sequence"), params);
        _track(11);
        highestNonce = vault.stateNonce();
    }

    receive() external payable {}

    function _track(uint256 id) private {
        members.push(id);
        T.Position memory p = vault.position(id);
        sources.push(p.source0);
        sources.push(p.source1);
    }

    function _note() private {
        calls++;
        uint64 nonce = vault.stateNonce();
        if (nonce > highestNonce) highestNonce = nonce;
    }

    function _fund(address currency, uint256 amount) private {
        if (currency == address(0)) vm.deal(address(vault), address(vault).balance + amount);
        else token.mint(address(vault), amount);
    }

    function _member(uint256 seed) private view returns (uint256) {
        return members[seed % members.length];
    }

    function memberCount() external view returns (uint256) { return members.length; }
    function sourceCount() external view returns (uint256) { return sources.length; }

    // ------------------------------------------------------------ actions

    /// A credit the engine would make, backed by real balance.
    function credit(uint256 seed, uint128 amount0, uint128 amount1) external {
        amount0 = uint128(bound(amount0, 0, 1e24)); amount1 = uint128(bound(amount1, 0, 1e24));
        uint256 id = _member(seed);
        if (!vault.position(id).active) return;
        _fund(key.currency0, amount0); _fund(key.currency1, amount1);
        try vault.creditOriginal(id, amount0, amount1) { credits++; } catch {}
        _note();
    }

    /// A converted (charged-class) credit under an existing source.
    function creditConverted(uint256 seed, uint128 amount, bool second) external {
        amount = uint128(bound(amount, 0, 1e24));
        uint256 id = _member(seed);
        T.Position memory p = vault.position(id);
        (bytes32 source, address currency) = second ? (p.source1, key.currency1) : (p.source0, key.currency0);
        _fund(currency, amount);
        try vault.creditConverted(source, currency, amount) { conversions++; } catch {}
        _note();
    }

    /// The owner takes from a reserve, within what the ledger says is there.
    function withdraw(uint256 seed, uint128 original, uint128 charged, bool second) external {
        uint256 id = _member(seed);
        T.Position memory p = vault.position(id);
        (bytes32 source, address currency) = second ? (p.source1, key.currency1) : (p.source0, key.currency0);
        T.FeeBalance memory b = vault.feeBalance(source, currency);
        original = uint128(bound(original, 0, b.original)); charged = uint128(bound(charged, 0, b.charged));
        try vault.withdrawFeeReserves(source, currency, original, charged) { withdrawals++; } catch {}
        _note();
    }

    /// Value the ledger must never see: a plain transfer into the vault.
    function donate(uint128 amount, bool second) external {
        amount = uint128(bound(amount, 0, 1e24));
        _fund(second ? key.currency1 : key.currency0, amount);
        donations++;
        _note();
    }

    /// The owner recovers untracked surplus, up to what the ledger allows.
    function recover(uint128 amount, bool second) external {
        address currency = second ? key.currency1 : key.currency0;
        uint256 held = currency == address(0) ? address(vault).balance : token.balanceOf(address(vault));
        uint256 accounted = vault.accountedCurrency(currency);
        if (held <= accounted) return;
        amount = uint128(bound(amount, 1, held - accounted));
        try vault.recoverUntrackedCurrency(currency, amount) { recoveries++; } catch {}
        _note();
    }

    /// A successor of a member, through the real executionMint.
    function mintChild(uint256 seed, uint128 liquidity) external {
        liquidity = uint128(bound(liquidity, 1, 1e9));
        uint256 parent = _member(seed);
        if (!vault.position(parent).active || vault.successorOf(parent) != 0 || vault.activePositions() >= 4
            || !vault.rootPermissionValid() || vault.policy().paused) return;
        uint256 id = positions.nextTokenId();
        E.Plan memory plan;
        plan.action = E.MINT;
        plan.authority.tokenId = parent;
        plan.authority.intentId = keccak256(abi.encode("child", id, parent, calls));
        engine.armMint(parent, -300, 900, liquidity);
        poolManager.setUnlocked(true);
        try vault.execute(plan) { _track(id); mints++; } catch {}
        poolManager.setUnlocked(false);
        _note();
    }

    /// The owner's managed exit for a child.
    function withdrawChild(uint256 seed) external {
        uint256 id = _member(seed);
        T.Position memory p = vault.position(id);
        if (!p.active || p.isRoot) return;
        try vault.withdrawChildPosition(id) { everWithdrawn[id] = true; exits++; } catch {}
        _note();
    }

    function bound(uint256 x, uint256 low, uint256 high) internal pure returns (uint256) {
        if (low > high) return low;
        if (x >= low && x <= high) return x;
        return low + (x % (high - low + 1));
    }
}

/**
 * What must hold after any sequence of the owner's and the engine's moves on
 * a V4 vault: the currency ledger sums to what the sources say, every tracked
 * unit is backed by balance, the active count is the count of active
 * members, the state nonce only ever grows, and a withdrawn child never
 * comes back. Donations are the adversarial input - value the ledger must
 * not absorb - and untracked recovery must never reach below it.
 */
contract DominoVaultV4InvariantsTest {
    CustodyHandler private handler;
    VaultV4TestHarness private vault;

    function setUp() public {
        handler = new CustodyHandler();
        vault = handler.vault();
    }

    /// Forge reads this to know what the fuzzer may call: the handler only.
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function _currency(bool second) private view returns (address) {
        (address c0, address c1,,,) = handler.key();
        return second ? c1 : c0;
    }

    /// The handler is only evidence if its actions reach the vault. A scripted
    /// pass through every action, asserting each one succeeded at least once.
    function testTheHandlerReachesEveryAction() public {
        handler.credit(0, 1e18, 2e18);
        handler.creditConverted(0, 5e17, true);
        handler.withdraw(0, 1e17, 0, false);
        handler.donate(1e18, false);
        handler.recover(1e17, false);
        handler.mintChild(0, 1e6);
        handler.withdrawChild(1);
        require(handler.credits() == 1 && handler.conversions() == 1 && handler.withdrawals() == 1
            && handler.donations() == 1 && handler.recoveries() == 1, "a ledger action never reached the vault");
        require(handler.mints() == 1 && handler.exits() == 1 && handler.memberCount() == 2, "the child path never reached the vault");
        invariant_theCurrencyLedgerIsTheSumOfItsSources();
        invariant_everyTrackedUnitIsBackedByBalance();
        invariant_activePositionsCountsTheActiveMembers();
        invariant_theStateNonceOnlyGrows();
        invariant_aWithdrawnChildNeverComesBack();
    }

    function invariant_theCurrencyLedgerIsTheSumOfItsSources() public view {
        for (uint256 side; side < 2; ++side) {
            address currency = _currency(side == 1);
            uint256 total;
            for (uint256 i; i < handler.sourceCount(); ++i) {
                T.FeeBalance memory b = vault.feeBalance(handler.sources(i), currency);
                total += uint256(b.original) + b.charged;
            }
            require(vault.accountedCurrency(currency) == total, "ledger and sources disagree");
        }
    }

    function invariant_everyTrackedUnitIsBackedByBalance() public view {
        (address c0, address c1,,,) = handler.key();
        require(address(vault).balance >= vault.accountedCurrency(c0), "native reserve unbacked");
        require(handler.token().balanceOf(address(vault)) >= vault.accountedCurrency(c1), "token reserve unbacked");
    }

    function invariant_activePositionsCountsTheActiveMembers() public view {
        uint256 active;
        for (uint256 i; i < handler.memberCount(); ++i) {
            if (vault.position(handler.members(i)).active) ++active;
        }
        require(vault.activePositions() == active, "active count drifted");
    }

    function invariant_theStateNonceOnlyGrows() public view {
        require(vault.stateNonce() == handler.highestNonce() && vault.stateNonce() < type(uint64).max, "nonce moved backwards");
    }

    function invariant_aWithdrawnChildNeverComesBack() public view {
        for (uint256 i; i < handler.memberCount(); ++i) {
            uint256 id = handler.members(i);
            if (handler.everWithdrawn(id)) require(!vault.position(id).active, "a withdrawn child is active again");
        }
    }
}
