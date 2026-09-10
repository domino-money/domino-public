"""Bounded, read-only Chainlink history with proven block publication times.

Only the reviewed Robinhood standard proxies and exact native/ERC-20 identities
are understood. This adapter gathers evidence; it never qualifies a source or
changes a valuation policy. In particular, an answer's updatedAt is not proof
that the answer was already available on Robinhood at that timestamp.
"""
from dataclasses import asdict, dataclass
import math
import time

from discovery import CHAIN_ID, ZERO, DataError, address, parse_block, quantity

SOURCE = 'chainlink_robinhood_standard_v1'
ADAPTER_VERSION = 1
MANIFEST_SHA256 = '2ae1ea5f432cab06904134759033d7c6434c323171f954120c4933fdde42e85d'
MAX_ROUNDS = 64
MAX_WINDOW_SECONDS = 86400 + 600
DEADLINE_SECONDS = 180
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
ROUND_TYPES = ('uint80', 'int256', 'uint256', 'uint256', 'uint80')
ROUND_MASK = (1 << 64) - 1


@dataclass(frozen=True)
class Feed:
    proxy: str
    aggregator: str
    description: str
    decimals: int = 8
    phase: int = 1


ETH_FEED = Feed('0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9',
                '0x6091e64eb7138eef066a80fd3a0d7427b91f2721', 'ETH / USD')
USDG_FEED = Feed('0x61b7e5650328764b076a108eff5fa7282a1b9ad2',
                 '0x8beee3503f6860d5dac4ce26b5eee92982951c2e', 'USDG / USD')
FEEDS = {ZERO: ETH_FEED, WETH: ETH_FEED, USDG: USDG_FEED}


@dataclass(frozen=True)
class Round:
    id: int
    answer: int
    started_at: int
    updated_at: int
    answered_in_round: int


def _price(answer, decimals):
    # Integer formatting preserves every decimal, including answers above 2**53.
    whole, part = divmod(answer, 10 ** decimals)
    return str(whole) if not part else f'{whole}.{part:0{decimals}d}'.rstrip('0')


class ChainlinkHistorical:
    """One fetch owns its caches; request limits remain the supplied RPC's limits.

    The transport must support historical EIP-1898 eth_call block hashes. There
    is no unsafe number-only fallback, RPC-error-as-absence, or phase traversal.
    The deadline bounds the invocation between the transport's bounded calls.
    """
    def __init__(self, rpc, *, clock=time.time, deadline_seconds=DEADLINE_SECONDS):
        if type(deadline_seconds) is not int or not 1 <= deadline_seconds <= 360:
            raise DataError('invalid_chainlink_deadline')
        self.rpc, self.clock = rpc, clock
        self.deadline_seconds = deadline_seconds

    def fetch(self, currency, start, end, *, block_number=None):
        currency = address(currency)
        if currency not in FEEDS:
            raise DataError('chainlink_currency_unsupported')
        now = self.clock()
        if (type(now) not in (int, float) or not 0 <= now < 2 ** 63 or
                not math.isfinite(now)):
            raise DataError('invalid_price_history_clock')
        now = int(now)
        if (type(start) is not int or type(end) is not int or
                not 0 <= start < end <= now or end - start > MAX_WINDOW_SECONDS or
                (block_number is not None and
                 (type(block_number) is not int or not 0 <= block_number < 2 ** 63))):
            raise DataError('invalid_price_history_bounds')
        self._deadline = time.monotonic() + self.deadline_seconds
        self._headers, self._latest_cache, self._round_cache = {}, {}, {}
        self._config_cache, self._proof_blocks = {}, set()
        self._currency, self._feed = currency, FEEDS[currency]
        if quantity(self._request('eth_chainId')) != CHAIN_ID:
            raise DataError('wrong_chain')
        tag = 'latest' if block_number is None else hex(block_number)
        snapshot = parse_block(self._request('eth_getBlockByNumber', [tag, False]))
        if block_number is not None and snapshot.number != block_number:
            raise DataError('chainlink_block_number_mismatch')
        if snapshot.timestamp > now or end > snapshot.timestamp:
            raise DataError('chainlink_snapshot_time_mismatch')
        self._headers[snapshot.number] = snapshot
        config = self._configuration(snapshot)
        # Use the last pinned block at or before end, not a future snapshot price.
        end_block = (snapshot if end == snapshot.timestamp else
                     self._block(self._first_at_or_after(end + 1, snapshot) - 1))
        if self._configuration(end_block) != config:
            raise DataError('chainlink_configuration_changed')
        current = self._latest(end_block)
        rows, ceiling = [], end_block
        while len(rows) < MAX_ROUNDS:
            publication, predecessor = self._publication(current, ceiling)
            rows.append({
                'chainId': CHAIN_ID, 'currency': currency, 'source': SOURCE,
                'timestamp': publication.timestamp, 'retrievedAt': now,
                'priceUsd': _price(current.answer, self._feed.decimals),
                'provenance': {
                    'adapterVersion': ADAPTER_VERSION,
                    'manifestSha256': MANIFEST_SHA256,
                    'status': 'external_observation_unqualified',
                    'provider': 'chainlink', 'proxyRole': 'standard',
                    'proxy': self._feed.proxy, 'aggregator': self._feed.aggregator,
                    'phaseId': self._feed.phase, 'feedDecimals': self._feed.decimals,
                    'currencyDecimals': config['currencyDecimals'],
                    'currencyMapping': ('native_eth' if currency == ZERO else
                                        'canonical_weth_reference' if currency == WETH else
                                        'canonical_usdg_reference'),
                    'roundId': str(current.id), 'answerRaw': str(current.answer),
                    'answerStartedAt': current.started_at,
                    'answerUpdatedAt': current.updated_at,
                    'answeredInRound': str(current.answered_in_round),
                    'publicationBlock': asdict(publication),
                    'precedingBlock': asdict(predecessor),
                    'precedingRoundId': str(self._latest(predecessor).id),
                    'timestampSemantics': 'first_proven_publication_block',
                    'freshnessTimestamp': 'answerUpdatedAt',
                    'targetPoolIndependenceVerified': False,
                },
            })
            # The timestamp-only reference policy activates after this block's
            # second, so an update exactly at start still needs its predecessor.
            if publication.timestamp < start:
                break
            if current.id & ROUND_MASK == 1:
                raise DataError('chainlink_phase_boundary')
            if len(rows) == MAX_ROUNDS:
                raise DataError('chainlink_round_budget_exhausted')
            previous = self._get_round(current.id - 1, end_block)
            if previous.updated_at > current.updated_at:
                raise DataError('chainlink_round_time_inverted')
            current, ceiling = previous, predecessor
        else:
            raise DataError('chainlink_round_budget_exhausted')
        rows.reverse()
        # A timestamp-keyed downstream store cannot represent two different
        # end-of-block states within one second. Do not silently discard either.
        if len({row['timestamp'] for row in rows}) != len(rows):
            raise DataError('chainlink_publication_timestamp_ambiguous')
        oldest = self._block(rows[0]['provenance']['publicationBlock']['number'])
        preceding = self._block(oldest.number - 1)
        for boundary in (oldest, preceding):
            if self._configuration(boundary) != config:
                raise DataError('chainlink_configuration_changed')
        self._proof_blocks.update((snapshot.number, end_block.number))
        # EIP-1898 pins the historical reads; these checks additionally ensure
        # all returned publication and predecessor headers are still canonical.
        for number in sorted(self._proof_blocks):
            known = self._block(number)
            actual = parse_block(self._request('eth_getBlockByNumber', [known.tag, False]))
            if actual != known:
                raise DataError('chainlink_snapshot_reorganized')
        return {
            'observations': rows, 'snapshot': asdict(snapshot),
            'feed': {**asdict(self._feed), 'source': SOURCE, 'proxyRole': 'standard',
                     'manifestSha256': MANIFEST_SHA256,
                     'currency': currency, 'currencyDecimals': config['currencyDecimals'],
                     'configurationScope': 'proxy_phase_asset_and_precision'},
            'coverage': {
                'status': 'observed_unqualified', 'startTimestamp': start,
                'endTimestamp': end, 'endBlock': asdict(end_block),
                'precedingObservationIncluded': rows[0]['timestamp'] < start,
                'roundCount': len(rows), 'maxRounds': MAX_ROUNDS,
                'phaseTraversal': False, 'publicationBlocksVerified': True,
                'freshnessAssessed': False, 'sequencerHistoryAssessed': False,
                'withinSecondOrderingSupported': False,
            },
        }

    def _check_deadline(self):
        if time.monotonic() > self._deadline:
            raise DataError('chainlink_deadline_exhausted')

    def _request(self, method, params=()):
        self._check_deadline()
        return self.rpc.request(method, params)

    def _call(self, target, signature, block, *, inputs=(), values=(), outputs=()):
        self._check_deadline()
        return self.rpc.call(target, signature, inputs, values, outputs,
                             block={'blockHash': block.hash, 'requireCanonical': True})

    def _block(self, number):
        if number < 0:
            raise DataError('chainlink_history_boundary_unavailable')
        if number not in self._headers:
            block = parse_block(self._request('eth_getBlockByNumber', [hex(number), False]))
            if block.number != number:
                raise DataError('chainlink_block_number_mismatch')
            for previous in self._headers.values():
                if ((number < previous.number and block.timestamp > previous.timestamp) or
                        (number > previous.number and block.timestamp < previous.timestamp)):
                    raise DataError('chainlink_block_time_inverted')
            self._headers[number] = block
        return self._headers[number]

    def _configuration(self, block):
        if block.number in self._config_cache:
            return self._config_cache[block.number]
        feed = self._feed
        aggregator, = self._call(feed.proxy, 'aggregator()', block, outputs=('address',))
        phase, = self._call(feed.proxy, 'phaseId()', block, outputs=('uint16',))
        decimals, = self._call(feed.proxy, 'decimals()', block, outputs=('uint8',))
        description, = self._call(feed.proxy, 'description()', block, outputs=('string',))
        if phase != feed.phase:
            raise DataError('chainlink_phase_boundary')
        mapped, = self._call(feed.proxy, 'phaseAggregators(uint16)', block,
                             inputs=('uint16',), values=(phase,), outputs=('address',))
        if (address(aggregator) != feed.aggregator or address(mapped) != feed.aggregator or
                type(decimals) is not int or decimals != feed.decimals or
                description != feed.description):
            raise DataError('chainlink_configuration_changed')
        if self._currency == ZERO:
            currency_decimals = 18
        else:
            currency_decimals, = self._call(self._currency, 'decimals()', block, outputs=('uint8',))
            if type(currency_decimals) is not int or not 0 <= currency_decimals <= 255:
                raise DataError('chainlink_currency_decimals_invalid')
            if currency_decimals != (6 if self._currency == USDG else 18):
                raise DataError('chainlink_currency_decimals_mismatch')
        result = {'aggregator': aggregator, 'phaseId': phase, 'feedDecimals': decimals,
                  'description': description, 'currencyDecimals': currency_decimals}
        self._config_cache[block.number] = result
        return result

    def _parse_round(self, values, block, *, expected=None):
        if (not isinstance(values, (tuple, list)) or len(values) != 5 or
                any(type(value) is not int for value in values)):
            raise DataError('chainlink_invalid_round')
        row = Round(*values)
        if (not 0 < row.id < 2 ** 80 or not row.id & ROUND_MASK or
                not 0 < row.answer < 2 ** 255 or
                not 0 < row.started_at <= row.updated_at <= block.timestamp or
                row.answered_in_round != row.id or
                (expected is not None and row.id != expected)):
            raise DataError('chainlink_invalid_round')
        if row.id >> 64 != self._feed.phase:
            raise DataError('chainlink_phase_boundary')
        previous = self._round_cache.get(row.id)
        if previous is not None and row != previous:
            raise DataError('chainlink_round_revision')
        self._round_cache[row.id] = row
        return row

    def _latest(self, block):
        if block.number not in self._latest_cache:
            row = self._parse_round(self._call(self._feed.proxy, 'latestRoundData()', block,
                                              outputs=ROUND_TYPES), block)
            for number, prior in self._latest_cache.items():
                if ((block.number < number and row.id > prior.id) or
                        (block.number > number and row.id < prior.id)):
                    raise DataError('chainlink_round_order_inverted')
                if ((block.number < number and row.updated_at > prior.updated_at) or
                        (block.number > number and row.updated_at < prior.updated_at)):
                    raise DataError('chainlink_round_time_inverted')
            self._latest_cache[block.number] = row
        return self._latest_cache[block.number]

    def _get_round(self, round_id, block):
        # Always ask getRoundData, even if latestRoundData supplied that round;
        # missing history and discrepancies are errors, not inferred answers.
        values = self._call(self._feed.proxy, 'getRoundData(uint80)', block,
                            inputs=('uint80',), values=(round_id,), outputs=ROUND_TYPES)
        return self._parse_round(values, block, expected=round_id)

    def _first_at_or_after(self, timestamp, ceiling):
        if ceiling.timestamp < timestamp:
            raise DataError('chainlink_history_boundary_unavailable')
        low, high = 0, ceiling.number
        while low < high:
            middle = (low + high) // 2
            if self._block(middle).timestamp < timestamp:
                low = middle + 1
            else:
                high = middle
        if self._block(low).timestamp < timestamp:
            raise DataError('chainlink_history_boundary_unavailable')
        if low and self._block(low - 1).timestamp >= timestamp:
            raise DataError('chainlink_block_time_inverted')
        return low

    def _publication(self, row, ceiling):
        low = self._first_at_or_after(row.updated_at, ceiling)
        high = low
        if self._latest(self._block(low)).id < row.id:
            # Reports normally publish near updatedAt even when the next known
            # round is hours later. Bracket that short delay before bisecting;
            # do not make expensive archive calls across the whole stale tail.
            origin, step = low, 1
            while True:
                if high == ceiling.number:
                    raise DataError('chainlink_publication_unavailable')
                high = min(origin + step, ceiling.number)
                if self._latest(self._block(high)).id >= row.id:
                    break
                low, step = high, step * 2
            low += 1  # The preceding bracket endpoint is known not to expose it.
        while low < high:
            middle = (low + high) // 2
            if self._latest(self._block(middle)).id < row.id:
                low = middle + 1
            else:
                high = middle
        publication, preceding = self._block(low), self._block(low - 1)
        if self._latest(publication) != row or self._get_round(row.id, publication) != row:
            raise DataError('chainlink_publication_round_mismatch')
        if self._latest(preceding).id >= row.id:
            raise DataError('chainlink_publication_not_first')
        self._proof_blocks.update((publication.number, preceding.number))
        return publication, preceding
