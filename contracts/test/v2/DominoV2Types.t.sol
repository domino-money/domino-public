// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2RelayTypes} from "../../src/v2/DominoV2RelayTypes.sol";
import {DominoV2Types} from "../../src/v2/DominoV2Types.sol";
import {DominoV2Goldens} from "./DominoV2Goldens.sol";

/// @notice The F0 EIP-712 freeze: the Solidity hashing must equal what
/// eth_account computes from the exported type definitions (the goldens), and
/// the Permit2 witness must hash to what a wallet signs for the typed data.
contract DominoV2TypesTest {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant OWNER = 0x0000000000000000000000000000000000000B0b;
    address internal constant VERIFIER = 0x000000000000000000000000000000000000d0D0;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 internal constant CHAIN_ID = 4663;

    error Mismatch(string what, bytes32 actual, bytes32 expected);

    function _eq(bytes32 actual, bytes32 expected, string memory what) private pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _pool() private pure returns (DominoV2Types.PoolRef memory) {
        return DominoV2Types.PoolRef({dex: 4, currency0: address(0), currency1: USDG, fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    function _legs() private pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = DominoV2Types.SwapLeg({
            kind: 1,
            router: 0x00000000000000000000000000000000000000AA,
            tokenIn: USDG,
            tokenOut: address(0),
            amountIn: 500000000,
            minAmountOut: 123,
            data: hex"deadbeef"
        });
    }

    function _intent() private pure returns (DominoV2Types.PositionIntent memory) {
        return DominoV2Types.PositionIntent({
            action: DominoV2Types.ACTION_CREATE,
            pool: _pool(),
            tokenId: 0,
            tickLower: -201060,
            tickUpper: -198060,
            minLiquidity: 123456789012345678,
            feeBps: DominoV2Types.FEE_ASSISTED_SWAP_BPS,
            feeToken: USDG,
            routesHash: DominoV2Types.routesHash(_legs()),
            recipient: OWNER,
            nonce: 42,
            deadline: 1790871000
        });
    }

    function _observation() private pure returns (DominoV2Types.PriceObservation memory) {
        return DominoV2Types.PriceObservation({
            pool: _pool(),
            sqrtPriceX96: 4339505179874779672736325173248,
            observedAt: 1790870000,
            validUntil: 1790870060,
            nonce: 7
        });
    }

    function _mandate() private pure returns (DominoV2Types.ExitMandate memory) {
        return DominoV2Types.ExitMandate({
            owner: OWNER,
            vault: 0x000000000000000000000000000000000000cafE,
            tokenId: 3409682,
            triggerBelowSqrtPriceX96: 79228162514264337593543950336,
            triggerAboveSqrtPriceX96: 0,
            receiveMode: DominoV2Types.RECEIVE_CONVERTED,
            convertTo: USDG,
            maxSlippageBps: 100,
            validUntil: 1798646400,
            nonce: 1
        });
    }

    /// F2: a relayed exit with conversion, as the exporter's fixture.
    function _relayed() private pure returns (DominoV2RelayTypes.RelayedPositionAction memory action) {
        DominoV2Types.PositionIntent memory intent = _intent();
        (intent.action, intent.tokenId, intent.minLiquidity, intent.nonce) =
            (DominoV2Types.ACTION_EXIT, 3409682, 0, 77);
        action = DominoV2RelayTypes.RelayedPositionAction({
            intent: intent,
            liquidityToRemove: 123456789012345678,
            amount0MinRemoved: 4200000000000000,
            amount1MinRemoved: 9100000,
            amount0Max: 0,
            amount1Max: 0,
            burn: true
        });
    }

    function testTypehashesMatchTheExportedTypes() public pure {
        _eq(DominoV2Types.POOL_REF_TYPEHASH, DominoV2Goldens.POOL_REF_TYPEHASH, "PoolRef");
        _eq(DominoV2Types.PRICE_OBSERVATION_TYPEHASH, DominoV2Goldens.PRICE_OBSERVATION_TYPEHASH, "PriceObservation");
        _eq(DominoV2Types.POSITION_INTENT_TYPEHASH, DominoV2Goldens.POSITION_INTENT_TYPEHASH, "PositionIntent");
        _eq(DominoV2Types.EXIT_MANDATE_TYPEHASH, DominoV2Goldens.EXIT_MANDATE_TYPEHASH, "ExitMandate");
        _eq(
            DominoV2RelayTypes.RELAYED_POSITION_ACTION_TYPEHASH,
            DominoV2Goldens.RELAYED_POSITION_ACTION_TYPEHASH,
            "RelayedPositionAction"
        );
    }

    /// The relayed typehash is a literal (it saves the zap the concatenation):
    /// it must be the hash of its type string and the referenced types.
    function testRelayedTypehashIsItsTypeString() public pure {
        _eq(
            DominoV2RelayTypes.RELAYED_POSITION_ACTION_TYPEHASH,
            keccak256(
                abi.encodePacked(
                    DominoV2RelayTypes.RELAYED_POSITION_ACTION_TYPE,
                    DominoV2Types.POOL_REF_TYPE,
                    DominoV2Types.POSITION_INTENT_TYPE
                )
            ),
            "RelayedPositionAction from strings"
        );
    }

    function testDomainSeparatorMatches() public pure {
        _eq(DominoV2Types.domainSeparator(CHAIN_ID, VERIFIER), DominoV2Goldens.DOMAIN_SEPARATOR, "domain");
    }

    function testRoutesHashIsTheAbiEncodedLegs() public pure {
        _eq(DominoV2Types.routesHash(_legs()), DominoV2Goldens.ROUTES_HASH, "routesHash");
    }

    function testStructHashesAndDigestsMatchEthAccount() public pure {
        bytes32 separator = DominoV2Types.domainSeparator(CHAIN_ID, VERIFIER);
        _eq(DominoV2Types.hashPoolRef(_pool()), DominoV2Goldens.POOL_REF_STRUCT_HASH, "PoolRef struct");
        _eq(
            DominoV2Types.digest(separator, DominoV2Types.hashPriceObservation(_observation())),
            DominoV2Goldens.PRICE_OBSERVATION_DIGEST,
            "PriceObservation digest"
        );
        _eq(
            DominoV2Types.digest(separator, DominoV2Types.hashPositionIntent(_intent())),
            DominoV2Goldens.POSITION_INTENT_DIGEST,
            "PositionIntent digest"
        );
        _eq(
            DominoV2Types.digest(separator, DominoV2Types.hashExitMandate(_mandate())),
            DominoV2Goldens.EXIT_MANDATE_DIGEST,
            "ExitMandate digest"
        );
        _eq(
            DominoV2Types.digest(separator, DominoV2RelayTypes.hashRelayedPositionAction(_relayed())),
            DominoV2Goldens.RELAYED_POSITION_ACTION_DIGEST,
            "RelayedPositionAction digest"
        );
    }

    /// Permit2's batch witness hashing (PermitHash.hashWithWitness), fed with
    /// our witness type string, must equal the digest of the typed data a
    /// wallet signs for PermitBatchWitnessTransferFrom with a PositionIntent.
    function testPermit2WitnessDigestMatchesTheWalletTypedData() public pure {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,",
                DominoV2Types.PERMIT2_WITNESS_TYPE_STRING
            )
        );
        _eq(typeHash, DominoV2Goldens.PERMIT2_BATCH_WITNESS_TYPEHASH, "Permit2 type");
        bytes32[] memory permissions = new bytes32[](1);
        permissions[0] = keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), USDG, uint256(1000000000)));
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encodePacked(permissions)),
                VERIFIER,
                uint256(99),
                uint256(1790871000),
                DominoV2Types.hashPositionIntent(_intent())
            )
        );
        bytes32 permit2Domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                CHAIN_ID,
                PERMIT2
            )
        );
        _eq(DominoV2Types.digest(permit2Domain, structHash), DominoV2Goldens.PERMIT2_BATCH_WITNESS_DIGEST, "Permit2 digest");
    }

    /// The tariffs are part of the freeze: changing one is a pricing decision.
    function testTariffsAreTheOwnersDecisions() public pure {
        if (
            DominoV2Types.FEE_ASSISTED_SWAP_BPS != 65 || DominoV2Types.FEE_AUTOMATION_SIMPLE_BPS != 200
                || DominoV2Types.FEE_AUTOMATION_DOMINO_BPS != 400 || DominoV2Types.FEE_AUTO_EXIT_BPS != 20
        ) revert Mismatch("tariffs", bytes32(0), bytes32(0));
    }
}
