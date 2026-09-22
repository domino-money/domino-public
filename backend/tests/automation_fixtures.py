"""Synthetic automation-cycle configuration and readers for offline tests.

Every number here is a test value. Nothing is a production default; the
private production file has to state its own, as the runbook says.
"""
import copy
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import encode
from eth_hash.auto import keccak

import execution_models as m
from automation_config import validate_config


def address(n):
    return '0x' + n.to_bytes(20, 'big').hex()


def identity(n):
    return '0x' + n.to_bytes(32, 'big').hex()


def deep_update(base, changes):
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_update(base[key], value)
        else:
            base[key] = value
    return base


def gas_pool(quote, *, fee=500, tick_spacing=10, hooks=m.ZERO):
    """A native/quote pool key for converting gas into `quote`."""
    return {'currency0': m.ZERO, 'currency1': quote, 'fee': fee, 'tickSpacing': tick_spacing, 'hooks': hooks}


def sample_config(*, currencies=(address(16), address(32)), **changes):
    c0, c1 = currencies
    config = {
        'schemaVersion': 1, 'kind': 'domino-automation-cycle', 'configVersion': 'test-1',
        'database': {'host': '/tmp/socket', 'port': 18897, 'dbname': 'execution_test'},
        'rpcEndpoint': 'http://127.0.0.1:8545',
        'deployment': {
            'poolManager': address(7), 'positionManager': address(6), 'stateView': address(20), 'factory': address(4),
            'readHelper': address(21), 'routing': address(22), 'priceGuard': address(23), 'engine': address(24),
            'implementation': address(5), 'serviceFeeRecipient': address(8), 'operator': address(9), 'pricePublisher': address(10),
            'serviceFeeBps': 200, 'dominoServiceFeeBps': 400, 'expiresAt': 2000000000,
            'codeHashes': {name: identity(100 + i) for i, name in enumerate(('poolManager', 'positionManager', 'stateView', 'factory',
                'readHelper', 'routing', 'priceGuard', 'engine', 'implementation', 'vault'))}},
        'sequences': [{'owner': address(1), 'vault': address(3), 'expiresAt': 2000000000, 'suspended': False}],
        'operator': {'keyFile': '/private/operator.key', 'policy': {'max_gas': 6000000, 'max_fee_per_gas': 10**10, 'priority_fee_per_gas': 1,
                     'max_total_cost': 10**17, 'max_replacements': 2, 'bump_bps': 1250, 'enabled': True}},
        'publisher': {'keyFile': '/private/publisher.key', 'maxGas': 400000, 'maxFeePerGas': 10**10, 'priorityFeePerGas': 1,
                      'maxTotalCostWei': 10**16, 'expirySeconds': 600, 'enabled': True},
        'planner': {'version': identity(800), 'minimumSamples': 3, 'minimumSampleSeconds': 2, 'maximumMeasurementSeconds': 7200,
                    'maximumSampleAgeSeconds': 120, 'maximumForecastSeconds': 3600, 'forecastHaircutBps': 0,
                    'minimumOwnerBenefitQuote': 0, 'operatorCostBufferBps': 1500, 'serviceRealizationBps': 10000,
                    'overlapChoicesBps': [0, 500, 2000], 'liquidityFractionChoicesBps': [2500, 5000, 10000]},
        'pricing': {'kind': 'pool_spot', 'valuationBandBps': 10, 'wrappedNative': address(0x2000),
                    'gasPools': {c: gas_pool(c) for c in (c0, c1) if c != m.ZERO}, 'gasPriceBufferBps': 0},
        'swapCap': {'depthMultiplierBps': 10000},
        'gas': {'publishGasUnits': 160000, 'executeGasUnits': {'direct': 1200000, 'swap': 1500000, 'mint': 1900000, 'fund': 1300000},
                'priorityFeePerGasWei': 1, 'basePriceBufferBps': 0, 'l1DataComponent': 'attested_none',
                'operatorMinimumBalanceWei': 10**15, 'publisherMinimumBalanceWei': 10**15},
        'destinations': {'maxLiquidityIncreaseBpsOfActive': 1000, 'maxLiquidityIncreaseAbsolute': 2**100, 'competingLiquidityHaircutBps': 1000,
                         'totalLiquidityMarginBps': 1000, 'activeFractionHaircutBps': 0, 'successorActiveFractionBps': 5000,
                         'exposureLossBps': 0, 'swapFractionsBps': [2500, 5000, 7500, 10000], 'minimumSwapFractionBps': 100, 'quoteSlippageBps': 50, 'maxSimulationSteps': 64},
        'history': {'samplerVersion': 'pool-fee-sampler-1', 'sampleIntervalSeconds': 1, 'maximumSampleGapSeconds': 600},
        'plan': {'deadlineSeconds': 100, 'maxGasCostWei': 10**16, 'preferNetPath': True, 'liquiditySlackBps': 25},
        'scheduling': {'workerId': None, 'evaluationIntervalSeconds': 5, 'minimumBackoffSeconds': 5, 'maximumBackoffSeconds': 60, 'leaseSeconds': 120,
                       'publicationWindowSeconds': 3600, 'maxPublicationsPerWindow': 10, 'publicationWaitSeconds': 20,
                       'executionWaitSeconds': 20, 'maxSourceBlockAge': 200, 'cycleBudgetSeconds': 300, 'jitterBps': 0,
                       'latencyTargetSeconds': 5, 'failureBackoffAfter': 3},
        'finality': {'publicationConfirmations': 0},
        'ledger': {'indexer': 'inline', 'maxBlocksPerPass': 2000, 'maxLogsPerPass': 1024},
        'paused': False,
    }
    return deep_update(copy.deepcopy(config), changes)


def sample_automation_config(**changes):
    return validate_config(sample_config(**changes))


def selector(signature):
    return keccak(signature.encode())[:4]


class FakeChainReader:
    """An in-memory pool, other pools' spots and a node interface behind the reader interface."""
    def __init__(self, *, sqrt_price, tick, lp_fee, spacing, ranges, fee_growth=(0, 0), pools=None, timestamp=1700000000, number=1234,
                 protocol_fee=0, node_interface=True, base_fee=7):
        self.sqrt_price, self.tick, self.lp_fee, self.spacing, self.protocol_fee = sqrt_price, tick, lp_fee, spacing, protocol_fee
        self.fee_growth = list(fee_growth)
        self.ranges = list(ranges)  # (lower, upper, liquidity)
        self.pools = dict(pools or {})  # pool id -> (sqrt price, liquidity) of pools other than the sequence's
        self.block = {'number': number, 'hash': identity(number), 'timestamp': timestamp, 'baseFeePerGas': base_fee}
        self.node_interface = node_interface
        self.calls = []

    def head(self):
        return dict(self.block)

    def canonical(self, header):
        return True

    def balance(self, address_):
        return 10**18

    @property
    def liquidity(self):
        return sum(l for lower, upper, l in self.ranges if lower <= self.tick < upper)

    def net_at(self, tick):
        return sum(l for lower, _, l in self.ranges if lower == tick) - sum(l for _, upper, l in self.ranges if upper == tick)

    def initialized(self):
        return {t for lower, upper, _ in self.ranges for t in (lower, upper)}

    def call(self, target, signature, outputs, block, inputs=(), values=()):
        self.calls.append(signature)
        name = signature.split('(')[0]
        other = self.pools.get('0x' + values[0].hex()) if name in ('getSlot0', 'getLiquidity') and values else None
        if other is not None:
            return (other[0], 0, 0, 500) if name == 'getSlot0' else (other[1],)
        if name == 'getSlot0':
            return (self.sqrt_price, self.tick, self.protocol_fee, self.lp_fee)
        if name == 'getLiquidity':
            return (self.liquidity,)
        if name == 'getFeeGrowthGlobals':
            return tuple(self.fee_growth)
        if name == 'getTickBitmap':
            word = values[1]
            bits = 0
            for tick in self.initialized():
                compressed = tick // self.spacing
                if compressed >> 8 == word:
                    bits |= 1 << (compressed & 255)
            return (bits,)
        if name == 'getTickLiquidity':
            tick = values[1]
            gross = sum(l for lower, upper, l in self.ranges if tick in (lower, upper))
            return (gross, self.net_at(tick))
        if name == 'gasEstimateL1Component':
            if not self.node_interface:
                raise ValueError('invalid_compound_abi')
            return (len(values[2]) * 16, 0, 0)
        raise AssertionError('unexpected call ' + signature)
