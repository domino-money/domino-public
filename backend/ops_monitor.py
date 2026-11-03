"""Domino's production monitor: the services, chains and balances the V2 rollout runs on, checked every minute,
alerts and a daily summary on Telegram, and a public status snapshot for the operator's dashboard
(docs/OPS_MONITOR.md).

It only reads:
- unit states (systemctl show);
- the services' own JSON lines (journalctl, as a member of systemd-journal): the V2 automation's passes (each with
  its journal's intents in 'attention' and its 24-hour gas spend against the daily cap), the V2 indexers' rounds,
  V1's cycles, and the listeners' request lines;
- the chains: operator balances, the own node's head, and the V2 registry's logs, through the same endpoint files
  and sealed URLs as the services;
- the disk.

It never signs, sends no transaction and serves nothing. Its one write outside its own state is the snapshot
(0644: no key, no URL, no token).

Telegram: the bot token is the systemd credential `telegram-bot-token`, never an environment variable. Each request
URL carries the token, so no URL and no transport exception ever reaches a log or a message; a failure becomes a
fixed code. Commands (/status, /help) are answered only in the configured chat. Without a chat (`chatId` null) the
monitor checks and writes the snapshot, and Telegram stays off.
"""
import argparse
from dataclasses import dataclass, field
import datetime
import functools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from discovery import DataError

KIND = 'domino-monitor'
OK, WARN, CRIT = 0, 1, 2
MARK = {OK: '🟢', WARN: '🟡', CRIT: '🔴'}
CONFIG_KEYS = {'schemaVersion', 'kind', 'telegram', 'intervalSeconds', 'summaryHourUtc', 'statusFile', 'stateFile',
               'services', 'timers', 'automation', 'indexers', 'listeners', 'v1Automation', 'chains', 'balances',
               'headLag', 'disk'}
# Optional, with their defaults: a configuration written before them still loads as it is.
OPTIONAL_KEYS = {'featured'}
FEATURED_UNIT = 'domino-featured.service'
UNIT = re.compile(r'[a-z0-9][a-z0-9@._-]{0,120}\.(?:service|timer)')
ADDRESS = re.compile(r'0x[0-9a-f]{40}')
CHAIN = re.compile(r'[a-z0-9]+-[0-9]+')
TOKEN = re.compile(r'[0-9]{5,16}:[A-Za-z0-9_-]{30,64}')
MAX_CONFIG_BYTES = 65536
MAX_JOURNAL_LINES = 5000
MAX_MESSAGE = 3900  # Telegram's limit is 4096 characters
# Persisted levels are confirmed only after this many consecutive cycles, so a
# restart, a slow read or one late pass alerts no one.
CONFIRM_CYCLES = 2
REALERT_CRIT_SECONDS = 3 * 3600
# A V2 intent in 'attention' stops its chain's signer until an operator acknowledges it: no compound, no exit and no
# return is sent there meanwhile. Past this it is critical.
ATTENTION_SECONDS = 15 * 60
# A chain's rolling 24-hour gas spend, as its automation's journal counts it against `gas.dailyCapWei`: a warning from
# this share of the cap, critical at the cap.
GAS_WARN_PERCENT = 80
# The automation's refusal at its daily cap: the gas check says it once, never each pass.
GAS_CAP_REFUSAL = 'v2_daily_gas_cap'
# The Top pools list (featured_live, through `manage_featured.py serve`): one line every 30 s while live, the longest
# silence being a selection's tick (321 s from 20 Oct to 2 Nov 2026).
FEATURED_SILENT_SECONDS = 10 * 60
# The day's list is published by the selection hour + featured_live.PUBLISH_BY_MINUTES (30); then a minute for the
# last tick's line.
FEATURED_PUBLISH_MINUTES = 31
FEATURED_STALE_SECONDS = 2 * 24 * 3600
FEATURED_MIN_POOLS = 3
# Where a monitor without the list's history finds its last publication, once.
FEATURED_BACKFILL_SINCE = '-7d'
FEATURED_SERVED = r'"publication": \{"status": "served"'
RECENT = 50
HOUR = 3600
DAY = 24 * HOUR
WEI = 10**18
# The registry's administrative events (IDominoRegistry): any of them is the owner's business.
CRITICAL_EVENTS = {'AutomationHaltSet', 'OperatorSet', 'PublisherSet', 'FeeRecipientSet', 'GuardianChanged',
                   'GovernanceTransferStarted', 'GovernanceTransferred', 'RouterSet', 'ChangeScheduled'}


class MonitorError(ValueError):
    """A fixed code; never a URL, a token or a provider's text."""


def require(condition, code):
    if not condition:
        raise MonitorError(code)


# ---------------------------------------------------------------- configuration
@dataclass(frozen=True)
class Config:
    credential: str
    chat_id: str | None
    interval: int
    summary_hour: int
    status_file: Path
    state_file: Path
    services: tuple
    timers: dict
    automation: dict
    indexers: dict
    listeners: tuple
    v1_automation: str | None
    chains: dict
    balances: tuple
    head_lag: dict
    disk: dict
    featured: str | None = FEATURED_UNIT


def _int(value, low, high, code):
    require(type(value) is int and low <= value <= high, code)
    return value


def _path(value, code):
    require(type(value) is str and value.startswith('/') and '..' not in Path(value).parts and len(value) < 512, code)
    return Path(value)


def _unit(value, code):
    require(type(value) is str and UNIT.fullmatch(value) is not None, code)
    return value


def checked_config(document):
    """A validated configuration; refuses it whole, with the offending section's code."""
    require(type(document) is dict and CONFIG_KEYS <= set(document) <= CONFIG_KEYS | OPTIONAL_KEYS
            and document.get('schemaVersion') == 1 and type(document['schemaVersion']) is int
            and document.get('kind') == KIND, 'monitor_config_invalid')
    telegram = document['telegram']
    require(type(telegram) is dict and set(telegram) == {'credential', 'chatId'}
            and type(telegram['credential']) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', telegram['credential'])
            and (telegram['chatId'] is None or (type(telegram['chatId']) is str
                                               and re.fullmatch(r'-?[0-9]{1,20}', telegram['chatId']))),
            'monitor_config_telegram')
    services = document['services']
    require(type(services) is list and services and len(set(services)) == len(services), 'monitor_config_services')
    timers = document['timers']
    require(type(timers) is dict, 'monitor_config_timers')
    automation, indexers = document['automation'], document['indexers']
    require(type(automation) is dict and all(
        CHAIN.fullmatch(k) and type(v) is dict and set(v) == {'unit', 'passSeconds'} for k, v in automation.items()),
        'monitor_config_automation')
    require(type(indexers) is dict and all(CHAIN.fullmatch(k) for k in indexers), 'monitor_config_indexers')
    listeners = document['listeners']
    require(type(listeners) is list and len(set(listeners)) == len(listeners), 'monitor_config_listeners')
    chains = document['chains']
    require(type(chains) is dict and all(CHAIN.fullmatch(k) and type(v) is dict and set(v) == {'rpc', 'registry'}
                                         for k, v in chains.items()), 'monitor_config_chains')
    for entry in chains.values():
        rpc = entry['rpc']
        require(type(rpc) is dict and set(rpc) in ({'providerFile', 'nodeUrl'}, {'chainRpcFile'}), 'monitor_config_chains')
        for value in rpc.values():
            if value.startswith('http'):
                # The own node's proxy: loopback only, never a keyed or public URL.
                require(re.fullmatch(r'http://127\.0\.0\.1:[0-9]{2,5}/', value) is not None, 'monitor_config_chains')
            else:
                _path(value, 'monitor_config_chains')
        require(type(entry['registry']) is str and ADDRESS.fullmatch(entry['registry']), 'monitor_config_chains')
    balances = document['balances']
    require(type(balances) is list, 'monitor_config_balances')
    checked_balances = []
    for item in balances:
        require(type(item) is dict and set(item) == {'label', 'chain', 'address', 'warnWei', 'critWei'}
                and type(item['label']) is str and 0 < len(item['label']) <= 40 and item['chain'] in chains
                and type(item['address']) is str and ADDRESS.fullmatch(item['address'])
                and all(type(item[k]) is str and re.fullmatch(r'[0-9]{1,30}', item[k]) for k in ('warnWei', 'critWei'))
                and int(item['critWei']) <= int(item['warnWei']), 'monitor_config_balances')
        checked_balances.append({**item, 'warnWei': int(item['warnWei']), 'critWei': int(item['critWei'])})
    head = document['headLag']
    require(type(head) is dict and set(head) == {'chain', 'warnSeconds', 'critSeconds'} and head['chain'] in chains
            and 'nodeUrl' in chains[head['chain']]['rpc'], 'monitor_config_head_lag')
    _int(head['warnSeconds'], 30, 3600, 'monitor_config_head_lag')
    require(_int(head['critSeconds'], 60, 86400, 'monitor_config_head_lag') > head['warnSeconds'],
            'monitor_config_head_lag')
    disk = document['disk']
    require(type(disk) is dict and set(disk) == {'path', 'warnPercent', 'critPercent'}, 'monitor_config_disk')
    _path(disk['path'], 'monitor_config_disk')
    require(_int(disk['warnPercent'], 50, 99, 'monitor_config_disk') < _int(disk['critPercent'], 51, 100,
                                                                             'monitor_config_disk'),
            'monitor_config_disk')
    v1 = document['v1Automation']
    featured = document.get('featured', FEATURED_UNIT)
    return Config(
        credential=telegram['credential'], chat_id=telegram['chatId'],
        interval=_int(document['intervalSeconds'], 15, 600, 'monitor_config_interval'),
        summary_hour=_int(document['summaryHourUtc'], 0, 23, 'monitor_config_summary'),
        status_file=_path(document['statusFile'], 'monitor_config_status_file'),
        state_file=_path(document['stateFile'], 'monitor_config_state_file'),
        services=tuple(_unit(u, 'monitor_config_services') for u in services),
        timers={_unit(t, 'monitor_config_timers'): _unit(s, 'monitor_config_timers') for t, s in timers.items()},
        automation={k: {'unit': _unit(v['unit'], 'monitor_config_automation'),
                        'passSeconds': _int(v['passSeconds'], 1, 3600, 'monitor_config_automation')}
                    for k, v in automation.items()},
        indexers={k: _unit(v, 'monitor_config_indexers') for k, v in indexers.items()},
        listeners=tuple(_unit(u, 'monitor_config_listeners') for u in listeners),
        v1_automation=None if v1 is None else _unit(v1, 'monitor_config_v1'),
        chains={k: {'rpc': dict(v['rpc']), 'registry': v['registry']} for k, v in chains.items()},
        balances=tuple(checked_balances), head_lag=dict(head), disk=dict(disk),
        featured=None if featured is None else _unit(featured, 'monitor_config_featured'))


def load_config(path):
    from execution_cli import private_file
    try:
        return checked_config(json.loads(private_file(path, MAX_CONFIG_BYTES)))
    except MonitorError:
        raise
    except Exception:
        raise MonitorError('monitor_config_unreadable') from None


# ---------------------------------------------------------------- systemd
def parse_show(text):
    """`systemctl show` of several units: blank-line separated blocks, keyed by Id."""
    units, block = {}, {}
    for line in text.splitlines() + ['']:
        if not line.strip():
            if 'Id' in block:
                units[block['Id']] = block
            block = {}
            continue
        key, _, value = line.partition('=')
        block[key] = value
    return units


def unit_states(units, run):
    if not units:
        return {}
    raw = run(['/usr/bin/systemctl', 'show', '--property=Id,LoadState,ActiveState,SubState,NRestarts,Result',
               '--', *units])
    return parse_show(raw)


def journal_lines(unit, cursor, run, *, since='-15min', grep=None):
    """New entries of one unit: (cursor, epoch seconds, message). Without a cursor, the last `since`. With `grep` (a
    PCRE2 pattern on the message), only the entries that match it, newest first (journalctl's order then)."""
    position = [f'--after-cursor={cursor}'] if cursor else [f'--since={since}']
    raw = run(['/usr/bin/journalctl', '--no-pager', '-o', 'json', '--output-fields=MESSAGE', '-n',
               str(MAX_JOURNAL_LINES), '-u', unit, *position, *([f'--grep={grep}'] if grep else [])])
    entries = []
    for line in raw.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        message = item.get('MESSAGE')
        if type(message) is not str or '__CURSOR' not in item:
            continue
        entries.append((item['__CURSOR'], int(item.get('__REALTIME_TIMESTAMP', '0')) / 1e6, message))
    return entries


def json_message(message):
    if not message.startswith('{'):
        return None
    try:
        value = json.loads(message)
    except ValueError:
        return None
    return value if type(value) is dict else None


# ---------------------------------------------------------------- state
def empty_state():
    return {'version': 1, 'cursors': {}, 'levels': {}, 'pending': {}, 'alerted': {}, 'restarts': {},
            'registry': {}, 'hours': {}, 'samples': {}, 'automation': {}, 'indexers': {}, 'v1': {},
            'telegramOffset': 0, 'summaryDate': None, 'lastCheck': None, 'recentEvents': []}


def load_state(path):
    try:
        state = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return empty_state()
    if type(state) is not dict or state.get('version') != 1:
        return empty_state()
    return {**empty_state(), **state}


def write_atomic(path, text, mode):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def count(state, now, key, amount=1):
    """Hourly buckets of event counts, kept 25 hours."""
    hour = str(int(now // HOUR))
    bucket = state['hours'].setdefault(hour, {})
    bucket[key] = bucket.get(key, 0) + amount
    for old in [h for h in state['hours'] if int(h) < int(now // HOUR) - 25]:
        del state['hours'][old]


def counted(state, now, key, window=DAY):
    first = int((now - window) // HOUR) + 1
    return sum(bucket.get(key, 0) for hour, bucket in state['hours'].items() if int(hour) >= first)


def counted_prefix(state, now, prefix, window=DAY):
    """{suffix: count} of every key starting with `prefix`, over `window`."""
    first = int((now - window) // HOUR) + 1
    totals = {}
    for hour, bucket in state['hours'].items():
        if int(hour) >= first:
            for key, value in bucket.items():
                if key.startswith(prefix):
                    totals[key[len(prefix):]] = totals.get(key[len(prefix):], 0) + value
    return totals


# ---------------------------------------------------------------- checks
@dataclass
class Check:
    key: str
    level: int
    text: str
    # The consecutive cycles this level must hold before it counts (transitions).
    confirm: int = CONFIRM_CYCLES


@dataclass
class Cycle:
    """One cycle's checks, its one-off events (each a level and a text) and the snapshot's sections."""
    now: float
    checks: list = field(default_factory=list)
    events: list = field(default_factory=list)
    sections: dict = field(default_factory=dict)
    quiet: set = field(default_factory=set)

    def check(self, key, level, text, *, confirm=CONFIRM_CYCLES):
        self.checks.append(Check(key, level, text, confirm))

    def event(self, level, text, unit=None):
        if unit not in self.quiet:
            self.events.append((level, text))


def ago(seconds):
    seconds = max(0, int(seconds))
    if seconds < 120:
        return f'{seconds} s'
    if seconds < 7200:
        return f'{seconds // 60} min'
    return f'{seconds // 3600} h'


def eth(wei):
    return f'{wei / WEI:.4f}'


def check_units(cycle, config, state, states):
    section = {}
    for unit in config.services:
        props = states.get(unit, {})
        active, sub = props.get('ActiveState', 'unknown'), props.get('SubState', '')
        confirm = CONFIRM_CYCLES
        if props.get('LoadState') != 'loaded':
            level, text = CRIT, f'{unit}: não carregada ({props.get("LoadState", "ausente")})'
        elif active in ('active', 'reloading'):
            level, text = OK, f'{unit}: ativa'
        elif active == 'activating':
            level, text = WARN, f'{unit}: iniciando'
        elif active == 'failed':
            # systemd gave up on it: its restarts or its start limit are spent (a restart it schedules is
            # `activating`). Alerted at the first cycle that sees it: on 2 Nov 2026 domino-execution-status stayed
            # failed for 80 s, was started again before a second cycle, and no one heard of it.
            level, text, confirm = CRIT, f'{unit}: falhou ({props.get("Result") or sub})', 1
        else:
            # Stopped (inactive), stopping or in maintenance: a service the configuration lists should run. A
            # deploy's own restart passes through here in about a second, so this one waits for its second cycle.
            level, text = CRIT, f'{unit}: {active} ({sub or props.get("Result", "")})'
        cycle.check(f'unit:{unit}', level, text, confirm=confirm)
        restarts = int(props.get('NRestarts') or 0)
        before = state['restarts'].get(unit)
        if before is not None and restarts > before:
            count(state, cycle.now, f'restart:{unit}', restarts - before)
            cycle.event(WARN, f'{unit} reiniciou sozinha ({restarts - before}x)')
        state['restarts'][unit] = restarts
        section[unit] = {'active': active, 'sub': sub, 'restarts': restarts}
    for timer, service in config.timers.items():
        props, served = states.get(timer, {}), states.get(service, {})
        if props.get('ActiveState') != 'active':
            level, text = CRIT, f'{timer}: {props.get("ActiveState", "ausente")}'
        elif served.get('Result') not in (None, '', 'success'):
            level, text = WARN, f'{service}: última execução {served.get("Result")}'
        else:
            level, text = OK, f'{timer}: ativo'
        cycle.check(f'unit:{timer}', level, text)
        section[timer] = {'active': props.get('ActiveState'), 'lastResult': served.get('Result')}
    cycle.sections['units'] = section


def pass_journal(report):
    """What a pass reports of its journal (v2_automation's `attention` and `gas`): the intents in 'attention' with
    since when, and the rolling 24-hour gas spend with the daily cap, as strings of wei. None when the pass carries
    none (a release before them) or carries them malformed."""
    attention, gas = report.get('attention'), report.get('gas')
    if type(attention) is not list or type(gas) is not dict:
        return None
    if not all(type(item) is dict and type(item.get('intent')) is str and type(item.get('since')) is int
               for item in attention):
        return None
    spent, cap = gas.get('spentWei'), gas.get('dailyCapWei')
    if not all(type(value) is str and re.fullmatch(r'[0-9]{1,40}', value) for value in (spent, cap)) or not int(cap):
        return None
    return {'attention': [{'intent': item['intent'][:66], 'reason': str(item.get('reason') or '')[:80],
                           'since': item['since']} for item in attention],
            'gas': {'spentWei': spent, 'dailyCapWei': cap}}


def journal_reported(mine):
    """Whether the chain's latest pass reported its journal (pass_journal). A pass of a release before those fields,
    or one that carried them malformed, leaves the last report stale: never read as the current one."""
    return mine.get('journalAt') is not None and (mine.get('lastPassAt') or 0) <= mine['journalAt']


def check_attention(cycle, chain, mine):
    """The chain's signer held by an intent in 'attention' past ATTENTION_SECONDS: critical until acknowledged."""
    key, attention = f'automation:{chain}:attention', mine.get('attention')
    if mine.get('lastPassAt') is None:
        return  # no pass yet: the passes check is critical
    if not journal_reported(mine):
        cycle.check(key, WARN, f'automação {chain}: os passes não informam attention nem gás (release da automação '
                               f'anterior a esses campos)')
        return
    if not attention:
        cycle.check(key, OK, f'automação {chain}: nenhuma intent em attention')
        return
    oldest = min(attention, key=lambda item: item['since'])
    held = cycle.now - oldest['since']
    if held >= ATTENTION_SECONDS:
        cycle.check(key, CRIT, f'automação {chain}: intent {oldest["intent"][:12]}… em attention há {ago(held)} '
                               f'({oldest["reason"]}): nada é enviado até o acknowledge')
    else:
        # Announced as an event when the pass reconciled it; critical once it holds the signer this long.
        cycle.check(key, OK, f'automação {chain}: intent {oldest["intent"][:12]}… em attention há {ago(held)}')


def check_gas(cycle, chain, mine, capped):
    """The chain's rolling 24-hour gas spend against its daily cap: a warning from GAS_WARN_PERCENT, critical at the
    cap. A claim reserves its gas before it is sent and is refused when it would pass the cap, so the spend stops
    just short of it: a pass refused at the cap (`capped`, this cycle) is the cap reached too."""
    if not journal_reported(mine):
        return  # check_attention warns that the passes do not report it
    spent, cap = int(mine['gas']['spentWei']), int(mine['gas']['dailyCapWei'])
    text = f'automação {chain}: gás de 24 h {eth(spent)} de {eth(cap)} ETH ({spent * 100 // cap}% do teto diário)'
    if spent >= cap or capped:
        cycle.check(f'automation:{chain}:gas', CRIT, text + (': a automação não envia mais' if spent >= cap else
                                                             ': um envio foi recusado no teto'))
    elif spent * 100 >= cap * GAS_WARN_PERCENT:
        cycle.check(f'automation:{chain}:gas', WARN, text)
    else:
        cycle.check(f'automation:{chain}:gas', OK, text)


def check_automation(cycle, config, state, read):
    section = {}
    for chain, entry in config.automation.items():
        mine = state['automation'].setdefault(chain, {'lastPassAt': None, 'errors': 0, 'signer': None,
                                                      'signerPasses': 0, 'vaults': None, 'exits': None,
                                                      'block': None, 'lastError': None, 'attention': None,
                                                      'gas': None, 'journalAt': None})
        capped = False
        for _, at, message in read(entry['unit']):
            report = json_message(message)
            if report is None:
                continue
            if set(report) == {'error'}:
                mine['errors'] += 1
                mine['lastError'] = str(report['error'])[:80]
                count(state, cycle.now, f'automation-error:{chain}')
                continue
            if 'block' not in report or 'vaults' not in report:
                continue
            mine.update(lastPassAt=at, errors=0, block=report.get('block'), vaults=len(report.get('vaults') or []),
                        exits=len(report.get('exits') or []))
            journal = pass_journal(report)
            if journal is not None:
                mine.update(journal, journalAt=at)
            count(state, cycle.now, f'automation-pass:{chain}')
            signer = report.get('signer')
            mine['signerPasses'] = mine['signerPasses'] + 1 if signer and signer == mine['signer'] else (1 if signer else 0)
            mine['signer'] = signer
            submitted = report.get('submitted')
            if submitted:
                state_name = str(submitted.get('state'))
                count(state, cycle.now, f'automation-submitted:{chain}:{state_name}')
                if state_name == 'refused' and submitted.get('reason') == GAS_CAP_REFUSAL:
                    capped = True  # every pass with a candidate is refused until the window moves: one level
                elif state_name != 'refused' or submitted.get('reason') != 'v2_executor_disabled':
                    level = WARN if state_name == 'refused' else OK
                    cycle.event(level, f'automação {chain}: {submitted.get("kind")} {submitted.get("target")} '
                                       f'→ {state_name} {submitted.get("reason") or ""}'.rstrip(), entry['unit'])
            for outcome in report.get('reconciled') or []:
                outcome_state = str(outcome.get('state'))
                count(state, cycle.now, f'automation-reconciled:{chain}:{outcome_state}')
                if outcome_state in ('confirmed', 'reverted', 'attention'):
                    level = {'confirmed': OK, 'reverted': WARN, 'attention': CRIT}[outcome_state]
                    cycle.event(level, f'automação {chain}: intent {str(outcome.get("intent"))[:12]}… '
                                       f'{outcome_state} {outcome.get("reason") or ""}'.rstrip(), entry['unit'])
        stale_after = max(4 * entry['passSeconds'], 120)
        last = mine['lastPassAt']
        if last is None:
            cycle.check(f'automation:{chain}:passes', CRIT, f'automação {chain}: nenhum passe visto')
        elif cycle.now - last > stale_after:
            cycle.check(f'automation:{chain}:passes', CRIT, f'automação {chain}: sem passes há {ago(cycle.now - last)}')
        else:
            cycle.check(f'automation:{chain}:passes', OK, f'automação {chain}: passando')
        if mine['errors'] >= 10:
            cycle.check(f'automation:{chain}:errors', CRIT, f'automação {chain}: {mine["errors"]} passes seguidos com '
                                                            f'erro ({mine["lastError"]})')
        elif mine['errors'] >= 3:
            cycle.check(f'automation:{chain}:errors', WARN, f'automação {chain}: {mine["errors"]} passes seguidos com '
                                                            f'erro ({mine["lastError"]})')
        else:
            cycle.check(f'automation:{chain}:errors', OK, f'automação {chain}: sem erros')
        signer = mine['signer']
        if signer and mine['signerPasses'] >= 3:
            level = CRIT if signer in ('v2_operator_balance_low', 'v2_operator_not_admitted', 'v2_operator_has_code') \
                else WARN
            cycle.check(f'automation:{chain}:signer', level, f'automação {chain}: signer {signer}')
        else:
            cycle.check(f'automation:{chain}:signer', OK, f'automação {chain}: signer ok')
        check_attention(cycle, chain, mine)
        check_gas(cycle, chain, mine, capped)
        section[chain] = {key: mine.get(key) for key in ('lastPassAt', 'block', 'vaults', 'exits', 'signer', 'errors',
                                                         'lastError', 'attention', 'gas')}
        section[chain]['passes24h'] = counted(state, cycle.now, f'automation-pass:{chain}')
        section[chain]['errors24h'] = counted(state, cycle.now, f'automation-error:{chain}')
    cycle.sections['automation'] = section


def check_indexers(cycle, config, state, read):
    section = {}
    for chain, unit in config.indexers.items():
        mine = state['indexers'].setdefault(chain, {'lastRoundAt': None, 'through': None, 'lastError': None})
        for _, at, message in read(unit):
            line = json_message(message)
            if line is None:
                continue
            if line.get('status') in ('indexed', 'caught_up_to_target'):
                mine.update(lastRoundAt=at, through=line.get('through'))
                created = line.get('vaultsCreated') or 0
                if type(created) is int and created > 0:
                    count(state, cycle.now, f'vaults-created:{chain}', created)
                    cycle.event(OK, f'{created} vault(s) V2 novo(s) em {chain}', unit)
            elif 'error' in line or line.get('status') in ('error', 'failed'):
                mine['lastError'] = str(line.get('error') or line.get('status'))[:80]
                count(state, cycle.now, f'indexer-error:{chain}')
        last = mine['lastRoundAt']
        if last is None or cycle.now - last > 300:
            cycle.check(f'indexer:{chain}', CRIT, f'indexador {chain}: sem rodada há '
                                                  f'{ago(cycle.now - last) if last else "muito tempo"}'
                                                  + (f' ({mine["lastError"]})' if mine['lastError'] else ''))
        else:
            cycle.check(f'indexer:{chain}', OK, f'indexador {chain}: em dia')
        section[chain] = {**mine, 'vaultsCreated24h': counted(state, cycle.now, f'vaults-created:{chain}')}
    cycle.sections['indexers'] = section


def check_v1(cycle, config, state, read):
    if config.v1_automation is None:
        return
    mine = state['v1']
    for _, at, message in read(config.v1_automation):
        line = json_message(message)
        if line and line.get('event') == 'cycle':
            mine['lastCycleAt'] = at
            count(state, cycle.now, f'v1-cycle:{line.get("outcome")}')
    last = mine.get('lastCycleAt')
    if last is None or cycle.now - last > 900:
        cycle.check('v1:cycles', WARN, f'automação V1: sem ciclo há {ago(cycle.now - last) if last else "muito tempo"}')
    else:
        cycle.check('v1:cycles', OK, 'automação V1: ciclando')
    cycle.sections['v1'] = {'lastCycleAt': last}


def check_listeners(cycle, config, state, read):
    section = {}
    for unit in config.listeners:
        failures = []
        for _, at, message in read(unit):
            line = json_message(message)
            if not line or type(line.get('status')) is not int:
                continue
            route = str(line.get('route'))[:40]
            count(state, cycle.now, f'requests:{unit}:{route}:{line["status"] // 100}xx')
            if line['status'] >= 500:
                failures.append(at)
                count(state, cycle.now, f'requests-5xx:{unit}')
        recent = counted(state, cycle.now, f'requests-5xx:{unit}', window=HOUR)
        if recent >= 20:
            cycle.check(f'listener:{unit}', CRIT, f'{unit}: {recent} respostas 5xx na última hora')
        elif recent >= 5:
            cycle.check(f'listener:{unit}', WARN, f'{unit}: {recent} respostas 5xx na última hora')
        else:
            cycle.check(f'listener:{unit}', OK, f'{unit}: sem 5xx')
        section[unit] = {'requests24h': counted_prefix(state, cycle.now, f'requests:{unit}:'),
                         'errors5xxHour': recent}
    cycle.sections['listeners'] = section


@functools.lru_cache(maxsize=1)
def featured_policy(path=Path(__file__).resolve().parent / 'featured_policy.json'):
    """(the list's size, its selection hour UTC) from the featured policy this release carries, read as data: its
    own modules (featured_pools) would load the database driver for two numbers."""
    policy = json.loads(Path(path).read_text())
    return policy['size'], policy['selectionHourUtc']


def utc_day(at):
    return datetime.datetime.fromtimestamp(at, datetime.timezone.utc).strftime('%Y-%m-%d')


def featured_reason(day):
    """Why a day's list was not published, from what the day's lines said."""
    if day is None:
        return 'o monitor não leu a janela desse dia'
    parts = [f'publicação {day.get("publication") or "não vista"}']
    selection = day.get('selection')
    parts.append(f'seleção {selection["outcome"]}, {selection["eligible"]} elegível(is) de {selection["evaluated"]} '
                 f'avaliado(s)' if selection else 'seleção não vista')
    if day.get('unready'):
        parts.append('novatos não prontos: ' + ', '.join(f'{pool[:12]}… {reason}'
                                                         for pool, reason in sorted(day['unready'].items())))
    return '; '.join(parts)


def featured_backfill(mine, unit, run):
    """A monitor without the list's history (its first read is the last 15 minutes) finds the last publication in
    the unit's journal of the last 7 days, once. A search that fails is tried again the next cycle."""
    try:
        found = journal_lines(unit, None, run, since=FEATURED_BACKFILL_SINCE, grep=FEATURED_SERVED)
    except subprocess.CalledProcessError as error:
        # journalctl --grep exits 1 without a word when nothing matches (systemd 255, checked on the VM); a bad
        # pattern or any other failure says why on stderr.
        if error.returncode != 1 or (error.stdout or '').strip() or (error.stderr or '').strip():
            return
        found = []
    except Exception:
        return
    for _, at, message in found:
        line = json_message(message) or {}
        publication = (line.get('live') or {}).get('publication') or {}
        if publication.get('status') == 'served' and (mine['publishedAt'] is None or at > mine['publishedAt']):
            mine.update(publishedAt=at, revision=publication.get('revision'))
    mine['backfilled'] = True


def featured_lines(cycle, state, mine, entries, unit, size):
    """What the service's ticks say: its phase and mode, the day's selection and publication, the list's size (its
    vacancies), and each withdrawal, an event."""
    for _, at, message in entries:
        line = json_message(message)
        if line is None or line.get('service') != 'featured':
            continue
        mine['lastLineAt'] = at
        if line.get('status') == 'retry':
            mine['lastError'] = str(line.get('reason'))[:80]
            continue
        mine['phase'] = line.get('phase')
        day = mine['days'].setdefault(utc_day(at), {'selection': None, 'publication': None, 'unready': None})
        for old in sorted(mine['days'])[:-3]:
            del mine['days'][old]
        selection = line.get('selection')
        if type(selection) is dict and selection.get('outcome') not in (None, 'already_done'):
            day['selection'] = {key: selection.get(key) for key in ('outcome', 'eligible', 'evaluated')}
        live = line.get('live')
        if type(live) is not dict:
            continue
        mine['mode'] = live.get('mode')
        publication = live.get('publication')
        if type(publication) is dict and publication.get('status') != 'published':
            # 'published' says only that the served list is the day's, which a carried list becomes at 12:30.
            day['publication'] = str(publication.get('status'))[:40]
            if publication.get('status') == 'served':
                mine.update(publishedAt=at, revision=publication.get('revision'))
            elif publication.get('status') == 'warming' and type(publication.get('unready')) is dict:
                day['unready'] = {str(pool)[:66]: str(reason)[:40] for pool, reason in publication['unready'].items()}
        health = live.get('health')
        if type(health) is not dict:
            continue
        vacant = health.get('vacant', 0 if health.get('status') == 'healthy' else size)
        if health.get('status') in ('healthy', 'idle') and type(vacant) is int:
            mine['pools'] = max(0, size - vacant)
        if type(health.get('removed')) is dict:
            for pool, reason in sorted(health['removed'].items()):
                count(state, cycle.now, 'featured-withdrawn')
                cycle.event(WARN, f'Top pools: pool {str(pool)[:12]}… retirado ({str(reason)[:60]})', unit)


def check_featured(cycle, config, state, read, run):
    """The Top pools list: the service's lines, the day's publication, the served list's age and size."""
    unit = config.featured
    if unit is None:
        return
    mine = state.setdefault('featured', {})
    for key, value in (('lastLineAt', None), ('phase', None), ('mode', None), ('lastError', None),
                       ('publishedAt', None), ('revision', None), ('backfilled', False), ('pools', None), ('days', {})):
        mine.setdefault(key, value)
    size, hour = featured_policy()
    if not mine['backfilled']:
        featured_backfill(mine, unit, run)
    featured_lines(cycle, state, mine, read(unit), unit, size)
    now, last = cycle.now, mine['lastLineAt']
    if last is None:
        cycle.check('featured:lines', CRIT, 'Top pools: nenhuma linha do serviço vista')
    elif mine['phase'] == 'shadow':
        cycle.check('featured:lines', OK, 'Top pools: fase shadow, nada servido')  # its idle ticks print nothing
    elif now - last >= FEATURED_SILENT_SECONDS:
        cycle.check('featured:lines', CRIT, f'Top pools: o serviço não registra nada há {ago(now - last)}')
    else:
        cycle.check('featured:lines', OK, 'Top pools: serviço registrando')
    cycle.sections['featured'] = {key: mine[key] for key in ('lastLineAt', 'phase', 'mode', 'publishedAt', 'revision',
                                                             'pools', 'lastError')}
    cycle.sections['featured']['withdrawn24h'] = counted(state, now, 'featured-withdrawn')
    if mine['phase'] != 'live' or mine['mode'] != 'auto':
        return  # nothing served, or the owner's own list (manual, off): no selection to publish or to age
    # The latest publication due: today's once its window closed, else yesterday's. A list published since that
    # day's midnight is the day's, or a newer one.
    midnight = (now // DAY) * DAY
    due = midnight + hour * HOUR + FEATURED_PUBLISH_MINUTES * 60
    if now < due:
        due -= DAY
    published = mine['publishedAt']
    if published is not None and published >= (due // DAY) * DAY:
        cycle.check('featured:publication', OK, f'Top pools: lista de {stamp(published)} publicada')
    else:
        day = utc_day(due)
        cycle.check('featured:publication', WARN, f'Top pools: a lista de {day[8:10]}/{day[5:7]} não foi publicada '
                                                  f'({featured_reason(mine["days"].get(day))})')
    if published is None:
        if mine['backfilled']:
            cycle.check('featured:age', CRIT, 'Top pools: nenhuma publicação no journal dos últimos 7 dias')
        else:
            cycle.check('featured:age', WARN, 'Top pools: idade da lista desconhecida (a busca no journal falhou)')
    elif now - published >= FEATURED_STALE_SECONDS:
        cycle.check('featured:age', CRIT, f'Top pools: a lista no ar é de {stamp(published)}, há '
                                          f'{ago(now - published)}')
    else:
        cycle.check('featured:age', OK, f'Top pools: lista de {stamp(published)}')
    if mine['pools'] is not None:
        level = CRIT if mine['pools'] < FEATURED_MIN_POOLS else OK
        cycle.check('featured:pools', level, f'Top pools: {mine["pools"]} pool(s) no ar'
                                             + (f' (mínimo {FEATURED_MIN_POOLS})' if level else ''))


def check_disk(cycle, config, usage=shutil.disk_usage):
    total, used, _ = usage(config.disk['path'])
    percent = round(100 * used / total, 1) if total else 100.0
    level = CRIT if percent >= config.disk['critPercent'] else WARN if percent >= config.disk['warnPercent'] else OK
    cycle.check(f'disk:{config.disk["path"]}', level, f'disco {config.disk["path"]}: {percent}% usado')
    cycle.sections['disk'] = {'path': config.disk['path'], 'usedPercent': percent}


# ---------------------------------------------------------------- chains
class Chains:
    """Each chain's read client, built from the services' own endpoint files on first use."""

    def __init__(self, config, *, factory=None):
        self.config, self._clients = config, {}
        self._factory = factory or self._build

    def _build(self, chain_key):
        from local_config import load_config as load_provider_file
        from v2_chains import default_registry
        from v2_rpc import ChainIndexRpc, configured_endpoints, load_chain_rpc_config
        chain = default_registry().chain(chain_key)
        rpc = self.config.chains[chain_key]['rpc']
        if 'providerFile' in rpc:
            endpoints = configured_endpoints(chain, provider_config=load_provider_file(rpc['providerFile']))
        else:
            endpoints = configured_endpoints(chain, chain_rpc_config=load_chain_rpc_config(rpc['chainRpcFile']))
        return ChainIndexRpc(endpoints)

    def client(self, chain_key):
        # A fresh client per cycle: no anchor carried across heads.
        return self._factory(chain_key)


def head_of(rpc):
    block = rpc.request('eth_getBlockByNumber', ['latest', False])
    require(type(block) is dict and type(block.get('number')) is str and type(block.get('timestamp')) is str,
            'monitor_head_unavailable')
    return int(block['number'], 16), int(block['timestamp'], 16)


def node_head(url, *, post=None, timeout=10):
    """The own node's head, straight from its loopback proxy: lag is the node's, never a fallback's."""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockByNumber', 'params': ['latest', False]})
    post = post or (lambda: urllib.request.urlopen(urllib.request.Request(
        url, body.encode(), {'content-type': 'application/json'}), timeout=timeout).read())
    try:
        result = json.loads(post())['result']
        return int(result['number'], 16), int(result['timestamp'], 16)
    except Exception:
        raise MonitorError('monitor_node_unreachable') from None


def check_chains(cycle, config, state, chains, *, node=node_head, catalog=None):
    balances, registry, heads = [], {}, {}
    for chain_key, entry in config.chains.items():
        try:
            rpc = chains.client(chain_key)
            number, stamp = head_of(rpc)
            heads[chain_key] = {'block': number, 'timestamp': stamp}
            for item in (b for b in config.balances if b['chain'] == chain_key):
                wei = int(rpc.request('eth_getBalance', [item['address'], hex(number)]), 16)
                key = f'balance:{item["label"]}:{chain_key}'
                level = CRIT if wei < item['critWei'] else WARN if wei < item['warnWei'] else OK
                cycle.check(key, level, f'saldo {item["label"]} em {chain_key}: {eth(wei)} ETH'
                                        + ('' if level == OK else f' (mínimo {eth(item["critWei"])})'))
                samples = state['samples'].setdefault(key, [])
                hour = int(cycle.now // HOUR)
                if not samples or samples[-1][0] != hour:
                    samples.append([hour, wei])
                del samples[:-26]
                balances.append({'label': item['label'], 'chain': chain_key, 'address': item['address'],
                                 'wei': str(wei), 'level': level, 'spent24h': str(spent(samples, wei))})
            registry[chain_key] = registry_events(cycle, state, rpc, chain_key, entry['registry'], number,
                                                  catalog=catalog)
            cycle.check(f'chain:{chain_key}', OK, f'leituras de {chain_key}: ok')
        except Exception as error:
            code = str(error) if isinstance(error, (MonitorError, DataError)) else type(error).__name__
            cycle.check(f'chain:{chain_key}', WARN, f'leituras de {chain_key} falharam ({code[:60]})')
    lag = config.head_lag
    try:
        number, stamp = node(config.chains[lag['chain']]['rpc']['nodeUrl'])
        seconds = max(0, int(cycle.now - stamp))
        level = CRIT if seconds >= lag['critSeconds'] else WARN if seconds >= lag['warnSeconds'] else OK
        cycle.check(f'node:{lag["chain"]}', level, f'nó {lag["chain"]}: {ago(seconds)} atrás da hora')
        lags = state.setdefault('lags', [])
        lags.append([int(cycle.now), seconds])
        del lags[:-1500]
        heads['node'] = {'chain': lag['chain'], 'block': number, 'lagSeconds': seconds,
                         'maxLag24h': max((s for t, s in lags if t > cycle.now - DAY), default=seconds)}
    except MonitorError as error:
        cycle.check(f'node:{lag["chain"]}', CRIT, f'nó {lag["chain"]}: sem resposta ({error})')
    cycle.sections.update(balances=balances, registry=registry, heads=heads)


def spent(samples, now_wei):
    """What left an address over the samples (24 hours of hourly values and now): decreases only, so a top-up
    does not hide what was spent."""
    values = [wei for _, wei in samples[-25:]] + [now_wei]
    return sum(max(0, a - b) for a, b in zip(values, values[1:]))


def registry_events(cycle, state, rpc, chain_key, registry, head, *, catalog=None, confirmations=2, window=5000):
    """The registry's logs since the last cycle, at most `window` blocks a cycle so a long gap is caught up, never
    skipped. The first cycle starts at the head: no backfill. Each log is an event."""
    cursor = state['registry'].get(chain_key)
    end = head - confirmations
    if cursor is None:
        state['registry'][chain_key] = end
    if cursor is None or cursor >= end:
        return {'cursor': state['registry'][chain_key], 'events24h': counted(state, cycle.now, f'registry:{chain_key}')}
    start, end = cursor + 1, min(end, cursor + window)
    logs = rpc.request('eth_getLogs', [{'address': registry, 'fromBlock': hex(start), 'toBlock': hex(end)}])
    require(type(logs) is list, 'monitor_logs_invalid')
    for log in logs:
        name, args = decode_registry(log, catalog)
        count(state, cycle.now, f'registry:{chain_key}')
        level = CRIT if name in CRITICAL_EVENTS else WARN
        if name == 'AutomationHaltSet' and args.get('halted') is False:
            level = WARN
        cycle.event(level, f'registry {chain_key}: {name} {json.dumps(args, sort_keys=True)[:300]} '
                           f'(bloco {int(log.get("blockNumber", "0x0"), 16)})')
    state['registry'][chain_key] = end
    return {'cursor': end, 'events24h': counted(state, cycle.now, f'registry:{chain_key}')}


def decode_registry(log, catalog=None):
    """The event's name and arguments from the exported IDominoRegistry ABI, or the raw topic."""
    try:
        from v2_events import catalog as load_catalog, decode_args, json_args
        catalog = catalog or load_catalog()
        topics = log.get('topics') or []
        event = catalog.event('registry', topics[0])
        return event.name, json_args(decode_args(event, topics, log.get('data', '0x')))
    except Exception:
        topic = (log.get('topics') or ['?'])[0]
        return f'evento desconhecido {str(topic)[:18]}…', {}


# ---------------------------------------------------------------- alert policy
def transitions(cycle, state):
    """Confirmed level changes as messages. A level holds for its check's `confirm` cycles (CONFIRM_CYCLES, a failed
    unit's 1) before it counts; a critical one is repeated every REALERT_CRIT_SECONDS while it lasts; a return to
    normal is announced once."""
    messages = []
    seen = set()
    for check in cycle.checks:
        seen.add(check.key)
        confirmed = state['levels'].get(check.key, OK)
        pending = state['pending'].get(check.key)
        if check.level == confirmed:
            state['pending'].pop(check.key, None)
            if check.level == CRIT and cycle.now - state['alerted'].get(check.key, 0) >= REALERT_CRIT_SECONDS:
                messages.append(f'{MARK[CRIT]} ainda: {check.text}')
                state['alerted'][check.key] = cycle.now
            continue
        if pending is None or pending[0] != check.level:
            pending = [check.level, 0]
        pending[1] += 1
        state['pending'][check.key] = pending
        if pending[1] < check.confirm:
            continue
        state['pending'].pop(check.key, None)
        state['levels'][check.key] = check.level
        if check.level > confirmed:
            messages.append(f'{MARK[check.level]} {check.text}')
            state['alerted'][check.key] = cycle.now
        elif confirmed >= WARN:
            messages.append(f'{MARK[OK]} normalizado: {check.text}')
            state['alerted'].pop(check.key, None)
    for key in [k for k in state['levels'] if k not in seen]:
        state['levels'].pop(key)
        state['pending'].pop(key, None)
        state['alerted'].pop(key, None)
    messages += [f'{MARK[level] if level else "ℹ️"} {text}' for level, text in cycle.events]
    # The dashboard's history: the last RECENT events and confirmed changes, with their time.
    recent = state.setdefault('recentEvents', [])
    recent.extend({'at': int(cycle.now), 'text': message} for message in messages)
    del recent[:-RECENT]
    return messages


# ---------------------------------------------------------------- reports
def stamp(now):
    return datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime('%d/%m %H:%M UTC')


def status_text(cycle, state):
    open_checks = sorted((c for c in cycle.checks if state['levels'].get(c.key, OK) > OK),
                         key=lambda c: -state['levels'][c.key])
    crit = sum(1 for c in open_checks if state['levels'][c.key] == CRIT)
    lines = [f'Domino: status {stamp(cycle.now)}',
             f'{crit} crítico(s), {len(open_checks) - crit} alerta(s)' if open_checks else 'Tudo normal.']
    lines += [f'{MARK[state["levels"][c.key]]} {c.text}' for c in open_checks[:15]]
    automation = cycle.sections.get('automation', {})
    if automation:
        parts = []
        for chain, entry in automation.items():
            last = entry.get('lastPassAt')
            parts.append(f'{chain}: passe há {ago(cycle.now - last) if last else "?"}, '
                         f'{entry.get("vaults") if entry.get("vaults") is not None else "?"} vaults')
        lines.append('Automação V2: ' + '; '.join(parts))
    balances = cycle.sections.get('balances', [])
    if balances:
        lines.append('Saldos: ' + '; '.join(f'{b["label"]} {b["chain"]} {eth(int(b["wei"]))}' for b in balances))
    node = cycle.sections.get('heads', {}).get('node')
    if node:
        lines.append(f'Nó {node["chain"]}: {ago(node["lagSeconds"])} atrás')
    units = cycle.sections.get('units', {})
    if units:
        active = sum(1 for u in units.values() if u.get('active') == 'active')
        lines.append(f'Units: {active}/{len(units)} ativas')
    disk = cycle.sections.get('disk')
    if disk:
        lines.append(f'Disco: {disk["usedPercent"]}%')
    return '\n'.join(lines)


def summary_text(cycle, state):
    lines = [f'Domino: resumo das últimas 24 h ({stamp(cycle.now)})']
    for chain, entry in cycle.sections.get('automation', {}).items():
        submitted = sum(counted_prefix(state, cycle.now, f'automation-submitted:{chain}:').values())
        confirmed = counted(state, cycle.now, f'automation-reconciled:{chain}:confirmed')
        lines.append(f'Automação {chain}: {entry["passes24h"]} passes, {entry["errors24h"]} erros, '
                     f'{submitted} envios, {confirmed} confirmados, {entry.get("vaults") or 0} vaults')
    for balance in cycle.sections.get('balances', []):
        lines.append(f'Saldo {balance["label"]} {balance["chain"]}: {eth(int(balance["wei"]))} ETH '
                     f'(saiu {eth(int(balance["spent24h"]))} em 24 h)')
    for unit, entry in cycle.sections.get('listeners', {}).items():
        day = entry['requests24h']
        if day:
            lines.append(f'{unit}: ' + ', '.join(f'{k} {v}' for k, v in sorted(day.items())))
    registry = sum(entry.get('events24h', 0) for entry in cycle.sections.get('registry', {}).values())
    lines.append(f'Registry: {registry} evento(s)')
    created = sum(entry.get('vaultsCreated24h', 0) for entry in cycle.sections.get('indexers', {}).values())
    lines.append(f'Vaults V2 novos: {created}')
    node = cycle.sections.get('heads', {}).get('node')
    if node:
        lines.append(f'Nó {node["chain"]}: atraso máximo {ago(node["maxLag24h"])}')
    featured = cycle.sections.get('featured')
    if featured:
        published = featured['publishedAt']
        pools = '?' if featured['pools'] is None else featured['pools']
        lines.append((f'Top pools: lista publicada em {stamp(published)}' if published else
                      'Top pools: nenhuma publicação conhecida')
                     + f', {pools} pool(s) no ar, {featured["withdrawn24h"]} retirada(s) em 24 h')
    restarts = sum(counted_prefix(state, cycle.now, 'restart:').values())
    lines.append(f'Reinícios automáticos: {restarts}')
    open_checks = [c for c in cycle.checks if state['levels'].get(c.key, OK) > OK]
    lines.append('Alertas abertos: ' + ('; '.join(c.text for c in open_checks) if open_checks else 'nenhum'))
    return '\n'.join(lines)


def snapshot(cycle, state, *, telegram_status):
    """The public status file: levels, numbers, addresses. Nothing secret."""
    return {'schemaVersion': 1, 'kind': 'domino-monitor-status', 'generatedAt': int(cycle.now),
            'checks': [{'key': c.key, 'level': state['levels'].get(c.key, OK), 'observed': c.level, 'text': c.text}
                       for c in cycle.checks],
            'events': [{'level': level, 'text': text} for level, text in cycle.events],
            'recentEvents': list(state.get('recentEvents', [])),
            'telegram': telegram_status, **cycle.sections}


# ---------------------------------------------------------------- telegram
class TelegramError(MonitorError):
    pass


class Telegram:
    API = 'https://api.telegram.org'

    def __init__(self, token, chat_id, *, opener=None):
        require(TOKEN.fullmatch(token or '') is not None, 'telegram_token_invalid')
        self._token, self.chat_id = token, chat_id
        self._open = opener or urllib.request.urlopen

    def __repr__(self):
        return f'Telegram(chat_id={self.chat_id!r})'

    def call(self, method, payload, *, timeout=40):
        request = urllib.request.Request(f'{self.API}/bot{self._token}/{method}', json.dumps(payload).encode(),
                                         {'content-type': 'application/json'})
        try:
            with self._open(request, timeout=timeout) as response:
                reply = json.loads(response.read(1_000_001))
        except urllib.error.HTTPError as error:
            code = int(error.code)
            error.close()
            raise TelegramError(f'telegram_http_{code}') from None
        except Exception:
            raise TelegramError('telegram_unreachable') from None
        if type(reply) is not dict or reply.get('ok') is not True:
            raise TelegramError('telegram_refused')
        return reply.get('result')

    def send(self, text):
        for start in range(0, len(text), MAX_MESSAGE):
            self.call('sendMessage', {'chat_id': self.chat_id, 'text': text[start:start + MAX_MESSAGE],
                                      'disable_web_page_preview': True})

    def updates(self, offset, timeout):
        return self.call('getUpdates', {'offset': offset, 'timeout': timeout, 'allowed_updates': ['message']},
                         timeout=timeout + 10)


def read_token(credential, environ=os.environ):
    directory = environ.get('CREDENTIALS_DIRECTORY')
    if not directory:
        return None
    try:
        return (Path(directory) / credential).read_text().strip()
    except OSError:
        return None


def commands(updates, chat_id):
    """The commands sent in the configured chat, with the next offset. Other chats are ignored, never answered."""
    found, offset = [], None
    for update in updates or []:
        if type(update) is not dict or type(update.get('update_id')) is not int:
            continue
        offset = update['update_id'] + 1
        message = update.get('message') or {}
        chat = message.get('chat') or {}
        text = message.get('text')
        if str(chat.get('id')) != str(chat_id) or type(text) is not str or not text.startswith('/'):
            continue
        found.append(text.split()[0].split('@')[0].lower())
    return found, offset


HELP = 'Comandos: /status (estado agora), /resumo (as últimas 24 h), /help.'


# ---------------------------------------------------------------- service
def run_command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=60).stdout


def cycle_once(config, state, *, run=run_command, chains=None, now=None, node=node_head, catalog=None,
               usage=shutil.disk_usage):
    cycle = Cycle(now if now is not None else time.time())
    cursors = state['cursors']

    def read(unit):
        if unit not in cursors:
            cycle.quiet.add(unit)
        try:
            entries = journal_lines(unit, cursors.get(unit), run)
        except Exception:
            cycle.check(f'journal:{unit}', WARN, f'journal de {unit} ilegível')
            return []
        cycle.check(f'journal:{unit}', OK, f'journal de {unit}: legível')
        if entries:
            cursors[unit] = entries[-1][0]
        return entries

    try:
        states = unit_states(list(config.services) + [u for pair in config.timers.items() for u in pair], run)
        cycle.check('systemd', OK, 'systemctl show: ok')
    except Exception:
        states = {}
        cycle.check('systemd', CRIT, 'systemctl show falhou')
    check_units(cycle, config, state, states)
    check_automation(cycle, config, state, read)
    check_indexers(cycle, config, state, read)
    check_v1(cycle, config, state, read)
    check_listeners(cycle, config, state, read)
    check_featured(cycle, config, state, read, run)
    check_chains(cycle, config, state, chains or Chains(config), node=node, catalog=catalog)
    check_disk(cycle, config, usage)
    state['lastCheck'] = int(cycle.now)
    return cycle


def summary_due(config, state, now):
    moment = datetime.datetime.fromtimestamp(now, datetime.timezone.utc)
    today = moment.strftime('%Y-%m-%d')
    return moment.hour >= config.summary_hour and state.get('summaryDate') != today, today


def serve(config, *, telegram=None, run=run_command, clock=time.time, sleep=time.sleep):
    state = load_state(config.state_file)
    if state['summaryDate'] is None:
        state['summaryDate'] = summary_due(config, state, clock())[1]
    chains = Chains(config)
    next_check = 0
    cycle = None
    telegram_status = 'off' if telegram is None else 'on'
    while True:
        now = clock()
        if now >= next_check:
            cycle = cycle_once(config, state, run=run, chains=chains, now=now)
            messages = transitions(cycle, state)
            due, today = summary_due(config, state, now)
            if telegram is not None:
                try:
                    if messages:
                        telegram.send('\n'.join(messages))
                    if due:
                        telegram.send(summary_text(cycle, state))
                    telegram_status = 'ok'
                except TelegramError as error:
                    telegram_status = str(error)
                    print(json.dumps({'telegram': telegram_status}), flush=True)
            if due:
                state['summaryDate'] = today
            write_atomic(config.state_file, json.dumps(state, sort_keys=True), 0o600)
            write_atomic(config.status_file, json.dumps(snapshot(cycle, state, telegram_status=telegram_status),
                                                         sort_keys=True), 0o644)
            print(json.dumps({'cycle': int(now), 'open': sum(1 for v in state['levels'].values() if v > OK),
                              'messages': len(messages)}), flush=True)
            next_check = now + config.interval
        wait = max(1, int(next_check - clock()))
        if telegram is None:
            sleep(wait)
            continue
        try:
            found, offset = commands(telegram.updates(state['telegramOffset'], min(wait, 30)), config.chat_id)
            if offset is not None:
                # Kept at once: a restart must not answer the same command twice.
                state['telegramOffset'] = offset
                write_atomic(config.state_file, json.dumps(state, sort_keys=True), 0o600)
            for command in found:
                if command == '/status' and cycle is not None:
                    telegram.send(status_text(cycle, state))
                elif command in ('/resumo', '/summary') and cycle is not None:
                    telegram.send(summary_text(cycle, state))
                elif command in ('/help', '/start', '/ajuda'):
                    telegram.send(HELP)
        except TelegramError as error:
            telegram_status = str(error)
            sleep(min(wait, 30))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Domino production monitor')
    parser.add_argument('--config', required=True)
    parser.add_argument('operation', choices=('serve', 'once', 'discover'))
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        token = read_token(config.credential)
        if args.operation == 'discover':
            # The chats that wrote to the bot: ids and titles only, never the token.
            require(token, 'telegram_credential_missing')
            updates = Telegram(token, None).updates(0, 0)
            chats = {}
            for update in updates or []:
                chat = (update.get('message') or {}).get('chat') or {}
                if 'id' in chat:
                    chats[str(chat['id'])] = chat.get('title') or chat.get('username') or chat.get('first_name')
            print(json.dumps({'chats': chats}, ensure_ascii=False))
            return 0
        if args.operation == 'once':
            state = load_state(config.state_file)
            cycle = cycle_once(config, state)
            print(status_text(cycle, {**state, 'levels': {c.key: c.level for c in cycle.checks}}))
            return 0
        telegram = Telegram(token, config.chat_id) if token and config.chat_id else None
        serve(config, telegram=telegram)
    except MonitorError as error:
        print(json.dumps({'error': str(error)}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
