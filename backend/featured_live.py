"""Featured pools, live: the day's draft becomes the served list (featured_current).

Each tick of the service, in this order:
- mode: `off` serves an empty list, `manual` the owner's pools (safety rules
  only), `auto` the day's selection;
- keep warm: the served list, today's draft, the manual and embedded lists
  stay in the collector's week tier (044) for the next 26 hours;
- warm-up, 11:30-12:25 UTC: the draft's newcomers get their verified identity
  into the catalogue once, then are asked for as a visitor would ask, so the
  collector refreshes them every 5 s and builds their chart;
- publication, 12:00-12:30 UTC: the draft as soon as every newcomer is ready
  (an available estimate, both tokens' decimals, two complete hourly candles);
  from 12:25 it is composed again without the newcomers still warming; after
  12:30 the served list stays, as carried_over. An owner's list (manual or
  none) is not carried: it stays until a selection is published, so `mode
  auto` takes effect at the next selection (featured-pools v1 §8.2);
- health, all day: a served pool that breaks a safety rule leaves at once, or
  once the condition has held for its window, and the list is repaired from
  the day's ranked pools and the embedded list (featured-pools v1 §6.5). A
  list left short because no replacement was ready then takes one as soon as
  one is (#278): its next candidates are kept warm and looked at again every
  few minutes, without waiting for another pool to leave.
"""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from fractions import Fraction

from discovery import Block, DataError, DiscoveryReader
from featured_contract import prune_withdrawn
import featured_evidence as evidence
import featured_pools as rules
from featured_selector import list_entry
from featured_store import utc_date
from pool_apr import estimate_pool_apr
from public_observations import aged_market

WARM_SECONDS = 26 * 3600
# keep_warm_until is written again once less than this remains, not every tick.
WARM_REFRESH_SECONDS = 25 * 3600
READY_BY_MINUTES = 25
PUBLISH_BY_MINUTES = 30
TOKEN_CHECK_SECONDS = 3600
# How long a condition must hold before the pool leaves, and whether it also
# removes a pin or a manual pool (safety) or only a ranked one (market).
CONFIRM = {'tvl_collapse': (600, True), 'price_fall': (600, True),
           'apr_or_turnover_above_ceiling': (1800, True),
           'estimate_unavailable': (3 * 3600, False), 'volume_collapse': (3 * 3600, False)}
PRICE_FALL = Fraction(3, 10)
# A pool whose estimate is missing only because its data is late or the
# provider is busy is not judged on that: it is unknown, not a fault of the
# pool (#278). The collector starved the listed pools for an hour and the
# provider rate-limited it all day, and every listed pool left within hours.
# Data last good longer ago than this counts again, so a pool the provider has
# stopped answering for still leaves.
TRANSIENT_DATA_SECONDS = 6 * 3600
LATE_DATA = frozenset(('snapshot_expired', 'market_data_expired', 'market_age_unknown'))
BUSY_PROVIDER = frozenset(('provider_rate_limited', 'provider_capacity_busy', 'provider_unavailable'))
# A short list looks for ready replacements at most this often, and keeps this
# many candidates beyond its vacancies warm for this long, so that one is
# refreshed often enough to be ready when it is looked at (#278).
VACANCY_SECONDS = 120
SPARE_CANDIDATES = 2
CANDIDATE_WARM_SECONDS = 3600


def window(policy, now):
    """(first attempt, last attempt, selection time) for the UTC date of `now`."""
    at = int(datetime.fromtimestamp(now, timezone.utc).replace(
        hour=policy['selectionHourUtc'], minute=0, second=0, microsecond=0).timestamp())
    return at - policy['selectionLeadMinutes'] * 60, at - policy['selectionRetryUntilMinutes'] * 60, at


def transient(estimate):
    """An unavailable estimate whose only causes are late data or a busy provider, within the horizon."""
    reasons, provenance = set(estimate['reasons']), estimate['provenance']
    if 'market_unavailable' in reasons and provenance['marketReason'] in BUSY_PROVIDER:
        # With no answer from the provider there is no TVL or volume to read either.
        reasons -= {'market_unavailable', 'missing_reported_tvl', 'missing_volume24h'}
    ages = [age for age in (provenance['effectiveMarketAgeSeconds'], provenance['snapshotAgeSeconds']) if age is not None]
    return reasons <= LATE_DATA and all(age <= TRANSIENT_DATA_SECONDS for age in ages)


def _decimal(value):
    try:
        return Decimal(value) if value is not None else None
    except (InvalidOperation, TypeError, ValueError):
        return None


class Live:
    def __init__(self, *, store, public, history, catalogue, policy, selector, rpc_factory, embedded):
        self.store, self.public, self.history, self.catalogue = store, public, history, catalogue
        self.policy, self.selector, self.rpc_factory = policy, selector, rpc_factory
        self.embedded = list(embedded)
        self.tokens_checked_at = None
        self.manual_checked = None
        self.vacancies_checked_at = None
        self.candidates_read = None   # (served revision, read at, pool ids)

    # ------------------------------------------------------------ reading
    def _in_catalogue(self, pool_id):
        with self.catalogue.connection() as conn:
            return conn.execute('''SELECT 1 FROM domino_catalogue.events WHERE pool_id=%s UNION ALL
              SELECT 1 FROM domino_catalogue.hints WHERE pool_id=%s LIMIT 1''', (pool_id, pool_id)).fetchone() is not None

    def readiness(self, pool_ids, now):
        """{poolId: None when the site can show it now, else the first thing missing}."""
        result = {}
        for pool_id in pool_ids:
            row = self.public.get('pool', pool_id)
            if row is None or row['payload'] is None:
                result[pool_id] = 'figures_pending'
                continue
            aged = aged_market(row['payload'], row['observed_at'], now)
            try:
                estimate = estimate_pool_apr(aged, now=now)
            except ValueError:
                result[pool_id] = 'figures_invalid'
                continue
            if estimate['status'] != 'available':
                result[pool_id] = 'estimate_not_available'
                continue
            currencies = aged['pool']['currencies']
            tokens = [self.public.get('token', currency) for currency in currencies]
            if any(token is None or token['payload'] is None or
                   type(token['payload'].get('asset', {}).get('decimals')) is not int for token in tokens):
                result[pool_id] = 'token_decimals_pending'
                continue
            try:
                chart = self.history.read(pool_id, currencies[0], 86400, 3600)
            except DataError:
                result[pool_id] = 'chart_pending'
                continue
            result[pool_id] = None if sum(1 for candle in chart['candles'] if candle['complete']) >= 2 else 'chart_pending'
        return result

    # ------------------------------------------------------------ serving
    def _serve(self, status, payload, *, day, run_id, now, generated_at=None, valid_until=None):
        entries = [{**entry, 'slot': index} for index, entry in enumerate(payload['pools'], start=1)]
        listed = {entry['poolId'] for entry in entries}
        # A pool listed again (chosen by a selection, or by the owner) is no longer withdrawn.
        payload = {**payload, 'pools': entries, 'listId': rules.list_id(entries),
                   'withdrawn': [item for item in payload.get('withdrawn', []) if item['poolId'] not in listed]}
        generated = now if generated_at is None else generated_at
        until = max(now, now + self.policy['validHours'] * 3600 if valid_until is None else valid_until)
        return self.store.serve(status=status, payload=payload, day=day, run_id=run_id,
                                generated_at=generated, effective_at=max(now, generated), valid_until=until)

    def _serve_off(self, served, now, day):
        if served is not None and served['status'] == 'none':
            return {'status': 'none'}
        withdrawn = served['payload'].get('withdrawn', []) if served else []
        revision = self._serve('none', {'schemaVersion': 1, 'phase': 'live', 'pools': [], 'generatedAt': now,
                                        'withdrawn': prune_withdrawn(withdrawn, now)},
                               day=day, run_id=None, now=now)
        return {'status': 'served_none', 'revision': revision}

    def _serve_manual(self, served, overrides, now, day):
        """The owner's pools, each checked against the safety rules now."""
        wanted = overrides['manualPools'][:self.policy['size']]
        if served is not None and served['status'] == 'manual' and self.manual_checked == tuple(wanted):
            return {'status': 'manual'}
        evaluations = {item['poolId']: item for item in self.selector.check(wanted, now=now)}
        entries, dropped = [], []
        for pool_id in wanted:
            item = evaluations.get(pool_id)
            if item is None or not item['safe']:
                dropped.append({'poolId': pool_id, 'reasons': item['reasons'] if item else ['not_evaluated']})
                continue
            entries.append(list_entry({'slot': 0, 'source': 'manual', 'poolId': pool_id}, item))
        self.manual_checked = tuple(wanted)
        if (served is not None and served['status'] == 'manual'
                and [entry['poolId'] for entry in served['payload']['pools']] == [e['poolId'] for e in entries]):
            return {'status': 'manual', 'dropped': dropped}
        withdrawn = served['payload'].get('withdrawn', []) if served else []
        revision = self._serve('manual', {'schemaVersion': 1, 'phase': 'live', 'pools': entries, 'generatedAt': now,
                                          'dropped': dropped, 'withdrawn': prune_withdrawn(withdrawn, now)},
                               day=day, run_id=None, now=now)
        return {'status': 'served_manual', 'revision': revision, 'dropped': dropped}

    def _keep_warm(self, served, draft, overrides, now):
        pool_ids = set(self.embedded) | set(overrides['manualPools'])
        for revision in (served, draft):
            if revision is not None:
                pool_ids |= {entry['poolId'] for entry in revision['payload']['pools']}
        # A short list's next candidates, for an hour: refreshed with the listed
        # pools, one of them is ready when the list looks for a replacement.
        candidates = set(self._candidates(served, overrides, now)) - pool_ids if self._fillable(served) else set()
        with self.public.connection(write=True) as conn:
            kept = 0
            for ids, until, refresh in ((pool_ids, WARM_SECONDS, WARM_REFRESH_SECONDS),
                                        (candidates, CANDIDATE_WARM_SECONDS, CANDIDATE_WARM_SECONDS // 2)):
                kept += conn.execute('''UPDATE domino_public.entities SET keep_warm_until=to_timestamp(%s)
                  WHERE kind='pool' AND entity_id=ANY(%s)
                    AND (keep_warm_until IS NULL OR keep_warm_until<to_timestamp(%s))''',
                  (now + until, sorted(ids), now + refresh)).rowcount
            return kept

    def _warm_up(self, draft, served, now):
        """Seed the newcomers' identity once, then ask for them as a visitor would."""
        served_ids = {entry['poolId'] for entry in served['payload']['pools']} if served else set()
        newcomers = [entry for entry in draft['payload']['pools'] if entry['poolId'] not in served_ids]
        seeded, asked, waiting = [], [], []
        for entry in newcomers:
            if not self._in_catalogue(entry['poolId']):
                key = {name: value for name, value in entry['poolKey'].items() if name != 'feeMode'}
                try:
                    self.catalogue.seed([{'poolId': entry['poolId'], 'poolKey': key}],
                                        Block(entry['verifiedAt']['number'], entry['verifiedAt']['hash'], 0))
                except DataError:
                    # The follower holds the writer lock about 50 s a minute; the next tick tries again.
                    waiting.append(entry['poolId'])
                    continue
                seeded.append(entry['poolId'])
            # Never ask for a pool before its identity is in the catalogue: the
            # collector would reject an unresolvable key for a day.
            asked.append(entry['poolId'])
        if asked:
            self.public.request_many('pool', asked[:24])
        return {'status': 'warming', 'seeded': seeded, 'asked': asked, 'identityWaiting': waiting}

    def _published(self, served, day):
        return (served is not None and served['selection_date'] == day
                and served['status'] in ('current', 'carried_over', 'repaired'))

    def _carry(self, served, now, day):
        if served is None or served['status'] in ('manual', 'none'):
            return {'status': 'nothing_to_carry'}
        revision = self.store.serve(status='carried_over', payload=served['payload'], day=day,
                                    run_id=served['run_id'], generated_at=served['generated_at'],
                                    effective_at=served['effective_at'], valid_until=served['valid_until'])
        return {'status': 'carried_over', 'revision': revision}

    def _recompose(self, draft, evaluations, served, overrides, unready, now):
        """The day's list again, with only newcomers that are ready now."""
        served_ids = [entry['poolId'] for entry in served['payload']['pools']] if served else []
        blocked, composed = set(unready), None
        for _ in range(len(evaluations) + 1):
            trial = [{**item, 'eligible': False} if item['poolId'] in blocked else item for item in evaluations]
            composed = rules.compose(trial, self.policy, previous_list=[{'poolId': pool_id} for pool_id in served_ids],
                                     pins=overrides['pins'], embedded=self.embedded)
            fresh = [entry['poolId'] for entry in composed['pools'] if entry['poolId'] not in served_ids]
            late = {pool_id for pool_id, reason in self.readiness(fresh, now).items() if reason}
            if not late:
                break
            blocked |= late
        if composed['status'] != 'current':
            return None
        by_id = {item['poolId']: item for item in evaluations}
        entries = [list_entry(entry, by_id[entry['poolId']]) for entry in composed['pools']]
        return {**draft['payload'], 'pools': entries, 'rankedSwaps': composed['rankedSwaps'],
                'withheld': sorted(blocked)}

    def _publish(self, draft, served, overrides, now, day, at):
        if self._published(served, day):
            return {'status': 'published'}
        if now >= at + PUBLISH_BY_MINUTES * 60:
            return self._carry(served, now, day)
        if draft is None:
            return {'status': 'no_draft'}
        if day.isoformat() in overrides['vetoes']:
            return {'status': 'vetoed'}
        served_ids = {entry['poolId'] for entry in served['payload']['pools']} if served else set()
        newcomers = [entry['poolId'] for entry in draft['payload']['pools'] if entry['poolId'] not in served_ids]
        unready = {pool_id: reason for pool_id, reason in self.readiness(newcomers, now).items() if reason}
        if unready and now < at + READY_BY_MINUTES * 60:
            return {'status': 'warming', 'unready': unready}
        payload = draft['payload']
        if unready:
            run = self.store.run(draft['run_id'])
            payload = self._recompose(draft, run['evaluation']['evaluations'], served, overrides, unready, now)
            if payload is None:
                return self._carry(served, now, day)
        withdrawn = served['payload'].get('withdrawn', []) if served else []
        revision = self._serve('current', {**payload, 'withdrawn': prune_withdrawn(withdrawn, now)},
                               day=day, run_id=draft['run_id'], now=now, generated_at=payload['generatedAt'])
        return {'status': 'served', 'revision': revision, 'withheld': sorted(unready)}

    # ------------------------------------------------------------ health
    def _pool_health(self, entry, overrides, now):
        """(reasons that remove the pool at once, conditions it shows now)."""
        pool_id, reasons, seen = entry['poolId'], [], set()
        tokens = [token['address'] for token in entry.get('tokens') or ()]
        if pool_id in overrides['excludedPools'] or any(token in overrides['excludedTokens'] for token in tokens):
            reasons.append('excluded_by_owner')
        row = self.public.get('pool', pool_id)
        if row is None or row['payload'] is None:
            seen.add('estimate_unavailable')
            return reasons, seen
        aged = aged_market(row['payload'], row['observed_at'], now)
        pool, thresholds = aged['pool'], self.policy['thresholds']
        if pool['integrationClass'] != 'hookless_fixed_fee':
            reasons.append('pool_integration_unsupported')
        elif pool['poolKey']['fee_pips'] != pool['currentLpFeePips']:
            reasons.append('fixed_fee_mismatch')
        protocol = pool['protocolFeeRaw']
        if (protocol & 0xfff) > 1000 or (protocol >> 12) > 1000:
            reasons.append('invalid_protocol_fee')
        elif (protocol & 0xfff) != (protocol >> 12):
            reasons.append('protocol_fee_directional_unsupported')
        try:
            estimate = estimate_pool_apr(aged, now=now)
        except ValueError:
            estimate = None
        if estimate is None or (estimate['status'] == 'unavailable' and not transient(estimate)):
            seen.add('estimate_unavailable')
        data = aged['market'].get('data')
        if data is not None:
            tvl, volume = _decimal(data['reportedLiquidityUsd']), _decimal(data['volume24hUsd'])
            apr = _decimal(estimate['feeAprEstimate24hPercent']) if estimate else None
            if tvl is not None and tvl < Decimal(thresholds['minTvlUsd']) / 2:
                seen.add('tvl_collapse')
            if volume is not None and volume < Decimal(thresholds['minVolume24hUsd']) / 10:
                seen.add('volume_collapse')
            ceiling, turnover = thresholds['maxAprPercent'], thresholds['maxTurnover24h']
            # A policy with no ceiling (null) watches neither.
            if ((ceiling is not None and apr is not None and apr > Decimal(ceiling)) or
                    (turnover is not None and tvl and volume is not None and volume / tvl > Decimal(turnover))):
                seen.add('apr_or_turnover_above_ceiling')
        start, reference = entry.get('selectionSqrtPriceX96'), entry.get('reference')
        if start and reference in pool['currencies']:
            ratio = Fraction(int(pool['sqrtPriceX96']) ** 2, int(start) ** 2)   # currency1 per currency0, now / then
            other = ratio if reference == pool['currencies'][1] else 1 / ratio
            if other < PRICE_FALL:
                seen.add('price_fall')
        return reasons, seen

    def _token_checks(self, entries, now):
        """TA-5 once an hour: listed tokens whose code differs from when first listed."""
        if self.tokens_checked_at is not None and now - self.tokens_checked_at < TOKEN_CHECK_SECONDS:
            return set()
        self.tokens_checked_at = now
        baselines = self.store.token_baselines()
        tokens = sorted({token['address'] for entry in entries for token in entry.get('tokens') or ()
                         if token['address'] in baselines})
        if not tokens:
            return set()
        rpc = self.rpc_factory()
        block = DiscoveryReader(rpc).snapshot()
        return {token for token in tokens
                if evidence.code_hash(rpc, token, block) != baselines[token]['listed_code_hash']}

    def _health(self, served, overrides, now):
        if served is None or not served['payload']['pools']:
            self.store.observe_health({}, now)
            # A list every pool has left still takes replacements once they are ready.
            return self._fill_vacancies(served, overrides, now) if self._fillable(served) else {'status': 'idle'}
        entries = {entry['poolId']: entry for entry in served['payload']['pools']}
        immediate, seen = {}, {}
        for pool_id, entry in entries.items():
            reasons, conditions = self._pool_health(entry, overrides, now)
            if reasons:
                immediate[pool_id] = reasons[0]
            seen[pool_id] = conditions
        changed = self._token_checks(list(entries.values()), now)
        for pool_id, entry in entries.items():
            if any(token['address'] in changed for token in entry.get('tokens') or ()):
                immediate.setdefault(pool_id, 'token_code_changed')
        state = self.store.observe_health(seen, now)
        confirmed = {}
        for (pool_id, condition), (first_seen, checks) in sorted(state.items()):
            hold, owners_too = CONFIRM[condition]
            if checks >= 2 and now - first_seen >= hold and (owners_too or entries[pool_id]['source'] not in ('pinned', 'manual')):
                confirmed.setdefault(pool_id, condition)
        removed = {**confirmed, **immediate}
        for token in sorted(changed):
            self.store.add_override('exclude_token', token, reason='token_code_changed: code differs from when first listed')
        if removed:
            return self._repair(served, removed, overrides, now)
        if len(entries) < self.policy['size'] and self._fillable(served):
            return self._fill_vacancies(served, overrides, now)
        return {'status': 'healthy'}

    def _fillable(self, served):
        """A list the day's ranked pools complete: not the owner's, not none."""
        return served is not None and served['status'] not in ('manual', 'none')

    def _evaluations(self, withdrawn, overrides, now):
        """The latest selection's evaluations, without the pools withdrawn this week; none from a
        selection the owner vetoed, whose pools must not be served."""
        run = self.store.latest_run(within_hours=self.policy['persistenceLookbackHours'], now=now)
        if run is None or (run['selection_date'] is not None and run['selection_date'].isoformat() in overrides['vetoes']):
            return []
        # A pool withdrawn this week comes back only when a selection chooses it again.
        gone = {item['poolId'] for item in withdrawn}
        return [item for item in run['evaluation']['evaluations'] if item['poolId'] not in gone]

    def _candidates(self, served, overrides, now):
        """The pools that would complete a short list were they ready, and a few beyond, in order.
        Read again when the served list changes, and otherwise at most every VACANCY_SECONDS."""
        kept = [entry['poolId'] for entry in served['payload']['pools']]
        if len(kept) >= self.policy['size']:
            return []
        cached = self.candidates_read
        if cached is not None and cached[0] == served['revision'] and now - cached[1] < VACANCY_SECONDS:
            return cached[2]
        evaluations = self._evaluations(served['payload'].get('withdrawn', []), overrides, now)
        wider = {**self.policy, 'size': self.policy['size'] + SPARE_CANDIDATES}
        ids = [item['poolId'] for item in rules.refill(kept, evaluations, wider, embedded=self.embedded)]
        self.candidates_read = (served['revision'], now, ids)
        return ids

    def _replacements(self, kept, withdrawn, overrides, now):
        """Ranked pools, then the embedded list's, that complete the list and are ready now."""
        evaluations = self._evaluations(withdrawn, overrides, now)
        by_id = {item['poolId']: item for item in evaluations}

        def entry_of(pool_id, source):
            return list_entry({'slot': 0, 'source': source, 'poolId': pool_id}, by_id[pool_id])

        def fit(pool_id):
            """The site can show it now, and it shows no condition that would remove it."""
            if self.readiness([pool_id], now)[pool_id] is not None:
                return False
            reasons, seen = self._pool_health(entry_of(pool_id, 'ranked'), overrides, now)
            return not reasons and not seen
        return [entry_of(item['poolId'], item['source'])
                for item in rules.refill([entry['poolId'] for entry in kept], evaluations, self.policy,
                                         embedded=self.embedded, ready=fit)]

    def _fill_vacancies(self, served, overrides, now):
        """A short list takes the replacements ready now, looked for at most every VACANCY_SECONDS."""
        kept = served['payload']['pools']
        # Nothing left the list: `healthy`, or `idle` when it is empty, with its vacancies.
        quiet = {'status': 'healthy' if kept else 'idle', 'vacant': self.policy['size'] - len(kept)}
        if self.vacancies_checked_at is not None and now - self.vacancies_checked_at < VACANCY_SECONDS:
            return quiet
        self.vacancies_checked_at = now
        withdrawn = served['payload'].get('withdrawn', [])
        added = self._replacements(kept, withdrawn, overrides, now)
        if not added:
            return quiet
        revision = self._serve('repaired', {**served['payload'], 'pools': kept + added,
                                            'withdrawn': prune_withdrawn(withdrawn, now)},
                               day=served['selection_date'], run_id=served['run_id'], now=now,
                               valid_until=served['valid_until'])
        return {'status': 'refilled', 'revision': revision, 'added': [entry['poolId'] for entry in added]}

    def _repair(self, served, removed, overrides, now):
        kept = [entry for entry in served['payload']['pools'] if entry['poolId'] not in removed]
        withdrawn = served['payload'].get('withdrawn', []) + [
            {'poolId': pool_id, 'reason': reason, 'at': now} for pool_id, reason in sorted(removed.items())]
        added = self._replacements(kept, withdrawn, overrides, now) if served['status'] != 'manual' else []
        # The search just ran: a list still short looks again only after VACANCY_SECONDS.
        self.vacancies_checked_at = now
        status = 'manual' if served['status'] == 'manual' else 'repaired'
        revision = self._serve(status, {**served['payload'], 'pools': kept + added,
                                        'withdrawn': prune_withdrawn(withdrawn, now)},
                               day=served['selection_date'], run_id=served['run_id'], now=now,
                               valid_until=served['valid_until'])
        return {'status': status, 'revision': revision, 'removed': removed,
                'added': [entry['poolId'] for entry in added]}

    # ------------------------------------------------------------ tick
    def withdraw(self, now):
        """Shadow serves nothing: a list served while live gives way to none, not a frozen list."""
        served = self.store.current()
        if served is None or served['status'] == 'none':
            return None
        return self._serve_off(served, now, utc_date(now))

    def tick(self, now):
        overrides = self.store.overrides(now)
        day, report = utc_date(now), {'mode': overrides['mode']}
        served = self.store.current()
        if overrides['mode'] == 'off':
            report['served'] = self._serve_off(served, now, day)
        elif overrides['mode'] == 'manual':
            report['served'] = self._serve_manual(served, overrides, now, day)
        served = self.store.current()
        draft = self.store.draft(day) if overrides['mode'] == 'auto' else None
        report['keptWarm'] = self._keep_warm(served, draft, overrides, now)
        if overrides['mode'] == 'auto':
            first, _, at = window(self.policy, now)
            if draft is not None and first <= now < at + READY_BY_MINUTES * 60 and not self._published(served, day):
                report['warmUp'] = self._warm_up(draft, served, now)
            if now >= at:
                report['publication'] = self._publish(draft, served, overrides, now, day, at)
        if overrides['mode'] != 'off':
            report['health'] = self._health(self.store.current(), overrides, now)
        return report
