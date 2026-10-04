// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {DominoAutoExit} from "../../../src/v2/autoexit/DominoAutoExit.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoFeeSettlement} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoV2Goldens} from "../DominoV2Goldens.sol";
import {AutoExitFixture, VmAutoExit} from "./AutoExitFixture.sol";
import {MockERC1271Wallet, MockVault, NativeRefuser} from "./AutoExitMocks.sol";

/// Registration, signatures, revocation and nonces: who can create and end a
/// mandate, and on which terms (#283 S3: explicit, separately signed,
/// revocable by the owner at any time without the operator).
contract DominoAutoExitMandateTest is AutoExitFixture {
    uint256 private constant CURVE_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function _refused(DominoV2Types.ExitMandate memory mandate, bytes memory signature, bytes4 reason) private {
        vm.expectRevert(reason);
        autoExit.registerMandate(mandate, signature);
    }

    function _refusedTerms(DominoV2Types.ExitMandate memory mandate) private {
        _refused(mandate, _sign(mandate, OWNER_KEY), IDominoAutoExit.InvalidMandate.selector);
    }

    // ---------------------------------------------------------- register
    function testAnyoneSubmitsTheOwnersSignedMandate() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        bytes memory signature = _sign(mandate, OWNER_KEY);
        vm.recordLogs();
        vm.prank(STRANGER);
        bytes32 mandateHash = autoExit.registerMandate(mandate, signature);

        _eq(mandateHash, DominoV2Types.hashExitMandate(mandate), "id is the EIP-712 struct hash");
        _eq(autoExit.mandateStatus(mandateHash), 1, "active");
        IDominoAutoExitExtension.MandateRecord memory record = autoExit.mandateOf(mandateHash);
        _eq(record.owner, owner, "owner");
        _eq(record.vault, address(vault), "vault");
        _eq(record.tokenId, TOKEN_ID, "token id");
        _eq(record.triggerBelowSqrtPriceX96, STOP, "below");
        _eq(record.triggerAboveSqrtPriceX96, 0, "above");
        _eq(record.receiveMode, DominoV2Types.RECEIVE_BOTH, "mode");
        _eq(record.convertTo, address(0), "convert to");
        _eq(record.maxSlippageBps, 100, "slippage");
        _eq(record.validUntil, START + 30 days, "valid until");
        _eq(record.status, 1, "record status");
        _true(autoExit.nonceUsed(owner, 1), "nonce consumed");

        VmAutoExit.Log[] memory logs = vm.getRecordedLogs();
        _eq(_count(logs, address(autoExit), IDominoAutoExit.MandateRegistered.selector), 1, "one event");
        VmAutoExit.Log memory log = logs[logs.length - 1];
        _eq(log.topics[1], mandateHash, "event id");
        _eq(log.topics[2], bytes32(uint256(uint160(owner))), "event owner");
        _eq(log.topics[3], bytes32(uint256(uint160(address(vault)))), "event vault");
        (uint256 tokenId, uint64 validUntil) = abi.decode(log.data, (uint256, uint64));
        _eq(tokenId, TOKEN_ID, "event token id");
        _eq(validUntil, START + 30 days, "event validity");
    }

    function testRefusesAnotherKeysSignature() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        _refused(mandate, _sign(mandate, OTHER_KEY), IDominoAutoExitExtension.InvalidSignature.selector);
    }

    function testRefusesASignatureOverOtherTerms() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        bytes memory signature = _sign(mandate, OWNER_KEY);
        mandate.maxSlippageBps = 500;
        _refused(mandate, signature, IDominoAutoExitExtension.InvalidSignature.selector);
    }

    /// (r, n - s, v ^ 1) recovers the same key; only low-s signatures count.
    function testRefusesTheMalleatedTwinOfAValidSignature() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, _digest(mandate));
        bytes memory twin = abi.encodePacked(r, bytes32(CURVE_ORDER - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        _refused(mandate, twin, IDominoAutoExitExtension.InvalidSignature.selector);
        autoExit.registerMandate(mandate, abi.encodePacked(r, s, v));
    }

    function testOwnerMustOwnTheVault() public {
        vault.setOwner(STRANGER);
        DominoV2Types.ExitMandate memory mandate = _mandate();
        _refused(mandate, _sign(mandate, OWNER_KEY), IDominoAutoExit.Unauthorized.selector);
    }

    /// ecrecover returns zero for this signature; a zero owner would "sign" it.
    function testRefusesAZeroOwner() public {
        vault.setOwner(address(0));
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.owner = address(0);
        _refused(mandate, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)), IDominoAutoExit.InvalidMandate.selector);
    }

    function testRefusesAZeroVault() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.vault = address(0);
        _refusedTerms(mandate);
    }

    function testValidityMustNotHaveEnded() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.validUntil = START - 1;
        _refusedTerms(mandate);
        mandate.validUntil = START;
        _register(mandate);
    }

    function testNeedsATrigger() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.triggerBelowSqrtPriceX96 = 0;
        _refusedTerms(mandate);
    }

    function testTriggersMustNotCross() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.triggerAboveSqrtPriceX96 = STOP;
        _refusedTerms(mandate);
        mandate.triggerAboveSqrtPriceX96 = STOP - 1;
        _refusedTerms(mandate);
        mandate.triggerAboveSqrtPriceX96 = STOP + 1;
        _register(mandate);
    }

    function testEitherTriggerAloneIsAMandate() public {
        DominoV2Types.ExitMandate memory stopLoss = _mandate();
        _register(stopLoss);
        DominoV2Types.ExitMandate memory takeProfit = _mandate();
        takeProfit.triggerBelowSqrtPriceX96 = 0;
        takeProfit.triggerAboveSqrtPriceX96 = STOP;
        takeProfit.nonce = 2;
        _register(takeProfit);
    }

    function testSlippageIsPositiveAndCapped() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.maxSlippageBps = 0;
        _refusedTerms(mandate);
        mandate.maxSlippageBps = autoExit.MAX_SLIPPAGE_BPS() + 1;
        _refusedTerms(mandate);
        mandate.maxSlippageBps = autoExit.MAX_SLIPPAGE_BPS();
        _register(mandate);
    }

    function testReceivingBothTakesNoConversionToken() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.convertTo = address(token1);
        _refusedTerms(mandate);
    }

    function testConversionTargetIsOneOfThePoolsTokens() public {
        _refusedTerms(_converted(address(registry)));
        _register(_converted(address(token0)));
        DominoV2Types.ExitMandate memory mandate = _converted(address(token1));
        mandate.nonce = 2;
        _register(mandate);
    }

    function testUnknownReceiveModeIsRefused() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.receiveMode = 2;
        _refusedTerms(mandate);
    }

    function testAMandateRegistersOnce() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        bytes memory signature = _sign(mandate, OWNER_KEY);
        bytes32 mandateHash = autoExit.registerMandate(mandate, signature);
        _refused(mandate, signature, IDominoAutoExitExtension.MandateAlreadyRegistered.selector);
        vm.prank(owner);
        autoExit.revokeMandate(mandateHash);
        _refused(mandate, signature, IDominoAutoExitExtension.MandateAlreadyRegistered.selector);
    }

    // ------------------------------------------------------------ nonces
    function testANonceRegistersOneMandate() public {
        _register(_mandate());
        DominoV2Types.ExitMandate memory other = _mandate();
        other.maxSlippageBps = 300;
        _refused(other, _sign(other, OWNER_KEY), IDominoAutoExitExtension.NonceAlreadyUsed.selector);
    }

    function testCancellingANonceVoidsAnUnregisteredSignature() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.nonce = 7;
        bytes memory signature = _sign(mandate, OWNER_KEY);
        vm.recordLogs();
        vm.prank(owner);
        autoExit.cancelNonce(7);
        VmAutoExit.Log[] memory logs = vm.getRecordedLogs();
        _eq(_count(logs, address(autoExit), IDominoAutoExitExtension.NonceCancelled.selector), 1, "event");
        _eq(logs[0].topics[1], bytes32(uint256(uint160(owner))), "event owner");
        _eq(logs[0].topics[2], bytes32(uint256(7)), "event nonce");
        _true(autoExit.nonceUsed(owner, 7), "used");
        _refused(mandate, signature, IDominoAutoExitExtension.NonceAlreadyUsed.selector);
        vm.prank(owner);
        vm.expectRevert(IDominoAutoExitExtension.NonceAlreadyUsed.selector);
        autoExit.cancelNonce(7);
    }

    function testNoncesBelongToEachOwner() public {
        vm.prank(STRANGER);
        autoExit.cancelNonce(1);
        _register(_mandate());
    }

    // -------------------------------------------------------- signatures
    function testContractWalletConsentsThroughEip1271() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(OTHER_KEY));
        vault.setOwner(address(wallet));
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.owner = address(wallet);
        _refused(mandate, _sign(mandate, OWNER_KEY), IDominoAutoExitExtension.InvalidSignature.selector);
        bytes32 mandateHash = autoExit.registerMandate(mandate, _sign(mandate, OTHER_KEY));
        _eq(autoExit.mandateStatus(mandateHash), 1, "active");
    }

    function testRevertCarryingTheMagicValueIsNotConsent() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(OTHER_KEY));
        wallet.setMode(wallet.REVERT_WITH_MAGIC());
        vault.setOwner(address(wallet));
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.owner = address(wallet);
        _refused(mandate, _sign(mandate, OTHER_KEY), IDominoAutoExitExtension.InvalidSignature.selector);
    }

    function testShortReturnIsNotConsent() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(OTHER_KEY));
        wallet.setMode(wallet.SHORT_MAGIC());
        vault.setOwner(address(wallet));
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.owner = address(wallet);
        _refused(mandate, _sign(mandate, OTHER_KEY), IDominoAutoExitExtension.InvalidSignature.selector);
    }

    /// An EIP-7702 account whose delegate has no isValidSignature still signs with its key.
    function testDelegatedAccountSignsWithItsOwnKey() public {
        vm.etch(owner, type(NativeRefuser).runtimeCode);
        DominoV2Types.ExitMandate memory mandate = _mandate();
        _refused(mandate, _sign(mandate, OTHER_KEY), IDominoAutoExitExtension.InvalidSignature.selector);
        bytes32 mandateHash = _register(mandate);
        _eq(autoExit.mandateStatus(mandateHash), 1, "active");
    }

    function testSignatureDoesNotReplayOnAnotherChain() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        bytes memory signature = _sign(mandate, OWNER_KEY);
        bytes32 robinhood = autoExit.domainSeparator();
        vm.chainId(8453);
        _true(autoExit.domainSeparator() != robinhood, "domain follows the chain");
        _eq(autoExit.domainSeparator(), DominoV2Types.domainSeparator(8453, address(autoExit)), "domain");
        _refused(mandate, signature, IDominoAutoExitExtension.InvalidSignature.selector);
    }

    function testSignatureDoesNotReplayOnAnotherModule() public {
        DominoV2Types.ExitMandate memory mandate = _mandate();
        bytes memory signature = _sign(mandate, OWNER_KEY);
        DominoAutoExit other = _deployModule();
        vm.expectRevert(IDominoAutoExitExtension.InvalidSignature.selector);
        other.registerMandate(mandate, signature);
    }

    function testSignatureDoesNotReplayOnAnotherVault() public {
        MockVault second = _newVault(pool, HELD0, HELD1);
        DominoV2Types.ExitMandate memory mandate = _mandate();
        bytes memory signature = _sign(mandate, OWNER_KEY);
        mandate.vault = address(second);
        _refused(mandate, signature, IDominoAutoExitExtension.InvalidSignature.selector);
    }

    /// The module signs in the domain api-contracts/v2/eip712.json exports:
    /// at the goldens' verifying address on 4663 it reproduces their digest.
    function testSigningDomainMatchesTheExportedGoldens() public {
        address verifier = 0x000000000000000000000000000000000000d0D0;
        vm.etch(verifier, address(autoExit).code);
        DominoAutoExit atGolden = DominoAutoExit(payable(verifier));
        _eq(atGolden.domainSeparator(), DominoV2Goldens.DOMAIN_SEPARATOR, "domain separator");
        DominoV2Types.ExitMandate memory golden = DominoV2Types.ExitMandate({
            owner: 0x0000000000000000000000000000000000000B0b,
            vault: 0x000000000000000000000000000000000000cafE,
            tokenId: 3409682,
            triggerBelowSqrtPriceX96: 79228162514264337593543950336,
            triggerAboveSqrtPriceX96: 0,
            receiveMode: DominoV2Types.RECEIVE_CONVERTED,
            convertTo: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,
            maxSlippageBps: 100,
            validUntil: 1798646400,
            nonce: 1
        });
        _eq(
            DominoV2Types.digest(atGolden.domainSeparator(), DominoV2Types.hashExitMandate(golden)),
            DominoV2Goldens.EXIT_MANDATE_DIGEST,
            "mandate digest"
        );
    }

    // ------------------------------------------------------------ revoke
    function testOwnerRevokes() public {
        bytes32 mandateHash = _register(_mandate());
        vm.recordLogs();
        vm.prank(owner);
        autoExit.revokeMandate(mandateHash);
        _eq(autoExit.mandateStatus(mandateHash), 2, "revoked");
        VmAutoExit.Log[] memory logs = vm.getRecordedLogs();
        _eq(_count(logs, address(autoExit), IDominoAutoExit.MandateRevoked.selector), 1, "event");
        _eq(logs[0].topics[1], mandateHash, "event id");
        vm.prank(owner);
        vm.expectRevert(IDominoAutoExit.MandateNotActive.selector);
        autoExit.revokeMandate(mandateHash);
    }

    function testOnlyTheOwnerRevokes() public {
        bytes32 mandateHash = _register(_mandate());
        address[4] memory others = [STRANGER, OPERATOR, GUARDIAN, address(vault)];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IDominoAutoExit.Unauthorized.selector);
            autoExit.revokeMandate(mandateHash);
        }
        _eq(autoExit.mandateStatus(mandateHash), 1, "still active");
    }

    function testRevokingAnUnknownMandateIsRefused() public {
        vm.prank(owner);
        vm.expectRevert(IDominoAutoExit.MandateNotActive.selector);
        autoExit.revokeMandate(keccak256("unknown"));
    }

    /// Halted automation, a disabled module, an expired mandate: none of them
    /// stands between the owner and revocation.
    function testOwnerRevokesAtAnyTime() public {
        bytes32 mandateHash = _register(_mandate());
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        vm.prank(owner);
        vault.setExitModule(address(0));
        vm.warp(START + 365 days);
        vm.prank(owner);
        autoExit.revokeMandate(mandateHash);
        _eq(autoExit.mandateStatus(mandateHash), 2, "revoked");
    }

    // -------------------------------------------------------- deployment
    function testConstructorRefusesMissingParameters() public {
        DominoSwapExecutor.RouteConfig memory route = DominoSwapExecutor.RouteConfig(
            IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(manager)
        );
        vm.expectRevert(DominoAutoExit.InvalidConfiguration.selector);
        new DominoAutoExit(route, address(0), MAX_AGE, MIN_TWAP);
        vm.expectRevert(DominoAutoExit.InvalidConfiguration.selector);
        new DominoAutoExit(route, address(anchor), 0, MIN_TWAP);
        vm.expectRevert(DominoAutoExit.InvalidConfiguration.selector);
        new DominoAutoExit(route, address(anchor), MAX_AGE, 0);
        // A floor above the hour's ceiling would refuse every TWAP.
        vm.expectRevert(DominoAutoExit.InvalidConfiguration.selector);
        new DominoAutoExit(route, address(anchor), MAX_AGE, 3601);
        route.registry = IDominoRegistry(STRANGER);
        vm.expectRevert(DominoFeeLedger.InvalidFeeConfig.selector);
        new DominoAutoExit(route, address(anchor), MAX_AGE, MIN_TWAP);
    }

    function testParametersAreReadable() public view {
        _eq(autoExit.registry(), address(registry), "registry");
        _eq(autoExit.priceAnchor(), address(anchor), "anchor");
        _eq(autoExit.maxObservationAgeSeconds(), MAX_AGE, "max age");
        _eq(autoExit.minTwapSeconds(), MIN_TWAP, "min twap");
        _eq(autoExit.MAX_TWAP_SECONDS(), 3600, "max twap");
        _eq(autoExit.MAX_SLIPPAGE_BPS(), 1000, "slippage cap");
        _eq(autoExit.MAX_POOL_FEE_PIPS(), 100_000, "pool fee ceiling");
        _eq(autoExit.INSTRUCTION_VERSION(), 1, "instruction version");
    }

    function testDeclaresItsInterfaces() public view {
        _true(autoExit.supportsInterface(0x01ffc9a7), "ERC-165");
        _true(autoExit.supportsInterface(type(IDominoAutoExit).interfaceId), "IDominoAutoExit");
        _true(autoExit.supportsInterface(type(IDominoAutoExitExtension).interfaceId), "extension");
        _true(autoExit.supportsInterface(type(IDominoFeeSettlement).interfaceId), "fee settlement");
        _true(!autoExit.supportsInterface(0xffffffff), "not 0xffffffff");
        _true(!autoExit.supportsInterface(0x12345678), "not a stranger");
    }

    function testRuntimeFitsTheContractSizeLimit() public view {
        _true(address(autoExit).code.length <= 24_576, "runtime within 24,576 bytes");
    }
}
