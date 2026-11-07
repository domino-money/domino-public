"""The production monitor: its configuration, what each check reads and decides, the alert policy, Telegram (the
token never leaves the request), commands only from the configured chat, the registry's events through the exported
ABI, and a snapshot with nothing secret. No systemd, no journal, no chain: every reader is a fake."""
import datetime
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ops_monitor as monitor  # noqa: E402
from v2_index_fixtures import block_hash, encode_log, tx_hash  # noqa: E402

REGISTRY = '0x25d4f013ecff3790e384e16ca9951bba6cd715fa'
OPERATOR = '0x64b72517d8b0d72be25f814b4e03985cf15e098a'
# Synthetic, format-valid fixture; every Telegram request below uses a fake opener.
TOKEN = '12345678:' + 'x' * 35
NOW = 1_791_200_000.0
ETH = 10**18
CAP = 25 * 10**14  # gas.dailyCapWei, 0.0025 ETH (the owner's, 5 Oct 2026)


def document(**changes):
    config = {
        'schemaVersion': 1, 'kind': 'domino-monitor',
        'telegram': {'credential': 'telegram-bot-token', 'chatId': '4242'},
        'intervalSeconds': 60, 'summaryHourUtc': 12,
        'statusFile': '/var/lib/domino-monitor-public/status.json', 'stateFile': '/var/lib/domino-monitor/state.json',
        'services': ['domino-read.service', 'domino-crosschain.service'],
        'timers': {'domino-gas-settlement.timer': 'domino-gas-settlement.service'},
        'automation': {'base-8453': {'unit': 'domino-v2-automation@base-8453.service', 'passSeconds': 30}},
        'indexers': {'base-8453': 'domino-v2-indexer@base-8453.service'},
        'listeners': ['domino-crosschain.service'],
        'v1Automation': 'domino-automation.service',
        'chains': {'robinhood-4663': {'rpc': {'providerFile': '/run/domino-monitor-config/providers.json',
                                              'nodeUrl': 'http://127.0.0.1:18547/'}, 'registry': REGISTRY},
                   'base-8453': {'rpc': {'chainRpcFile': '/run/domino-monitor-config/chain-rpc.json'},
                                 'registry': REGISTRY}},
        'balances': [{'label': 'V2 operator', 'chain': 'base-8453', 'address': OPERATOR,
                      'warnWei': str(3 * 10**15), 'critWei': str(10**15)}],
        'headLag': {'chain': 'robinhood-4663', 'warnSeconds': 180, 'critSeconds': 600},
        'disk': {'path': '/', 'warnPercent': 85, 'critPercent': 95},
    }
    config.update(changes)
    return config


def config(**changes):
    return monitor.checked_config(document(**changes))


def journal(*entries):
    """`journalctl -o json` output: each entry (seconds, message), cursors c1, c2..."""
    return '\n'.join(json.dumps({'__CURSOR': f'c{i}', '__REALTIME_TIMESTAMP': str(int(at * 1e6)), 'MESSAGE': message})
                     for i, (at, message) in enumerate(entries, 1)) + '\n'


def pass_line(*, journal=True, **fields):
    """A pass as v2_automation prints it; with `journal` false, as a release before `attention` and `gas` did."""
    report = {'chain': 'base-8453', 'block': 100, 'timestamp': 1, 'reconciled': [], 'exits': [], 'vaults': [],
              'submitted': None}
    if journal:
        report.update(attention=[], gas={'spentWei': '0', 'dailyCapWei': str(CAP)})
    return json.dumps({**report, **fields})


def spending(wei, **fields):
    return pass_line(gas={'spentWei': str(wei), 'dailyCapWei': str(CAP)}, **fields)


def featured_tick(*, publication=None, health=None, selection=None, mode='auto', phase='live'):
    """A tick of `manage_featured.py serve` as it prints it (featured_live.Live.tick's report)."""
    live = {'mode': mode, 'keptWarm': 0}
    if publication is not None:
        live['publication'] = publication
    live['health'] = {'status': 'healthy'} if health is None else health
    line = {'service': 'featured', 'phase': phase}
    if selection is not None:
        line['selection'] = selection
    return json.dumps({**line, 'live': live})


def served(revision=89):
    return featured_tick(publication={'status': 'served', 'revision': revision, 'withheld': []})


class Reader:
    """A fake journal: per unit, the entries the next read returns."""

    def __init__(self, entries=None):
        self.entries = entries or {}

    def __call__(self, unit):
        found = self.entries.pop(unit, [])
        return [(f'c{i}', at, message) for i, (at, message) in enumerate(found, 1)]


class ConfigTests(unittest.TestCase):
    def test_a_complete_configuration_loads(self):
        loaded = config()
        self.assertEqual(loaded.chat_id, '4242')
        self.assertEqual(loaded.balances[0]['critWei'], 10**15)
        self.assertEqual(loaded.timers, {'domino-gas-settlement.timer': 'domino-gas-settlement.service'})

    def test_each_rule_refuses_the_whole_configuration(self):
        cases = {
            'monitor_config_invalid': [{'kind': 'other'}, {'schemaVersion': 2}],
            'monitor_config_telegram': [{'telegram': {'credential': 'telegram-bot-token', 'chatId': 4242}},
                                        {'telegram': {'credential': 'Bad Name', 'chatId': None}}],
            'monitor_config_chains': [
                {'chains': {'robinhood-4663': {'rpc': {'providerFile': 'relative.json', 'nodeUrl': 'http://127.0.0.1:1/'},
                                               'registry': REGISTRY}}},
                # The own node only: a keyed or public URL is refused.
                {'chains': {'robinhood-4663': {'rpc': {'providerFile': '/p.json',
                                                       'nodeUrl': 'https://rpc.example/key/'}, 'registry': REGISTRY}}},
                {'chains': {'base-8453': {'rpc': {'chainRpcFile': '/c.json'}, 'registry': REGISTRY.upper()}}}],
            'monitor_config_balances': [
                {'balances': [{'label': 'x', 'chain': 'base-8453', 'address': OPERATOR, 'warnWei': '1', 'critWei': '2'}]},
                {'balances': [{'label': 'x', 'chain': 'elsewhere-1', 'address': OPERATOR, 'warnWei': '2',
                               'critWei': '1'}]}],
            'monitor_config_head_lag': [{'headLag': {'chain': 'base-8453', 'warnSeconds': 180, 'critSeconds': 600}},
                                        {'headLag': {'chain': 'robinhood-4663', 'warnSeconds': 600, 'critSeconds': 600}}],
            'monitor_config_disk': [{'disk': {'path': '/', 'warnPercent': 95, 'critPercent': 90}}],
            'monitor_config_services': [{'services': []}, {'services': ['domino-read.socket']}],
        }
        for code, changes in cases.items():
            for change in changes:
                with self.subTest(code=code, change=change), self.assertRaisesRegex(ValueError, f'^{code}$'):
                    config(**change)
        with self.assertRaisesRegex(ValueError, '^monitor_config_invalid$'):
            monitor.checked_config({**document(), 'extra': 1})


class SystemdTests(unittest.TestCase):
    def test_show_blocks_are_keyed_by_id(self):
        text = ('Id=a.service\nLoadState=loaded\nActiveState=active\nNRestarts=0\n\n'
                'Id=b.timer\nActiveState=inactive\n')
        self.assertEqual(monitor.parse_show(text)['b.timer'], {'Id': 'b.timer', 'ActiveState': 'inactive'})
        calls = []
        monitor.unit_states(['a.service'], lambda args: calls.append(args) or text)
        self.assertEqual(calls[0][-2:], ['--', 'a.service'])

    def test_journal_lines_follow_the_cursor_and_skip_what_is_not_a_message(self):
        calls = []
        raw = journal((NOW, 'hello')) + json.dumps({'__CURSOR': 'x', 'MESSAGE': [1, 2]}) + '\nnot json\n'
        entries = monitor.journal_lines('u.service', None, lambda args: calls.append(args) or raw)
        self.assertEqual(entries, [('c1', NOW, 'hello')])
        self.assertIn('--since=-15min', calls[0])
        monitor.journal_lines('u.service', 'c1', lambda args: calls.append(args) or '')
        self.assertIn('--after-cursor=c1', calls[1])

    def test_units_their_restarts_and_the_timers_services(self):
        cfg, state = config(), monitor.empty_state()
        states = {'domino-read.service': {'LoadState': 'loaded', 'ActiveState': 'active', 'NRestarts': '0'},
                  'domino-crosschain.service': {'LoadState': 'loaded', 'ActiveState': 'failed', 'SubState': 'failed'},
                  'domino-gas-settlement.timer': {'ActiveState': 'active'},
                  'domino-gas-settlement.service': {'Result': 'exit-code'}}
        cycle = monitor.Cycle(NOW)
        monitor.check_units(cycle, cfg, state, states)
        levels = {c.key: c.level for c in cycle.checks}
        self.assertEqual(levels, {'unit:domino-read.service': monitor.OK, 'unit:domino-crosschain.service': monitor.CRIT,
                                  'unit:domino-gas-settlement.timer': monitor.WARN})
        states['domino-read.service']['NRestarts'] = '2'
        cycle = monitor.Cycle(NOW + 60)
        monitor.check_units(cycle, cfg, state, states)
        self.assertEqual(cycle.events, [(monitor.WARN, 'domino-read.service reiniciou sozinha (2x)')])
        self.assertEqual(monitor.counted(state, NOW + 60, 'restart:domino-read.service'), 2)
        missing = monitor.Cycle(NOW)
        monitor.check_units(missing, cfg, monitor.empty_state(), {})
        self.assertEqual(missing.checks[0].level, monitor.CRIT)
        states['domino-gas-settlement.timer']['ActiveState'] = 'inactive'
        cycle = monitor.Cycle(NOW)
        monitor.check_units(cycle, cfg, state, states)
        self.assertEqual({c.key: c.level for c in cycle.checks}['unit:domino-gas-settlement.timer'], monitor.CRIT)
        states['domino-read.service']['ActiveState'] = 'activating'
        cycle = monitor.Cycle(NOW)
        monitor.check_units(cycle, cfg, state, states)
        self.assertEqual({c.key: c.level for c in cycle.checks}['unit:domino-read.service'], monitor.WARN)

    UNIT = 'domino-execution-status.service'
    UP = {'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running', 'NRestarts': '0', 'Result': 'success'}

    def seen(self, state, now, **props):
        """One cycle's unit check through the alert policy: the messages it sends."""
        cycle = monitor.Cycle(now)
        monitor.check_units(cycle, config(services=[self.UNIT], timers={}), state, {self.UNIT: {**self.UP, **props}})
        return monitor.transitions(cycle, state)

    def test_a_failed_unit_alerts_at_the_first_cycle_that_sees_it(self):
        # 2 Nov 2026: domino-execution-status spent its start limit at 13:19:57 and was started again at 13:20:56;
        # the cycles at 13:19:06, 13:20:06 and 13:21:06 saw it active, failed, active, and no one heard of it.
        state = monitor.empty_state()
        self.assertEqual(self.seen(state, NOW), [])
        messages = self.seen(state, NOW + 60, ActiveState='failed', SubState='failed', NRestarts='2',
                             Result='exit-code')
        self.assertEqual(messages, [f'🔴 {self.UNIT}: falhou (exit-code)', f'🟡 {self.UNIT} reiniciou sozinha (2x)'])
        # systemd flushes its restart counter at the next start; one good cycle is not a recovery yet.
        self.assertEqual(self.seen(state, NOW + 120), [])
        self.assertEqual(self.seen(state, NOW + 180), [f'🟢 normalizado: {self.UNIT}: ativa'])
        # While it stays failed it is repeated like any critical level, every 3 hours, never each cycle.
        failed = dict(ActiveState='failed', SubState='failed', Result='start-limit-hit')
        self.assertEqual(self.seen(state, NOW + 240, **failed), [f'🔴 {self.UNIT}: falhou (start-limit-hit)'])
        self.assertEqual(self.seen(state, NOW + 300, **failed), [])
        self.assertEqual(self.seen(state, NOW + 240 + 3 * 3600, **failed),
                         [f'🔴 ainda: {self.UNIT}: falhou (start-limit-hit)'])

    def test_a_stopped_unit_is_critical_from_its_second_cycle(self):
        # A deploy's restart passes through inactive in about a second: one cycle that sees it alerts no one.
        state = monitor.empty_state()
        self.assertEqual(self.seen(state, NOW, ActiveState='inactive', SubState='dead'), [])
        self.assertEqual(self.seen(state, NOW + 60), [])
        self.assertEqual(self.seen(state, NOW + 120, ActiveState='inactive', SubState='dead'), [])
        self.assertEqual(self.seen(state, NOW + 180, ActiveState='inactive', SubState='dead'),
                         [f'🔴 {self.UNIT}: inactive (dead)'])


class AutomationTests(unittest.TestCase):
    UNIT = 'domino-v2-automation@base-8453.service'

    def run_cycle(self, state, entries, now, quiet=False):
        cycle = monitor.Cycle(now)
        if quiet:
            cycle.quiet.add(self.UNIT)
        monitor.check_automation(cycle, config(), state, Reader({self.UNIT: entries}))
        return cycle, {c.key: c.level for c in cycle.checks}

    def test_passes_keep_it_fresh_and_their_absence_is_critical(self):
        state = monitor.empty_state()
        _, levels = self.run_cycle(state, [], NOW)
        self.assertEqual(levels['automation:base-8453:passes'], monitor.CRIT)  # never seen
        _, levels = self.run_cycle(state, [(NOW, pass_line(vaults=[{}, {}]))], NOW + 10)
        self.assertEqual(levels['automation:base-8453:passes'], monitor.OK)
        self.assertEqual(state['automation']['base-8453']['vaults'], 2)
        _, levels = self.run_cycle(state, [], NOW + 119)
        self.assertEqual(levels['automation:base-8453:passes'], monitor.OK)  # 4 x 30 s, at least 120 s
        _, levels = self.run_cycle(state, [], NOW + 121)
        self.assertEqual(levels['automation:base-8453:passes'], monitor.CRIT)

    def test_consecutive_errors_warn_then_turn_critical_and_a_pass_clears_them(self):
        state = monitor.empty_state()
        error = json.dumps({'error': 'v2_rpc_unavailable'})
        _, levels = self.run_cycle(state, [(NOW, error)] * 2, NOW)
        self.assertEqual(levels['automation:base-8453:errors'], monitor.OK)
        _, levels = self.run_cycle(state, [(NOW, error)], NOW)
        self.assertEqual(levels['automation:base-8453:errors'], monitor.WARN)
        _, levels = self.run_cycle(state, [(NOW, error)] * 7, NOW)
        self.assertEqual(levels['automation:base-8453:errors'], monitor.CRIT)
        _, levels = self.run_cycle(state, [(NOW, pass_line())], NOW)
        self.assertEqual(levels['automation:base-8453:errors'], monitor.OK)

    def test_a_signer_problem_counts_only_once_it_holds_for_three_passes(self):
        state = monitor.empty_state()
        _, levels = self.run_cycle(state, [(NOW, pass_line(signer='read_deadline_exceeded'))] * 2, NOW)
        self.assertEqual(levels['automation:base-8453:signer'], monitor.OK)
        _, levels = self.run_cycle(state, [(NOW, pass_line(signer='read_deadline_exceeded'))], NOW)
        self.assertEqual(levels['automation:base-8453:signer'], monitor.WARN)
        _, levels = self.run_cycle(state, [(NOW, pass_line(signer='v2_operator_balance_low'))] * 3, NOW)
        self.assertEqual(levels['automation:base-8453:signer'], monitor.CRIT)
        _, levels = self.run_cycle(state, [(NOW, pass_line())], NOW)
        self.assertEqual(levels['automation:base-8453:signer'], monitor.OK)

    def test_sends_and_outcomes_are_events_but_a_disabled_executor_is_not(self):
        state = monitor.empty_state()
        disabled = {'kind': 'compound', 'target': '0xv', 'state': 'refused', 'reason': 'v2_executor_disabled'}
        cycle, _ = self.run_cycle(state, [(NOW, pass_line(submitted=disabled))], NOW)
        self.assertEqual(cycle.events, [])
        sent = {'kind': 'compound', 'target': '0xv', 'intent': '0x' + '1' * 64, 'state': 'submitted', 'reason': ''}
        outcomes = [{'intent': '0x' + 'a' * 64, 'state': 'confirmed', 'reason': ''},
                    {'intent': '0x' + 'b' * 64, 'state': 'attention', 'reason': 'nonce_consumed_without_receipt'},
                    {'intent': '0x' + 'c' * 64, 'state': 'submitted', 'reason': ''}]
        cycle, _ = self.run_cycle(state, [(NOW, pass_line(submitted=sent, reconciled=outcomes))], NOW)
        self.assertEqual([level for level, _ in cycle.events], [monitor.OK, monitor.OK, monitor.CRIT])
        self.assertIn('compound 0xv → submitted', cycle.events[0][1])
        self.assertIn('nonce_consumed_without_receipt', cycle.events[2][1])
        self.assertEqual(monitor.counted(state, NOW, 'automation-reconciled:base-8453:confirmed'), 1)
        # A unit's first read is its history: counted, never announced again.
        cycle, _ = self.run_cycle(state, [(NOW, pass_line(submitted=sent))], NOW, quiet=True)
        self.assertEqual(cycle.events, [])
        self.assertEqual(monitor.counted(state, NOW, 'automation-submitted:base-8453:submitted'), 2)

    INTENT = '0x' + 'b' * 64

    def test_an_intent_in_attention_is_critical_once_it_has_held_the_signer_15_minutes(self):
        state = monitor.empty_state()
        held = [{'intent': self.INTENT, 'reason': 'nonce_consumed_without_receipt', 'since': int(NOW)}]
        _, levels = self.run_cycle(state, [(NOW, pass_line(attention=held))], NOW)
        self.assertEqual(levels['automation:base-8453:attention'], monitor.OK)  # the reconciliation's event said it
        _, levels = self.run_cycle(state, [(NOW + 899, pass_line(attention=held))], NOW + 899)
        self.assertEqual(levels['automation:base-8453:attention'], monitor.OK)
        cycle, levels = self.run_cycle(state, [(NOW + 900, pass_line(attention=held))], NOW + 900)
        self.assertEqual(levels['automation:base-8453:attention'], monitor.CRIT)
        self.assertIn(f'intent {self.INTENT[:12]}… em attention há 15 min (nonce_consumed_without_receipt)',
                      {c.key: c.text for c in cycle.checks}['automation:base-8453:attention'])
        # Its time is the journal's: a monitor that starts later still counts it from there.
        _, levels = self.run_cycle(monitor.empty_state(), [(NOW + 900, pass_line(attention=held))], NOW + 900)
        self.assertEqual(levels['automation:base-8453:attention'], monitor.CRIT)
        # Acknowledged, the next pass reports none.
        _, levels = self.run_cycle(state, [(NOW + 930, pass_line())], NOW + 930)
        self.assertEqual(levels['automation:base-8453:attention'], monitor.OK)

    def test_the_days_gas_spend_warns_from_80_percent_and_is_critical_at_the_cap(self):
        for wei, expected in ((CAP * 80 // 100 - 1, monitor.OK), (CAP * 80 // 100, monitor.WARN),
                              (CAP - 1, monitor.WARN), (CAP, monitor.CRIT), (CAP + 10**12, monitor.CRIT)):
            with self.subTest(wei=wei):
                cycle, levels = self.run_cycle(monitor.empty_state(), [(NOW, spending(wei))], NOW)
                self.assertEqual(levels['automation:base-8453:gas'], expected)
        self.assertIn('gás de 24 h 0.0025 de 0.0025 ETH (100% do teto diário)',
                      {c.key: c.text for c in cycle.checks}['automation:base-8453:gas'])

    def test_a_send_refused_at_the_cap_is_critical_once_never_an_event_each_pass(self):
        state = monitor.empty_state()
        refused = {'kind': 'compound', 'target': '0xv', 'state': 'refused', 'reason': 'v2_daily_gas_cap'}
        # A claim reserves its gas first and is refused past the cap: the spend stops short of it.
        cycle, levels = self.run_cycle(state, [(NOW, spending(CAP * 85 // 100, submitted=refused))] * 4, NOW)
        self.assertEqual(levels['automation:base-8453:gas'], monitor.CRIT)
        self.assertEqual(cycle.events, [])
        self.assertEqual(monitor.counted(state, NOW, 'automation-submitted:base-8453:refused'), 4)
        # Passes with nothing to send: the spend alone.
        _, levels = self.run_cycle(state, [(NOW + 60, spending(CAP * 85 // 100))], NOW + 60)
        self.assertEqual(levels['automation:base-8453:gas'], monitor.WARN)
        # Any other refusal is still an event.
        other = {**refused, 'reason': 'v2_gas_price_above_cap'}
        cycle, levels = self.run_cycle(state, [(NOW + 120, spending(0, submitted=other))], NOW + 120)
        self.assertEqual((cycle.events[0][0], levels['automation:base-8453:gas']), (monitor.WARN, monitor.OK))

    def test_passes_that_do_not_report_the_journal_warn_and_an_old_report_is_never_current(self):
        state = monitor.empty_state()
        _, levels = self.run_cycle(state, [], NOW)
        self.assertNotIn('automation:base-8453:attention', levels)  # no pass yet: the passes check says it
        _, levels = self.run_cycle(state, [(NOW, pass_line(journal=False))], NOW)
        self.assertEqual(levels['automation:base-8453:attention'], monitor.WARN)
        self.assertNotIn('automation:base-8453:gas', levels)
        _, levels = self.run_cycle(state, [(NOW + 30, spending(CAP))], NOW + 30)
        self.assertEqual((levels['automation:base-8453:attention'], levels['automation:base-8453:gas']),
                         (monitor.OK, monitor.CRIT))
        # A pass after it without them (a release rolled back) or with them malformed: the last report is stale.
        malformed = [pass_line(journal=False),
                     pass_line(attention=[{'intent': self.INTENT, 'reason': 'x', 'since': '1791200000'}]),
                     pass_line(gas={'spentWei': CAP, 'dailyCapWei': str(CAP)}),
                     pass_line(gas={'spentWei': '1', 'dailyCapWei': '0'})]
        for at, line in enumerate(malformed, 1):
            with self.subTest(line=line):
                _, levels = self.run_cycle(state, [(NOW + 30 + at, line)], NOW + 30 + at)
                self.assertEqual(levels['automation:base-8453:attention'], monitor.WARN)
                self.assertNotIn('automation:base-8453:gas', levels)


class IndexerAndListenerTests(unittest.TestCase):
    def test_indexer_rounds_new_vaults_and_staleness(self):
        cfg, state = config(), monitor.empty_state()
        unit = 'domino-v2-indexer@base-8453.service'
        line = json.dumps({'status': 'indexed', 'through': 9, 'vaultsCreated': 2})
        cycle = monitor.Cycle(NOW)
        monitor.check_indexers(cycle, cfg, state, Reader({unit: [(NOW, line)]}))
        self.assertEqual(cycle.checks[0].level, monitor.OK)
        self.assertEqual(cycle.events, [(monitor.OK, '2 vault(s) V2 novo(s) em base-8453')])
        cycle = monitor.Cycle(NOW + 301)
        monitor.check_indexers(cycle, cfg, state, Reader({unit: [(NOW, json.dumps({'error': 'v2_rpc_unavailable'}))]}))
        self.assertEqual(cycle.checks[0].level, monitor.CRIT)
        self.assertIn('v2_rpc_unavailable', cycle.checks[0].text)

    def test_listener_5xx_over_the_last_hour(self):
        cfg, state = config(), monitor.empty_state()
        unit = 'domino-crosschain.service'
        line = lambda status: json.dumps({'service': 'x', 'route': 'quote', 'status': status})  # noqa: E731
        for amount, expected in ((4, monitor.OK), (1, monitor.WARN), (15, monitor.CRIT)):
            cycle = monitor.Cycle(NOW)
            monitor.check_listeners(cycle, cfg, state, Reader({unit: [(NOW, line(502))] * amount + [(NOW, line(200))]}))
            self.assertEqual(cycle.checks[0].level, expected)
        self.assertEqual(cycle.sections['listeners'][unit]['requests24h'], {'quote:5xx': 20, 'quote:2xx': 3})
        later = monitor.Cycle(NOW + 2 * 3600)
        monitor.check_listeners(later, cfg, state, Reader())
        self.assertEqual(later.checks[0].level, monitor.OK)

    def test_v1_cycles(self):
        cfg, state = config(), monitor.empty_state()
        cycle = monitor.Cycle(NOW)
        monitor.check_v1(cycle, cfg, state, Reader({'domino-automation.service': [
            (NOW, json.dumps({'event': 'cycle', 'outcome': 'wait'}))]}))
        self.assertEqual(cycle.checks[0].level, monitor.OK)
        cycle = monitor.Cycle(NOW + 901)
        monitor.check_v1(cycle, cfg, state, Reader())
        self.assertEqual(cycle.checks[0].level, monitor.WARN)


class FeaturedTests(unittest.TestCase):
    """The Top pools list (TOP_POOLS.md, item 1), from domino-featured's own lines."""

    UNIT = 'domino-featured.service'
    DAY = datetime.datetime(2026, 11, 2, tzinfo=datetime.timezone.utc).timestamp()  # 2 Nov 2026, 00:00 UTC
    HOUR = 3600
    NO_MATCH = subprocess.CalledProcessError(1, ['journalctl'], output='', stderr='')

    def at(self, hours, minutes=0, seconds=0, *, day=0):
        return self.DAY + day * 86400 + hours * 3600 + minutes * 60 + seconds

    def run_cycle(self, state, entries, now, *, backfill=(), quiet=False, cfg=None):
        """One cycle: `entries` the unit's new (at, line); `backfill` what the one-time search finds, or raises."""
        cycle, searches = monitor.Cycle(now), []
        if quiet:
            cycle.quiet.add(self.UNIT)

        def run(args):
            searches.append(args)
            if isinstance(backfill, Exception):
                raise backfill
            return journal(*backfill)
        monitor.check_featured(cycle, cfg or config(), state, Reader({self.UNIT: list(entries)}), run)
        return cycle, {c.key: c for c in cycle.checks}, searches

    def published_state(self, at):
        """A state whose last publication the backfill found at `at`."""
        state = monitor.empty_state()
        self.run_cycle(state, [(at, served())], at, backfill=[(at, served())])
        return state

    def test_a_silent_service_is_critical_after_10_minutes(self):
        state = self.published_state(self.at(12, 0, 3, day=-1))
        now = self.at(10)
        _, checks, _ = self.run_cycle(state, [(now - 30, featured_tick())], now)
        self.assertEqual(checks['featured:lines'].level, monitor.OK)
        _, checks, _ = self.run_cycle(state, [], now - 30 + 599)
        self.assertEqual(checks['featured:lines'].level, monitor.OK)
        _, checks, _ = self.run_cycle(state, [], now - 30 + 600)
        self.assertEqual((checks['featured:lines'].level, checks['featured:lines'].text),
                         (monitor.CRIT, 'Top pools: o serviço não registra nada há 10 min'))
        # In shadow the service's ticks are idle and print nothing.
        _, checks, _ = self.run_cycle(state, [(now + 600, featured_tick(phase='shadow'))], now + 3600)
        self.assertEqual(checks['featured:lines'].level, monitor.OK)
        _, checks, _ = self.run_cycle(monitor.empty_state(), [], now, backfill=self.NO_MATCH)
        self.assertEqual(checks['featured:lines'].level, monitor.CRIT)  # never seen

    def test_a_day_not_published_by_12_31_warns_with_why_until_a_list_is(self):
        state = self.published_state(self.at(12, 0, 3, day=-1))
        # 2 Nov 2026 as the service logged it: a selection kept the old list, then the publication carried it.
        day = [(self.at(11, 31, 25), featured_tick(selection={'outcome': 'carried_over', 'selectionDate': '2026-11-02',
                                                              'candidates': 46, 'evaluated': 18, 'eligible': 1})),
               (self.at(11, 31, 55), featured_tick(selection={'outcome': 'already_done'})),
               (self.at(12, 0, 28), featured_tick(publication={'status': 'no_draft'})),
               (self.at(12, 30, 3), featured_tick(publication={'status': 'carried_over', 'revision': 94})),
               (self.at(12, 30, 33), featured_tick(publication={'status': 'published'}))]
        _, checks, _ = self.run_cycle(state, day, self.at(12, 30, 59))
        self.assertEqual(checks['featured:publication'].level, monitor.OK)  # yesterday's list, before 12:31
        _, checks, _ = self.run_cycle(state, [(self.at(12, 31), featured_tick())], self.at(12, 31))
        why = ('Top pools: a lista de 02/11 não foi publicada (publicação carried_over; seleção carried_over, '
               '1 elegível(is) de 18 avaliado(s))')
        self.assertEqual((checks['featured:publication'].level, checks['featured:publication'].text),
                         (monitor.WARN, why))
        # It holds overnight, with the day's reason, until a list is published.
        _, checks, _ = self.run_cycle(state, [(self.at(9, day=1), featured_tick())], self.at(9, day=1))
        self.assertEqual((checks['featured:publication'].level, checks['featured:publication'].text),
                         (monitor.WARN, why))
        _, checks, _ = self.run_cycle(state, [(self.at(12, 0, 3, day=1), served(95))], self.at(12, 1, day=1))
        self.assertEqual(checks['featured:publication'].level, monitor.OK)

    def test_newcomers_not_ready_by_12_25_are_named(self):
        # 20 Oct 2026: the day's selection waited on a newcomer's decimals, then the list was carried.
        state = self.published_state(self.at(12, 0, 3, day=-1))
        pool = '0x462958d2' + 'ab' * 28
        day = [(self.at(11, 35, 20), featured_tick(selection={'outcome': 'selected', 'candidates': 86,
                                                              'evaluated': 34, 'eligible': 5})),
               (self.at(12, 24, 31), featured_tick(publication={'status': 'warming',
                                                                'unready': {pool: 'token_decimals_pending'}})),
               (self.at(12, 25, 3), featured_tick(publication={'status': 'carried_over', 'revision': 61}))]
        _, checks, _ = self.run_cycle(state, day, self.at(12, 32))
        self.assertEqual(checks['featured:publication'].text,
                         'Top pools: a lista de 02/11 não foi publicada (publicação carried_over; seleção selected, '
                         '5 elegível(is) de 34 avaliado(s); novatos não prontos: 0x462958d2ab… token_decimals_pending)')

    def test_a_list_two_days_old_is_critical_from_its_publication_not_its_repairs(self):
        published = self.at(12, 0, 3, day=-3)  # 30 Oct 2026, 12:00:03: the list still served on 2 Nov
        state = self.published_state(published)
        repaired = featured_tick(health={'status': 'repaired', 'revision': 91, 'removed': {}, 'added': []})
        _, checks, _ = self.run_cycle(state, [(published + 3 * self.HOUR, repaired)], published + 48 * self.HOUR - 1)
        self.assertEqual(checks['featured:age'].level, monitor.OK)
        _, checks, _ = self.run_cycle(state, [(published + 48 * self.HOUR, featured_tick())], published + 48 * self.HOUR)
        self.assertEqual((checks['featured:age'].level, checks['featured:age'].text),
                         (monitor.CRIT, 'Top pools: a lista no ar é de 30/10 12:00 UTC, há 48 h'))

    def test_a_monitor_without_history_finds_the_last_publication_once(self):
        now, published = self.at(14), self.at(12, 0, 3, day=-3)
        state = monitor.empty_state()
        _, checks, searches = self.run_cycle(state, [(now - 30, featured_tick())], now,
                                             backfill=[(published, served())], quiet=True)
        self.assertEqual(checks['featured:age'].level, monitor.CRIT)
        self.assertIn('--since=-7d', searches[0])
        self.assertIn(f'--grep={monitor.FEATURED_SERVED}', searches[0])
        _, _, searches = self.run_cycle(state, [(now + 30, featured_tick())], now + 60)
        self.assertEqual(searches, [])  # once
        # Nothing published in the journal's 7 days: critical too.
        state = monitor.empty_state()
        _, checks, _ = self.run_cycle(state, [(now - 30, featured_tick())], now, backfill=self.NO_MATCH)
        self.assertEqual((checks['featured:age'].level, state['featured']['backfilled']), (monitor.CRIT, True))
        # A search that failed says so, and is made again the next cycle.
        state = monitor.empty_state()
        broken = subprocess.CalledProcessError(1, ['journalctl'], output='', stderr='Bad pattern')
        _, checks, _ = self.run_cycle(state, [(now - 30, featured_tick())], now, backfill=broken)
        self.assertEqual(checks['featured:age'].level, monitor.WARN)
        _, checks, searches = self.run_cycle(state, [], now + 60, backfill=[(published, served())])
        self.assertEqual((len(searches), checks['featured:age'].level), (1, monitor.CRIT))

    def test_fewer_than_three_pools_is_critical(self):
        state = self.published_state(self.at(12, 0, 3))
        now = self.at(13)
        for health, pools, level in (({'status': 'idle', 'vacant': 6}, 0, monitor.CRIT),
                                     ({'status': 'idle'}, 0, monitor.CRIT),
                                     ({'status': 'healthy'}, 6, monitor.OK),
                                     ({'status': 'healthy', 'vacant': 4}, 2, monitor.CRIT),
                                     ({'status': 'healthy', 'vacant': 3}, 3, monitor.OK)):
            with self.subTest(health=health):
                _, checks, _ = self.run_cycle(state, [(now, featured_tick(health=health))], now)
                self.assertEqual((state['featured']['pools'], checks['featured:pools'].level), (pools, level))
        # A repair's own line does not say how many are left: the next tick's does.
        _, checks, _ = self.run_cycle(state, [(now, featured_tick(health={'status': 'repaired', 'removed': {}}))], now)
        self.assertEqual(state['featured']['pools'], 3)

    def test_each_withdrawal_is_an_event_with_the_pool_and_why(self):
        state = self.published_state(self.at(12, 0, 3))
        first, second = '0x387bf619' + '11' * 28, '0xea9f200e' + '22' * 28
        repair = featured_tick(health={'status': 'repaired', 'revision': 90, 'added': ['0x24107d15' + '33' * 28],
                                       'removed': {first: 'estimate_unavailable', second: 'volume_collapse'}})
        cycle, _, _ = self.run_cycle(state, [(self.at(14, 30, 24), repair)], self.at(14, 31))
        self.assertEqual(cycle.events, [(monitor.WARN, 'Top pools: pool 0x387bf61911… retirado (estimate_unavailable)'),
                                        (monitor.WARN, 'Top pools: pool 0xea9f200e22… retirado (volume_collapse)')])
        self.assertEqual(cycle.sections['featured']['withdrawn24h'], 2)
        self.assertIn('Top pools: lista publicada em 02/11 12:00 UTC, 6 pool(s) no ar, 2 retirada(s) em 24 h',
                      monitor.summary_text(cycle, state))
        # The unit's first read is history: counted, never announced.
        cycle, _, _ = self.run_cycle(monitor.empty_state(), [(self.at(14, 30, 24), repair)], self.at(14, 31),
                                     backfill=[(self.at(12, 0, 3), served())], quiet=True)
        self.assertEqual((cycle.events, cycle.sections['featured']['withdrawn24h']), ([], 2))

    def test_the_owners_list_is_neither_published_nor_aged_and_null_turns_it_off(self):
        state = self.published_state(self.at(12, 0, 3, day=-5))
        _, checks, _ = self.run_cycle(state, [(self.at(13), featured_tick(mode='manual'))], self.at(13))
        self.assertEqual(set(checks), {'featured:lines'})
        cycle, checks, searches = self.run_cycle(monitor.empty_state(), [], self.at(13), cfg=config(featured=None))
        self.assertEqual((checks, searches, cycle.sections), ({}, [], {}))
        self.assertEqual(config().featured, 'domino-featured.service')  # absent: the production unit
        with self.assertRaisesRegex(ValueError, '^monitor_config_featured$'):
            config(featured='domino featured')

    def test_the_numbers_are_the_services_own(self):
        import featured_live
        import featured_pools
        policy = featured_pools.load_policy()
        self.assertEqual(monitor.featured_policy(), (policy['size'], policy['selectionHourUtc']))
        self.assertEqual(monitor.FEATURED_PUBLISH_MINUTES, featured_live.PUBLISH_BY_MINUTES + 1)
        # The search matches a publication as the service prints it, and nothing else.
        printed = json.dumps({'service': 'featured', 'phase': 'live',
                              'live': {'mode': 'auto', 'keptWarm': 0,
                                       'publication': {'status': 'served', 'revision': 89, 'withheld': []},
                                       'health': {'status': 'healthy'}}})
        self.assertTrue(re.search(monitor.FEATURED_SERVED, printed))
        self.assertFalse(re.search(monitor.FEATURED_SERVED, printed.replace('"served"', '"carried_over"')))


class FakeRpc:
    def __init__(self, head=1000, balance=5 * 10**15, logs=()):
        self.head, self.balance, self.logs, self.calls = head, balance, list(logs), []

    def request(self, method, params):
        self.calls.append((method, params))
        if method == 'eth_getBlockByNumber':
            return {'number': hex(self.head), 'timestamp': hex(int(NOW) - 5)}
        if method == 'eth_getBalance':
            return hex(self.balance)
        if method == 'eth_getLogs':
            return self.logs
        raise AssertionError(method)


class Chains:
    def __init__(self, rpcs):
        self.rpcs = rpcs

    def client(self, chain):
        return self.rpcs[chain]


class ChainTests(unittest.TestCase):
    def run_chains(self, state, rpcs, now=NOW, node=lambda url: (5, int(NOW) - 30)):
        cycle = monitor.Cycle(now)
        monitor.check_chains(cycle, config(), state, Chains(rpcs), node=node)
        return cycle, {c.key: c for c in cycle.checks}

    def test_balances_by_threshold_and_what_left_the_address(self):
        state = monitor.empty_state()
        base = FakeRpc(balance=5 * 10**15)
        _, checks = self.run_chains(state, {'robinhood-4663': FakeRpc(), 'base-8453': base})
        self.assertEqual(checks['balance:V2 operator:base-8453'].level, monitor.OK)
        self.assertIn(('eth_getBalance', [OPERATOR, hex(1000)]), base.calls)
        base.balance = 2 * 10**15
        _, checks = self.run_chains(state, {'robinhood-4663': FakeRpc(), 'base-8453': base}, now=NOW + 3600)
        self.assertEqual(checks['balance:V2 operator:base-8453'].level, monitor.WARN)
        base.balance = 10**15 - 1
        cycle, checks = self.run_chains(state, {'robinhood-4663': FakeRpc(), 'base-8453': base}, now=NOW + 7200)
        self.assertEqual(checks['balance:V2 operator:base-8453'].level, monitor.CRIT)
        # 5 -> 2 -> 1-wei-short of 1: spent 4e15 - 1 over the hours, a top-up does not hide it.
        self.assertEqual(int(cycle.sections['balances'][0]['spent24h']), 4 * 10**15 + 1)
        self.assertEqual(monitor.spent([[0, 10], [1, 4], [2, 20], [3, 15]], 15), 11)

    def test_the_node_s_lag_and_a_silent_node(self):
        state = monitor.empty_state()
        rpcs = {'robinhood-4663': FakeRpc(), 'base-8453': FakeRpc()}
        _, checks = self.run_chains(state, rpcs, node=lambda url: (5, int(NOW) - 200))
        self.assertEqual(checks['node:robinhood-4663'].level, monitor.WARN)
        _, checks = self.run_chains(state, rpcs, node=lambda url: (5, int(NOW) - 700))
        self.assertEqual(checks['node:robinhood-4663'].level, monitor.CRIT)

        def silent(url):
            raise monitor.MonitorError('monitor_node_unreachable')
        _, checks = self.run_chains(state, rpcs, node=silent)
        self.assertEqual(checks['node:robinhood-4663'].level, monitor.CRIT)
        posted = monitor.node_head('http://127.0.0.1:18547/', post=lambda: json.dumps(
            {'result': {'number': '0x10', 'timestamp': '0x20'}}).encode())
        self.assertEqual(posted, (16, 32))
        with self.assertRaisesRegex(ValueError, '^monitor_node_unreachable$'):
            monitor.node_head('http://127.0.0.1:18547/', post=lambda: b'{"error": {}}')

    def test_a_chain_whose_reads_fail_warns_without_stopping_the_others(self):
        class Broken(FakeRpc):
            def request(self, method, params):
                raise monitor.DataError('v2_rpc_unavailable')
        state = monitor.empty_state()
        _, checks = self.run_chains(state, {'robinhood-4663': FakeRpc(), 'base-8453': Broken()})
        self.assertEqual(checks['chain:base-8453'].level, monitor.WARN)
        self.assertIn('v2_rpc_unavailable', checks['chain:base-8453'].text)
        self.assertEqual(checks['chain:robinhood-4663'].level, monitor.OK)

    def test_registry_logs_start_at_the_head_then_follow_and_catch_up_a_window_at_a_time(self):
        state = monitor.empty_state()
        halt = encode_log('registry', 'AutomationHaltSet', {'halted': True}, address=REGISTRY, block_number=1005,
                          block_hash=block_hash(1005), tx_hash=tx_hash('h'), log_index=0)
        operator = encode_log('registry', 'OperatorSet', {'operator': OPERATOR, 'allowed': False}, address=REGISTRY,
                              block_number=1006, block_hash=block_hash(1006), tx_hash=tx_hash('o'), log_index=0)
        base = FakeRpc(head=1000)
        rpcs = {'robinhood-4663': FakeRpc(head=1000), 'base-8453': base}
        cycle, _ = self.run_chains(state, rpcs)
        self.assertFalse(any(method == 'eth_getLogs' for method, _ in base.calls))  # no backfill
        self.assertEqual(state['registry']['base-8453'], 998)
        base.head, base.logs = 1010, [halt, operator]
        cycle, _ = self.run_chains(state, rpcs)
        self.assertIn(('eth_getLogs', [{'address': REGISTRY, 'fromBlock': hex(999), 'toBlock': hex(1008)}]),
                      base.calls)
        names = [text for _, text in cycle.events]
        self.assertTrue(any('AutomationHaltSet {"halted": true}' in text and '(bloco 1005)' in text for text in names))
        self.assertTrue(any('OperatorSet' in text for text in names))
        self.assertTrue(all(level == monitor.CRIT for level, _ in cycle.events if 'base-8453' in _))
        self.assertEqual(state['registry']['base-8453'], 1008)
        # A long gap: one window per cycle from the cursor, never skipping a block.
        base.head, base.logs = 1008 + 12_000, []
        self.run_chains(state, rpcs)
        self.assertEqual(state['registry']['base-8453'], 1008 + 5000)
        unknown = {**halt, 'topics': ['0x' + 'ee' * 32]}
        self.assertTrue(monitor.decode_registry(unknown)[0].startswith('evento desconhecido'))


class PolicyTests(unittest.TestCase):
    def cycle(self, now, level, events=()):
        cycle = monitor.Cycle(now)
        cycle.check('k', level, f'texto {level}')
        cycle.events.extend(events)
        return cycle

    def test_a_level_counts_after_two_cycles_recovers_once_and_a_critical_one_repeats_every_three_hours(self):
        state = monitor.empty_state()
        self.assertEqual(monitor.transitions(self.cycle(NOW, monitor.CRIT), state), [])
        self.assertEqual(monitor.transitions(self.cycle(NOW + 60, monitor.CRIT), state), ['🔴 texto 2'])
        self.assertEqual(monitor.transitions(self.cycle(NOW + 120, monitor.CRIT), state), [])
        self.assertEqual(monitor.transitions(self.cycle(NOW + 60 + 3 * 3600, monitor.CRIT), state),
                         ['🔴 ainda: texto 2'])
        # One good cycle between two bad ones is not a recovery.
        self.assertEqual(monitor.transitions(self.cycle(NOW + 4 * 3600, monitor.OK), state), [])
        self.assertEqual(monitor.transitions(self.cycle(NOW + 4 * 3600 + 60, monitor.CRIT), state), [])
        monitor.transitions(self.cycle(NOW + 4 * 3600 + 120, monitor.OK), state)
        self.assertEqual(monitor.transitions(self.cycle(NOW + 4 * 3600 + 180, monitor.OK), state),
                         ['🟢 normalizado: texto 0'])
        self.assertEqual(state['levels']['k'], monitor.OK)

    def test_a_level_confirmed_at_once_alerts_at_its_first_cycle_and_recovers_like_any_other(self):
        state = monitor.empty_state()
        cycle = monitor.Cycle(NOW)
        cycle.check('k', monitor.CRIT, 'falhou', confirm=1)
        self.assertEqual(monitor.transitions(cycle, state), ['🔴 falhou'])
        self.assertEqual(monitor.transitions(self.cycle(NOW + 60, monitor.OK), state), [])
        self.assertEqual(monitor.transitions(self.cycle(NOW + 120, monitor.OK), state), ['🟢 normalizado: texto 0'])

    def test_a_warning_is_announced_once_and_a_check_that_disappears_is_forgotten(self):
        state = monitor.empty_state()
        monitor.transitions(self.cycle(NOW, monitor.WARN), state)
        self.assertEqual(monitor.transitions(self.cycle(NOW + 60, monitor.WARN), state), ['🟡 texto 1'])
        self.assertEqual(monitor.transitions(self.cycle(NOW + 10 * 3600, monitor.WARN), state), [])
        monitor.transitions(monitor.Cycle(NOW + 11 * 3600), state)
        self.assertNotIn('k', state['levels'])

    def test_events_follow_the_checks(self):
        state = monitor.empty_state()
        messages = monitor.transitions(self.cycle(NOW, monitor.OK, [(monitor.OK, 'novo vault'),
                                                                   (monitor.CRIT, 'halt')]), state)
        self.assertEqual(messages, ['ℹ️ novo vault', '🔴 halt'])
        # Kept for the dashboard, the last RECENT of them with their time.
        self.assertEqual(state['recentEvents'], [{'at': int(NOW), 'text': 'ℹ️ novo vault'},
                                                 {'at': int(NOW), 'text': '🔴 halt'}])
        for index in range(monitor.RECENT):
            monitor.transitions(self.cycle(NOW + index, monitor.OK, [(monitor.OK, f'e{index}')]), state)
        self.assertEqual(len(state['recentEvents']), monitor.RECENT)
        self.assertEqual(state['recentEvents'][-1]['text'], f'ℹ️ e{monitor.RECENT - 1}')
        self.assertEqual(monitor.snapshot(monitor.Cycle(NOW), state, telegram_status='off')['recentEvents'],
                         state['recentEvents'])


class TelegramTests(unittest.TestCase):
    def test_the_token_never_leaves_the_request(self):
        seen = []

        def refuse(request, timeout):
            seen.append(request.full_url)
            raise urllib.error.HTTPError(request.full_url, 401, 'Unauthorized', {}, None)
        bot = monitor.Telegram(TOKEN, '4242', opener=refuse)
        with self.assertRaises(monitor.TelegramError) as caught:
            bot.send('x')
        self.assertEqual(str(caught.exception), 'telegram_http_401')
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertIn(TOKEN, seen[0])  # only in the request itself
        self.assertNotIn(TOKEN, repr(bot))

        def unreachable(request, timeout):
            raise OSError(f'connect failed {request.full_url}')
        with self.assertRaises(monitor.TelegramError) as caught:
            monitor.Telegram(TOKEN, '4242', opener=unreachable).send('x')
        self.assertEqual(str(caught.exception), 'telegram_unreachable')
        self.assertNotIn(TOKEN, str(caught.exception))
        with self.assertRaisesRegex(ValueError, '^telegram_token_invalid$'):
            monitor.Telegram('not-a-token', '4242')

    def test_long_text_is_split_and_a_refusal_is_a_code(self):
        sent = []

        class Reply:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, size):
                return self.body

        def accept(request, timeout):
            sent.append(json.loads(request.data))
            return Reply(b'{"ok": true, "result": {}}')
        monitor.Telegram(TOKEN, '4242', opener=accept).send('a' * (monitor.MAX_MESSAGE + 10))
        self.assertEqual([len(m['text']) for m in sent], [monitor.MAX_MESSAGE, 10])
        self.assertEqual({m['chat_id'] for m in sent}, {'4242'})
        with self.assertRaisesRegex(ValueError, '^telegram_refused$'):
            monitor.Telegram(TOKEN, '4242', opener=lambda r, timeout: Reply(b'{"ok": false}')).send('x')

    def test_commands_come_only_from_the_configured_chat(self):
        updates = [{'update_id': 7, 'message': {'chat': {'id': 4242}, 'text': '/status@domino_ops_bot'}},
                   {'update_id': 8, 'message': {'chat': {'id': 999}, 'text': '/status'}},
                   {'update_id': 9, 'message': {'chat': {'id': 4242}, 'text': 'hello'}},
                   {'update_id': 10, 'message': {'chat': {'id': 4242}, 'text': '/RESUMO now'}}]
        self.assertEqual(monitor.commands(updates, '4242'), (['/status', '/resumo'], 11))
        self.assertEqual(monitor.commands([], '4242'), ([], None))

    def test_the_token_comes_from_the_credentials_directory_only(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'telegram-bot-token').write_text(TOKEN + '\n')
            self.assertEqual(monitor.read_token('telegram-bot-token', {'CREDENTIALS_DIRECTORY': directory}), TOKEN)
            # Without the unit's credentials directory nothing is read, from anywhere.
            with unittest.mock.patch.object(monitor.Path, 'read_text', side_effect=AssertionError('read')):
                self.assertIsNone(monitor.read_token('telegram-bot-token', {}))
            self.assertIsNone(monitor.read_token('other', {'CREDENTIALS_DIRECTORY': directory}))


class ServiceTests(unittest.TestCase):
    def test_a_cycle_end_to_end_and_its_snapshot_holds_nothing_secret(self):
        state = monitor.empty_state()
        shows = ('Id=domino-read.service\nLoadState=loaded\nActiveState=active\nNRestarts=0\n\n'
                 'Id=domino-crosschain.service\nLoadState=loaded\nActiveState=active\nNRestarts=0\n\n'
                 'Id=domino-gas-settlement.timer\nActiveState=active\n\n'
                 'Id=domino-gas-settlement.service\nResult=success\n')

        def run(args):
            if args[0].endswith('systemctl'):
                return shows
            unit = args[args.index('-u') + 1]
            if unit == 'domino-featured.service':
                return journal((NOW - 23 * 3600, served()) if any(a.startswith('--grep=') for a in args)
                               else (NOW - 5, featured_tick()))
            if unit.startswith('domino-v2-automation'):
                return journal((NOW - 5, pass_line()))
            if unit.startswith('domino-v2-indexer'):
                return journal((NOW - 5, json.dumps({'status': 'indexed', 'through': 1})))
            if unit == 'domino-automation.service':
                return journal((NOW - 5, json.dumps({'event': 'cycle', 'outcome': 'wait'})))
            return journal((NOW - 5, json.dumps({'route': 'quote', 'status': 200})))
        cycle = monitor.cycle_once(config(), state, run=run, now=NOW,
                                   chains=Chains({'robinhood-4663': FakeRpc(), 'base-8453': FakeRpc()}),
                                   node=lambda url: (5, int(NOW) - 30), usage=lambda path: (100, 41, 59))
        self.assertEqual({c.key: c.level for c in cycle.checks if c.level != monitor.OK}, {})
        self.assertEqual(cycle.events, [])  # first reads are history
        self.assertEqual(state['cursors']['domino-v2-automation@base-8453.service'], 'c1')
        text = json.dumps(monitor.snapshot(cycle, state, telegram_status='ok'))
        self.assertNotIn('http', text)
        self.assertNotIn(TOKEN.split(':')[1], text)
        self.assertIn('Tudo normal.', monitor.status_text(cycle, state))
        summary = monitor.summary_text(cycle, state)
        self.assertIn('Automação base-8453: 1 passes, 0 erros, 0 envios, 0 confirmados, 0 vaults', summary)
        self.assertIn('Alertas abertos: nenhum', summary)

    def test_the_summary_is_due_once_a_day_after_its_hour(self):
        cfg, state = config(), monitor.empty_state()
        morning = datetime.datetime(2026, 10, 5, 11, 20, tzinfo=datetime.timezone.utc).timestamp()
        self.assertFalse(monitor.summary_due(cfg, state, morning)[0])
        due, today = monitor.summary_due(cfg, state, morning + 3600)
        self.assertEqual((due, today), (True, '2026-10-05'))
        state['summaryDate'] = today
        self.assertFalse(monitor.summary_due(cfg, state, morning + 7200)[0])

    def test_serve_alerts_on_telegram_writes_both_files_and_answers_status(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = config(statusFile=f'{directory}/status.json', stateFile=f'{directory}/state.json')
            sent, clock = [], iter([NOW, NOW, NOW + 1, NOW + 1])

            class Bot:
                chat_id = '4242'

                def send(self, text):
                    sent.append(text)

                def updates(self, offset, timeout):
                    return [{'update_id': 3, 'message': {'chat': {'id': 4242}, 'text': '/status'}}]

            class Stop(Exception):
                pass

            def tick():
                try:
                    return next(clock)
                except StopIteration:
                    raise Stop() from None
            original = monitor.cycle_once

            def fake_cycle(config, state, **kwargs):
                cycle = monitor.Cycle(kwargs['now'])
                cycle.check('k', monitor.OK, 'tudo ok')
                return cycle
            monitor.cycle_once = fake_cycle
            try:
                with self.assertRaises(Stop):
                    monitor.serve(cfg, telegram=Bot(), clock=tick, sleep=lambda s: None)
            finally:
                monitor.cycle_once = original
            self.assertTrue(any(text.startswith('Domino: status') for text in sent))
            status = Path(directory, 'status.json')
            self.assertEqual(stat.S_IMODE(status.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE(Path(directory, 'state.json').stat().st_mode), 0o600)
            self.assertEqual(json.loads(status.read_text())['kind'], 'domino-monitor-status')
            self.assertEqual(json.loads(Path(directory, 'state.json').read_text())['telegramOffset'], 4)


class NativeSymbolTests(unittest.TestCase):
    """Balances and gas are said in the chain's own native currency: ETH on the live chains, HYPE on a chain whose
    profile names it (v2_hype_chain's synthetic Elysium)."""

    def test_each_chain_says_its_profiles_native_currency(self):
        import shutil
        import v2_hype_chain as hype
        directory = tempfile.mkdtemp(prefix='domino-hype-')
        try:
            registry = hype.registry(directory)
        finally:
            shutil.rmtree(directory)
        monitor.native_symbol.cache_clear()
        self.addCleanup(monitor.native_symbol.cache_clear)
        with unittest.mock.patch('v2_chains.default_registry', return_value=registry):
            self.assertEqual([monitor.native_symbol(key) for key in ('base-8453', hype.KEY, 'nowhere-1')],
                             ['ETH', 'HYPE', 'ETH'])


if __name__ == '__main__':
    unittest.main()
