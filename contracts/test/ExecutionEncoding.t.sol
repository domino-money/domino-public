// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Independent, offline ABI goldens for the E1 internal candidate.
/// @dev This is a test-only encoder, not a deployed executor or wallet signing API.
/// Nested records use their struct hashes. Record arrays intentionally use
/// keccak256(abi.encode(bytes32[])), including ABI offset/length words; this is
/// the E1 candidate convention, not standard EIP-712's packed array convention.
contract ExecutionEncodingTest {
    // Static tuples encode in declared word order. There are no dynamic members
    // here, so abi.encode(tuple) adds no tuple offset and matches the flat ABI.
    struct SequenceWords {
        bytes32 typeHash;
        uint256 chainId;
        address owner;
        bytes32 sequenceId;
        address vault;
        address factory;
        address implementation;
        uint64 implementationVersion;
        address poolManager;
        address positionManager;
        bytes32 poolKey;
        bytes32 poolId;
        address baseCurrency;
        address quoteCurrency;
        address serviceFeeRecipient;
    }

    struct ObservationWords {
        bytes32 typeHash;
        bytes32 sequence;
        bytes32 policy;
        uint64 stateNonce;
        uint64 authorityGeneration;
        uint64 blockNumber;
        bytes32 blockHash;
        uint64 blockTimestamp;
        uint160 sqrtPriceX96;
        address operator;
        bool operatorEnabled;
        bool canonical;
        bool coverageComplete;
        bytes32 positions;
        bytes32 balances;
        bytes32 accruals;
    }

    struct PlanWords {
        bytes32 typeHash;
        bytes32 sequence;
        bytes32 policyHash;
        bytes32 observationHash;
        uint8 action;
        uint8 path;
        uint64 expectedPolicyVersion;
        uint64 expectedStateNonce;
        uint64 expectedAuthorityGeneration;
        uint64 sourceBlockNumber;
        bytes32 sourceBlockHash;
        uint64 deadline;
        bytes32 allocations;
        bytes32 collections;
        bytes32 destination;
        uint128 liquidityIncrease;
        uint128 maxGrossFee0;
        uint128 maxGrossFee1;
        uint128 maxChargedInput0;
        uint128 maxChargedInput1;
        uint128 minNetAdded0;
        uint128 minNetAdded1;
        uint160 minSqrtPriceX96;
        uint160 maxSqrtPriceX96;
        uint128 maxGasCostWei;
        bytes32 swap;
    }

    function domainHash(uint256 chainId, address vault) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("DominoPublicExecutor"),
                keccak256("e1-candidate-1"),
                chainId,
                vault
            )
        );
    }

    function hashArray(bytes32[] memory records) private pure returns (bytes32) {
        return keccak256(abi.encode(records));
    }

    // Values below are the synthetic self/native/reversed cases in
    // backend/tests/fixtures/execution/e1-vectors.json. Only final EXPECTED
    // hashes are copied: every input/intermediate is independently recomputed.
    function poolId(address currency0) private pure returns (bytes32) {
        return keccak256(abi.encode(currency0, address(0x20), uint24(3000), int24(60), address(0)));
    }

    function poolKeyHash(address currency0) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "PoolKey(address currency0,address currency1,uint24 fee_pips,int24 tick_spacing,address hooks)"
                ),
                currency0,
                address(0x20),
                uint24(3000),
                int24(60),
                address(0)
            )
        );
    }

    function sequenceHash(address currency0, address baseCurrency, address quoteCurrency)
        private
        pure
        returns (bytes32)
    {
        SequenceWords memory value;
        value.typeHash = keccak256(
            "SequenceIdentity(uint256 chainId,address owner,bytes32 sequenceId,address vault,address factory,address implementation,uint64 implementationVersion,address poolManager,address positionManager,bytes32 poolKey,bytes32 poolId,address baseCurrency,address quoteCurrency,address serviceFeeRecipient)"
        );
        value.chainId = 4663;
        value.owner = address(1);
        value.sequenceId = bytes32(uint256(11));
        value.vault = address(3);
        value.factory = address(4);
        value.implementation = address(5);
        value.implementationVersion = 1;
        value.poolManager = address(7);
        value.positionManager = address(6);
        value.poolKey = poolKeyHash(currency0);
        value.poolId = poolId(currency0);
        value.baseCurrency = baseCurrency;
        value.quoteCurrency = quoteCurrency;
        value.serviceFeeRecipient = address(8);
        return keccak256(abi.encode(value));
    }

    function corePositionHash() private pure returns (bytes32) {
        // The underlying Uniswap core position uses packed address/int24/int24/
        // bytes32 salt. In particular, -120 is a SIGNED three-byte value here.
        return keccak256(abi.encodePacked(address(6), int24(-120), int24(180), bytes32(uint256(101))));
    }

    function positionHash(bytes32 sequence) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "PositionIdentity(bytes32 sequence,uint256 tokenId,uint64 generation,bool isRoot,uint256 parentTokenId,int24 tickLower,int24 tickUpper,bytes32 corePositionId,bytes32 registrationBaselineId)"
                ),
                sequence,
                uint256(101),
                uint64(1),
                true,
                uint256(0),
                int24(-120),
                int24(180),
                corePositionHash(),
                bytes32(uint256(1101))
            )
        );
    }

    function sourceHash(bytes32 sequence, address currency) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("FeeSourceIdentity(bytes32 sequence,bytes32 position,address currency)"),
                sequence,
                positionHash(sequence),
                currency
            )
        );
    }

    function creditHash(bytes32 source, uint64 number, bytes32 blockHash, uint128 amount)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256(
                    "FeeCredit(bytes32 source,bytes32 transactionHash,uint32 eventIndex,uint128 amountRaw,uint64 blockNumber,bytes32 blockHash,bool canonical,bool finalized)"
                ),
                source,
                bytes32(uint256(401)),
                uint32(3),
                amount,
                number,
                blockHash,
                true,
                false
            )
        );
    }

    function creditId(bytes32 source, uint32 eventIndex) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("FeeCreditId(bytes32 source,bytes32 transactionHash,uint32 eventIndex)"),
                source,
                bytes32(uint256(401)),
                eventIndex
            )
        );
    }

    function limitsHash(address baseCurrency, address quoteCurrency) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "ExecutionLimits(uint64 version,address baseCurrency,address quoteCurrency,uint32 upsideBps,uint16 maxSlippageBps,uint16 maxPriceImpactBps,uint128 maxGasCostWei,uint32 maxObservationAgeSeconds,uint32 forecastHorizonSeconds)"
                ),
                uint64(1),
                baseCurrency,
                quoteCurrency,
                uint32(5000),
                uint16(100),
                uint16(100),
                uint128(1_000_000_000_000_000),
                uint32(120),
                uint32(3600)
            )
        );
    }

    function policyHash(address baseCurrency, address quoteCurrency) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "SequencePolicy(uint16 serviceFeeBps,uint16 triggerDistanceBps,uint16 maxOverlapBps,uint32 minimumIntervalSeconds,uint8 maxPositions,uint64 version,bool paused,bytes32 limits)"
                ),
                uint16(200),
                uint16(500),
                uint16(2000),
                uint32(600),
                uint8(4),
                uint64(1),
                false,
                limitsHash(baseCurrency, quoteCurrency)
            )
        );
    }

    function balanceHash(bytes32 sequence, address currency) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "SourceBalance(bytes32 source,bytes32 lotId,address currency,bool convertedCharged,uint128 amountRaw,uint128 reservedRaw,bytes32 reconciliationId)"
                ),
                sourceHash(sequence, currency),
                bytes32(uint256(201)),
                currency,
                false,
                uint128(1300),
                uint128(100),
                bytes32(uint256(202))
            )
        );
    }

    function observationHash(address currency0, address baseCurrency, address quoteCurrency)
        private
        pure
        returns (bytes32)
    {
        ObservationWords memory value;
        value.typeHash = keccak256(
            "Observation(bytes32 sequence,bytes32 policy,uint64 stateNonce,uint64 authorityGeneration,uint64 blockNumber,bytes32 blockHash,uint64 blockTimestamp,uint160 sqrtPriceX96,address operator,bool operatorEnabled,bool canonical,bool coverageComplete,bytes32 positions,bytes32 balances,bytes32 accruals)"
        );
        value.sequence = sequenceHash(currency0, baseCurrency, quoteCurrency);
        value.policy = policyHash(baseCurrency, quoteCurrency);
        value.stateNonce = 7;
        value.authorityGeneration = 1;
        value.blockNumber = 1234;
        value.blockHash = bytes32(uint256(301));
        value.blockTimestamp = 1_700_000_000;
        value.sqrtPriceX96 = 79_228_162_514_264_337_593_543_950_336;
        value.operator = address(9);
        value.operatorEnabled = true;
        value.canonical = true;
        value.coverageComplete = true;
        bytes32[] memory entries = new bytes32[](1);
        entries[0] = keccak256(
            abi.encode(
                keccak256("CustodyObservation(bytes32 position,address holder,address individualApproval,bool active)"),
                positionHash(value.sequence),
                address(1),
                address(3),
                true
            )
        );
        value.positions = hashArray(entries);
        entries[0] = balanceHash(value.sequence, currency0);
        value.balances = hashArray(entries);
        value.accruals = hashArray(new bytes32[](0));
        return keccak256(abi.encode(value));
    }

    function allocationHash(uint256 lot, uint128 amount) private pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("Allocation(bytes32 lotId,uint128 amountRaw)"), bytes32(lot), amount));
    }

    function disabledSwapHash() private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "SwapBounds(bool enabled,bytes32 adapterId,uint64 adapterVersion,bytes32 routeCommitment,address currencyIn,address currencyOut,uint128 amountInRaw,uint128 minAmountOutRaw)"
                ),
                false,
                bytes32(0),
                uint64(0),
                bytes32(0),
                address(0),
                address(0),
                uint128(0),
                uint128(0)
            )
        );
    }

    function selfPlan(address currency0, address baseCurrency, address quoteCurrency)
        private
        pure
        returns (PlanWords memory value)
    {
        value.typeHash = keccak256(
            "ExecutionPlan(bytes32 sequence,bytes32 policyHash,bytes32 observationHash,uint8 action,uint8 path,uint64 expectedPolicyVersion,uint64 expectedStateNonce,uint64 expectedAuthorityGeneration,uint64 sourceBlockNumber,bytes32 sourceBlockHash,uint64 deadline,bytes32 allocations,bytes32 collections,bytes32 destination,uint128 liquidityIncrease,uint128 maxGrossFee0,uint128 maxGrossFee1,uint128 maxChargedInput0,uint128 maxChargedInput1,uint128 minNetAdded0,uint128 minNetAdded1,uint160 minSqrtPriceX96,uint160 maxSqrtPriceX96,uint128 maxGasCostWei,bytes32 swap)"
        );
        value.sequence = sequenceHash(currency0, baseCurrency, quoteCurrency);
        value.policyHash = policyHash(baseCurrency, quoteCurrency);
        value.observationHash = observationHash(currency0, baseCurrency, quoteCurrency);
        value.action = 1;
        value.path = 0;
        value.expectedPolicyVersion = 1;
        value.expectedStateNonce = 7;
        value.expectedAuthorityGeneration = 1;
        value.sourceBlockNumber = 1234;
        value.sourceBlockHash = bytes32(uint256(301));
        value.deadline = 1_700_000_060;
        bytes32[] memory entries = new bytes32[](1);
        entries[0] = allocationHash(201, 1000);
        value.allocations = hashArray(entries);
        value.collections = hashArray(new bytes32[](0));
        value.destination = keccak256(
            abi.encode(
                keccak256("Destination(bool createChild,uint256 tokenId,int24 tickLower,int24 tickUpper)"),
                false,
                uint256(101),
                int24(-120),
                int24(180)
            )
        );
        value.liquidityIncrease = 1;
        value.maxGrossFee0 = 1000;
        value.maxGrossFee1 = 0;
        value.maxChargedInput0 = 0;
        value.maxChargedInput1 = 0;
        value.minNetAdded0 = 980;
        value.minNetAdded1 = 0;
        value.minSqrtPriceX96 = 79_228_162_514_264_337_593_543_950_335;
        value.maxSqrtPriceX96 = 79_228_162_514_264_337_593_543_950_337;
        value.maxGasCostWei = 1_000_000_000_000;
        value.swap = disabledSwapHash();
    }

    function intentId(PlanWords memory plan, uint256 chainId, address vault) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainHash(chainId, vault), keccak256(abi.encode(plan))));
    }

    function testSelfSequencePositionAndFeeSourceGoldens() public pure {
        bytes32 sequence = sequenceHash(address(0x10), address(0x10), address(0x20));
        require(poolId(address(0x10)) == 0xb7a0fb68b2b106d2ad386d2221acbdb3b027b737f097dfbb8a854fa3cc08fcf2, "pool id");
        require(sequence == 0x84f994fc05446f7808a37698238c00f6deb5c2979644edd5b7901c6209371661, "sequence hash");
        require(
            corePositionHash() == 0xbbda2f9140cb5074bc9156fdebba445f787094f975c98bdc847003ff6940698b, "core position"
        );
        require(
            positionHash(sequence) == 0x7b5cabf5a46156e83a94b460cd50d975d6c2cc4ecb9ef98accfdfe1a4bec571d,
            "position hash"
        );
        require(
            sourceHash(sequence, address(0x10)) == 0x412c17918c0c3ac3af2ffa9806045a71dd16254962c0e1d543e9316e49a9eb2e,
            "source hash"
        );
    }

    function testFeeCreditGoldenAndStableDedupIdentity() public pure {
        bytes32 sequence = sequenceHash(address(0x10), address(0x10), address(0x20));
        bytes32 source = sourceHash(sequence, address(0x10));
        bytes32 evidence = creditHash(source, 1234, bytes32(uint256(301)), 1300);
        require(evidence == 0xc8393092f0013c2973c9e6686cd389f59357b0f95fd8d3fda0527861fe5cbe0b, "credit hash");
        require(creditId(source, 3) == 0x5002539c39c27549c5cdc9a6945271e1d27a61b511b4090bcab0535fb8a337c6, "credit id");
        require(creditHash(source, 1235, bytes32(uint256(302)), 1300) != evidence, "re-inclusion evidence");
        require(creditHash(source, 1234, bytes32(uint256(301)), 1301) != evidence, "amount evidence");
        require(creditId(source, 4) != creditId(source, 3), "event identity");
        // Block location and amount are absent from creditId's declared tuple.
        // Their changes above alter evidence, not the stable event/source key.
    }

    function testSelfPolicyObservationDomainAndPlanGoldens() public pure {
        PlanWords memory plan = selfPlan(address(0x10), address(0x10), address(0x20));
        require(plan.policyHash == 0x4f0c724d99b41a99fcdf5576a4166f80030378c21b94f154bb5d1a3856543f29, "policy hash");
        require(
            plan.observationHash == 0xbea71b237f5f85df0c34148bf0f58281a42368e957124ef1261e591cfc7403b0,
            "observation hash"
        );
        require(
            domainHash(4663, address(3)) == 0xd5ee4d7435a354f0bb715719447e1a2a7012e585e8f5b93a0ba7b0122f8c78ba,
            "domain hash"
        );
        require(
            keccak256(abi.encode(plan)) == 0x0dd95ff2f5b135c1bb91c48b480ecc7b60de525f1c47b898583ee2fff2b51921,
            "plan hash"
        );
        require(
            intentId(plan, 4663, address(3)) == 0x13590632a80ac560d49d631fc1e3a76fedddc316ee631ac89863a582787ca074,
            "intent id"
        );
    }

    function testNativeCurrencyFullPlanGolden() public pure {
        PlanWords memory plan = selfPlan(address(0), address(0), address(0x20));
        require(
            poolId(address(0)) == 0x21dec34a52fd2d64a7d928ba95356ca76d34c29d702ff8c64410fb8d366f2419, "native pool id"
        );
        require(plan.sequence == 0x528476e35bc885ca622066cb3b9d89cb0c6126ba16df2584cddb0f3aead34e0d, "native sequence");
        bytes32 source = sourceHash(plan.sequence, address(0));
        require(source == 0x579be3b925c847a91a42100318f7bb98fe7a845db44066179f8b9816c1d6dd59, "native source");
        require(
            creditHash(source, 1234, bytes32(uint256(301)), 1300)
                == 0xeab6135717e67fee882c5a1c9fcfb303d11718789ee6b897af428215a550bdd3,
            "native credit"
        );
        require(
            keccak256(abi.encode(plan)) == 0x15413d7c7bb6d94ae0581ae10a996170c1282b64cab6eb66b3b98036da0220d8,
            "native plan"
        );
        require(
            intentId(plan, 4663, address(3)) == 0x28fd4f1985ea7d9f9c186a87c1ac569d7f66d3a96249b3ab89c63a086dbd1674,
            "native intent"
        );
    }

    function testReversedPriceOrientationFullPlanGolden() public pure {
        PlanWords memory plan = selfPlan(address(0x10), address(0x20), address(0x10));
        require(
            plan.sequence == 0xff7ffa9d90dee6ae350e358e1c2b28b1e9fce43de8ed30d31a8c848f5739d4e2, "reversed sequence"
        );
        bytes32 source = sourceHash(plan.sequence, address(0x10));
        require(source == 0x729ec35b529cc0fd05d9b135b264105966ccae0d27e2581cb86b40206e3b5de3, "reversed source");
        require(
            creditHash(source, 1234, bytes32(uint256(301)), 1300)
                == 0x2d87450956abfb5556a7a971bf5994bcdabd08faf03bd63bc0af0f1ea61cb729,
            "reversed credit"
        );
        require(
            keccak256(abi.encode(plan)) == 0x02a40f2ff9e595ac746af1dc212accb862c2561045043f254b14daf773a0ec00,
            "reversed plan"
        );
        require(
            intentId(plan, 4663, address(3)) == 0xdb1b86993fcbc27d7321a8bd43f2eef6e26ab64c286ae3c6bc6bf581800a6b2f,
            "reversed intent"
        );
    }

    function testUint128AllocationGoldensDoNotNarrowToUint64() public pure {
        require(
            allocationHash(201, 18_446_744_073_709_551_617)
                == 0x878839ef8be23fc85c92d43ac8bcd6c5942038c0f942651b7b6f14531225883f,
            "allocation above uint64"
        );
        require(
            allocationHash(201, type(uint128).max)
                == 0x0c70b5b52a3ba3edeec2a12ef16faa0e74e936fd8115348356a6490e2bd0999d,
            "allocation uint128 max"
        );
    }

    function testRecordArrayGoldensIncludeAbiOffsetLengthAndOrder() public pure {
        bytes32[] memory entries = new bytes32[](0);
        require(hashArray(entries) == 0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd, "empty array");
        entries = new bytes32[](1);
        entries[0] = allocationHash(201, 1000);
        require(hashArray(entries) == 0xd66584e78405211abee4da83c9dbdff61807f03e0802494285ca5cfec9f2dc1f, "one record");
        entries = new bytes32[](2);
        entries[0] = allocationHash(201, 1000);
        entries[1] = allocationHash(202, 18_446_744_073_709_551_617);
        require(hashArray(entries) == 0x1e51a305baa4a5b4179f314acac4c7e719610144265b401b04e05003cf824874, "two records");
        require(hashArray(entries) != keccak256(abi.encodePacked(entries)), "must not use packed EIP712 array");
        (entries[0], entries[1]) = (entries[1], entries[0]);
        require(hashArray(entries) == 0x930c3eca048ac3a30cbca3330cb05f5cab773f81309f1ff656cf1413575be46e, "array order");
    }

    function testEnvelopeBindsChainVaultAndPlanNonce() public pure {
        PlanWords memory plan = selfPlan(address(0x10), address(0x10), address(0x20));
        bytes32 original = intentId(plan, 4663, address(3));
        require(intentId(plan, 4664, address(3)) != original, "chain separation");
        require(intentId(plan, 4663, address(4)) != original, "vault separation");
        plan.expectedStateNonce = 8;
        require(intentId(plan, 4663, address(3)) != original, "state nonce binding");
    }
}
