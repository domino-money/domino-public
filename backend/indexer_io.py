"""Read-only I/O helpers for the bounded indexers (never the public read path).

The public read path caps one HTTP request at 8 seconds because a browser is
waiting behind it. An indexer chunk is not a user request: it is a bounded
batch of work whose whole point is to move millions of blocks, and the provider
answers a filtered `eth_getLogs` for a wide range in a few seconds. These
helpers keep the indexer's own budget explicit instead of inheriting the
browser-facing one, and read block headers in batched envelopes instead of one
round trip per event block.
"""
from discovery import DataError, json_http, parse_block
from read_deadline import ReadDeadline, current_read_deadline, use_read_deadline

# Measured against Alchemy Robinhood (2026-09-15): one round trip is about
# 0.45-0.6 s, so a hundred sequential header reads cost ~46 s and a batched
# envelope costs one round trip. The per-request ceiling is what actually bounds
# a wide log range; the public 8 s ceiling is a browser budget, not a provider
# limit.
INDEXER_REQUEST_TIMEOUT = 30
# Measured against Alchemy Robinhood: 200 headers cost 16.1 s in envelopes of
# 8 and 2.2 s in envelopes of 200, so the indexer uses large envelopes while the
# browser-facing read path keeps its own smaller cap.
INDEXER_BATCH_ITEMS = 100
# A dense factory burst can put thousands of Initialize events in one chunk; the
# indexer reads them while the browser-facing path keeps its 2 MB ceiling.
INDEXER_MAX_RESPONSE_BYTES = 32_000_000
# Events one chunk may carry; the byte cap above is the real memory bound.
MAX_CHUNK_EVENTS = 20_000
# Design ceiling for one indexer chunk. Alchemy Robinhood answered a filtered
# range of 100k blocks in ~4 s and rejected 1M blocks outright, so the useful
# range is bounded by response size, not by this number.
MAX_INDEXER_SPAN = 100_000


def indexer_transport(seconds=90, request_timeout=INDEXER_REQUEST_TIMEOUT,
                      max_bytes=INDEXER_MAX_RESPONSE_BYTES):
    parent = current_read_deadline()
    deadline = ReadDeadline(seconds, parents=(parent,) if parent else ())

    def transport(url, body=None):
        with use_read_deadline(deadline) as active:
            return json_http(url, body, timeout=active.timeout(request_timeout),
                             max_bytes=max_bytes)
    return transport


class HeaderBudget:
    """Hard ceiling on header reads in one invocation.

    A dense pool costs one header per distinct event block, and a deep backfill
    across many pools multiplies that without bound. A budget turns "the walk
    keeps going" into "the walk stops and says so", which is the only way an
    operator can keep a provider bill predictable.
    """

    def __init__(self, max_calls):
        if type(max_calls) is not int or max_calls < 0:
            raise DataError('invalid_header_budget')
        self.max_calls, self.calls = max_calls, 0

    def spend(self, count):
        if count < 0:
            raise DataError('invalid_header_budget')
        if self.calls + count > self.max_calls:
            raise DataError('header_budget_exhausted')
        self.calls += count


def read_headers(rpc, numbers, *, batch_items=INDEXER_BATCH_ITEMS, request=None, cache=None,
                 budget=None):
    """Return {block number: parsed block} for distinct numbers, batched.

    Every header is parsed with the same `parse_block` validation the sequential
    path used, so a truncated or inconsistent answer fails exactly as before.
    Batching is an envelope change only: the same calls, the same checks, one
    round trip per `batch_items` calls.

    A caller may pass a `cache` (number → block) shared across pools and chunks,
    so the same block is never paid for twice, and a `budget` that counts only
    the headers actually fetched.
    """
    wanted = []
    for number in numbers:
        if type(number) is not int or number < 0:
            raise DataError('invalid_block_number')
        if number not in wanted:
            wanted.append(number)
    if not wanted:
        return {}
    missing = [number for number in wanted if cache is None or number not in cache]
    if budget is not None:
        budget.spend(len(missing))
    if not missing:
        return {number: cache[number] for number in wanted}
    request = request or rpc.request
    batch = getattr(rpc, 'batch', None)
    fetched = {}
    if not callable(batch) or batch_items < 1:
        for number in missing:
            block = parse_block(request('eth_getBlockByNumber', [hex(number), False]))
            if block.number != number:
                raise DataError('unexpected_block_number')
            fetched[number] = block
    else:
        for index in range(0, len(missing), batch_items):
            chunk = missing[index:index + batch_items]
            results = batch([('eth_getBlockByNumber', [hex(number), False]) for number in chunk])
            for number, raw in zip(chunk, results):
                block = parse_block(raw)
                if block.number != number:
                    raise DataError('unexpected_block_number')
                fetched[number] = block
    if cache is None:
        return fetched
    cache.update(fetched)
    return {number: cache[number] for number in wanted}


class AdaptiveSpan:
    """Chunk span that shrinks on provider/size rejection and regrows after wins.

    A wide range is the cheapest way to walk history, but a dense pool can make
    one range exceed the response ceiling. The span is a resource parameter, not
    a correctness one: every accepted chunk is still validated and reconciled by
    the indexer, and a rejected range commits nothing.
    """
    SHRINK_REASONS = frozenset({'response_too_large', 'activity_log_budget_exhausted',
                                'invalid_logs_response', 'read_deadline_exceeded',
                                'http_400', 'invalid_rpc_batch'})

    def __init__(self, span, *, floor=1000, ceiling=100_000, growth_passes=8):
        if not 1 <= floor <= span <= ceiling:
            raise DataError('invalid_span_bounds')
        if type(growth_passes) is not int or growth_passes < 1:
            raise DataError('invalid_span_bounds')
        self.span, self.floor, self.ceiling = span, floor, ceiling
        self.growth_passes = growth_passes
        self.successes = 0
        self.shrinks = 0

    def next_span(self):
        return self.span

    def record(self, reason=None):
        """Update the span from one pass outcome; returns the span to use next."""
        if reason is None:
            self.successes += 1
            if self.successes >= self.growth_passes and self.span < self.ceiling:
                self.span, self.successes = min(self.ceiling, self.span * 2), 0
            return self.span
        if reason in self.SHRINK_REASONS and self.span > self.floor:
            self.successes = 0
            self.shrinks += 1
            self.span = max(self.floor, self.span // 4)
        return self.span

    def as_dict(self):
        return {'spanBlocks': self.span, 'spanFloor': self.floor, 'spanCeiling': self.ceiling,
                'shrinks': self.shrinks}
