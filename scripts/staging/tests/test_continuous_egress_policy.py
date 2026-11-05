"""Offline checks of the continuous egress renderer: it must describe the live
host exactly, close the four identity gaps, and switch a family on only when
named. No kernel, resolver or host qualification."""
from copy import deepcopy
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import continuous_egress_policy as policy
import egress_policy as shared
import install_crosschain as crosschain
import install_position_plan as position_plan
import upgrade_financial as financial

SCRIPT = Path(policy.__file__)
BASELINE = (Path(__file__).resolve().parent / 'fixtures' / 'continuous_policy_baseline.nft').read_text()
IP = re.compile(r'(?<![\d.])(?!127\.)(?:\d{1,3}\.){3}\d{1,3}(?![\d.])')
LIVE_ENABLED = ('read', 'gateway', 'tunnel', 'write')
ISSUER = 'team-example.cloudflareaccess.com'
# One synthetic address per pin the live host holds, so element counts match.
PINS = {'api.geckoterminal.com': ['11.0.0.1', '11.0.0.2'],
        'robinhood-mainnet.g.alchemy.com': ['12.0.0.1', '12.0.0.2', '12.0.0.3'],
        'api.dexscreener.com': ['13.0.0.1', '13.0.0.2'],
        ISSUER: ['14.0.0.1', '14.0.0.2'],
        **{host: sorted(addresses) for host, addresses in shared.EDGE_ADDRESSES.items()}}
UNISWAP = {'trade-api.gateway.uniswap.org': ['15.0.0.1'], 'liquidity.api.uniswap.org': ['15.0.0.2']}
BRIDGES = {'api.relay.link': ['18.0.0.1', '18.0.0.2', '18.0.0.3', '18.0.0.4'], 'app.across.to': ['19.0.0.1', '19.0.0.2']}
TELEGRAM = {'api.telegram.org': ['20.0.0.1']}
NEW_CHAINS = ('performance', 'performance_collector', 'execution_status', 'execution_signer')


def identities(plan_listener=False, automation=False, bridge=False, monitor=False):
    """The live host's identities. The S1 plan listener's exists only once install_position_plan.py ran, the V2
    automation's once install_v2_automation.py did, the S2 crosschain listener's once install_crosschain.py did,
    the monitor's once install_monitor.py did."""
    result = {}
    for index, role in enumerate(policy.ROLES):
        unit = policy.unit_of(role)
        result[role] = {'user': 'domino-' + role, 'realUid': 2000 + index, 'effectiveUid': 2000 + index,
                        'gid': 3000 + index, 'supplementaryGids': [], 'unit': unit,
                        'cgroup': '/system.slice/' + unit if unit else None}
    if not plan_listener:
        result['position-plan'] = None
    if not automation:
        result['v2-automation'] = None
    if not bridge:
        result['crosschain'] = None
    if not monitor:
        result['monitor'] = None
    return result


def snapshot(enabled=LIVE_ENABLED, pins=None):
    pins = PINS if pins is None else pins
    return {'version': 1, 'resolver': '127.0.0.53', 'accessIssuer': ISSUER,
            'enabled': list(enabled), 'identities': identities(),
            'hosts': [{'hostname': host, 'addresses': list(addresses)} for host, addresses in pins.items()]}


def mask(text):
    return re.sub(r'meta skuid \d+', 'meta skuid <uid>', IP.sub('<ip>', text))


def parse(text):
    """Chains as ordered rule lists and sets as element counts; comments dropped."""
    chains, sets = {}, {}
    for line in text.splitlines():
        if line.startswith('#') or not line.strip():
            continue
        found = re.match(r'add set inet \w+ (\w+) \{ type ipv4_addr; elements = \{ ([^}]+) \}; \}', line)
        if found:
            sets[found[1]] = len(found[2].split(', '))
            continue
        found = re.match(r'add rule inet \w+ (\w+) (.*)', line)
        if found:
            chains.setdefault(found[1], []).append(found[2])
            continue
        chains.setdefault('', []).append(line)
    return chains, sets


def normalised(rules):
    # The two stub-resolver lines of a chain are one unordered pair.
    return ([rule for rule in rules if 'dport 53' not in rule],
            sorted(rule for rule in rules if 'dport 53' in rule))


def nft(result):
    return result['artifacts'][policy.ROOT + '/policy.nft']


def reset(chain):
    """The rule ahead of every chain's final drop since #315: only a connection attempt is refused aloud."""
    return (f'tcp flags & (syn | ack) == syn counter name denied_{chain} '
            'reject with tcp reset comment "refused connection attempt"')


def drops(text):
    return re.findall(r'^add rule inet \w+ (\w+) counter name denied_(\w+) drop$', text, re.M)


def live(chains):
    """Rendered chains as the live host holds them, which predates the reset rule."""
    return {chain: [rule for rule in rules if rule != reset(chain)] for chain, rules in chains.items()}


class PublicCollectorPolicyTests(unittest.TestCase):
    def test_analytics_grant_is_explicit_and_scoped_to_existing_writer_identity(self):
        original=snapshot()
        before=policy.render(original)
        after=policy.render({**original,'publicDataCollectors':True})
        self.assertNotIn('api.geckoterminal.com',before['roleHosts']['write'])
        self.assertIn('api.geckoterminal.com',after['roleHosts']['write'])
        for role,hosts in before['roleHosts'].items():
            if role!='write':self.assertEqual(hosts,after['roleHosts'][role])
        self.assertNotEqual(before['pinSetSha256'],after['pinSetSha256'])

    def test_invalid_or_disabled_collector_identity_refused(self):
        for change in ({'publicDataCollectors':'true'},
                       {'publicDataCollectors':True,'enabled':['read','gateway','tunnel']}):
            with self.subTest(change=change),self.assertRaises(policy.InvalidSnapshot):
                policy.render({**snapshot(),**change})


def dropin(result, role):
    return result['artifacts'][f'/etc/systemd/system/domino-{role}.service.d/{policy.DROPIN}']


class ContinuousEgressTests(unittest.TestCase):
    def reject(self, data, code):
        with self.assertRaises(policy.InvalidSnapshot) as raised:
            policy.render(data)
        self.assertEqual(str(raised.exception), code)

    def test_domino_rpc_and_existing_providers_have_only_pinned_https_egress(self):
        pins = {**PINS, 'rpc.domino.money': ['16.0.0.1']}
        result = policy.render(snapshot(pins=pins))
        for role in ('read', 'write'):
            self.assertTrue({'rpc.domino.money', 'robinhood-mainnet.g.alchemy.com'} <= set(result['roleHosts'][role]))
            self.assertNotIn('rpc.mainnet.chain.robinhood.com', result['roleHosts'][role])
        # Robinhood's public RPC is no egress destination: pinning it is refused.
        self.reject(snapshot(pins={**pins, 'rpc.mainnet.chain.robinhood.com': ['16.0.0.2']}), 'unapproved_hostname')
        self.assertIn('16.0.0.1 rpc.domino.money\n', result['artifacts'][policy.ROOT + '/read.hosts'])
        self.assertIn('IPAddressAllow=16.0.0.1/32\n', dropin(result, 'read'))
        self.assertIn('IPAddressDeny=any\n', dropin(result, 'read'))
        chains, _ = parse(nft(result))
        self.assertTrue(chains['read'][-1].endswith('drop'))
        self.assertTrue(chains['write'][-1].endswith('drop'))
        self.assertTrue(all('tcp dport 443' in rule for role in ('read', 'write')
                            for rule in chains[role] if 'oifname != "lo"' in rule))
        self.assertNotIn('ws.domino.money', json.dumps(result))

    def test_v4_snapshot_loopback_grants_only_the_read_identity_exact_rpc_port(self):
        original = snapshot()
        before = policy.render(original)
        after = policy.render({**original, 'sequenceSnapshotLoopback': True})
        baseline, _ = parse(nft(before))
        enabled, _ = parse(nft(after))
        grant = ('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                 'tcp dport 18547 ct direction original counter accept '
                 'comment "private V4 snapshot RPC"')
        self.assertEqual(enabled['read'], baseline['read'][:-2] + [grant, *baseline['read'][-2:]])
        for role in baseline.keys() - {'read'}:
            self.assertEqual(enabled[role], baseline[role])
        self.assertNotIn('tcp dport 18547', nft(before))
        self.assertNotIn('tcp dport 8547', nft(after))
        self.assertNotEqual(before['pinSetSha256'], after['pinSetSha256'])
        self.assertEqual(dropin(before, 'read'), dropin(after, 'read'))

    def test_v4_snapshot_loopback_requires_explicit_boolean_and_reader(self):
        self.reject({**snapshot(), 'sequenceSnapshotLoopback': 'true'},
                    'invalid_sequence_snapshot_loopback')
        self.reject({**snapshot(('gateway', 'tunnel', 'write')),
                     'sequenceSnapshotLoopback': True}, 'snapshot_loopback_requires_reader')

    def test_node_loopback_reads_grant_the_reader_and_the_writer_only_the_node_port(self):
        original = snapshot()
        before = policy.render(original)
        after = policy.render({**original, 'nodeLoopbackReads': True})
        baseline, _ = parse(nft(before))
        enabled, _ = parse(nft(after))
        grant = ('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                 'tcp dport 18547 ct direction original counter accept comment "private node RPC"')
        for role in ('read', 'write'):
            self.assertEqual(enabled[role], baseline[role][:-2] + [grant, *baseline[role][-2:]])
        for role in baseline.keys() - {'read', 'write'}:
            self.assertEqual(enabled[role], baseline[role])
        self.assertNotIn('tcp dport 18547', nft(before))
        self.assertNotIn('tcp dport 8547', nft(after))
        self.assertNotEqual(before['pinSetSha256'], after['pinSetSha256'])
        others = lambda result: {path: text for path, text in result['artifacts'].items()
                                 if path != policy.ROOT + '/policy.nft'}
        self.assertEqual(others(before), others(after))
        # With the V4 snapshot opt-in too, the reader still holds one rule for the port.
        both, _ = parse(nft(policy.render({**original, 'nodeLoopbackReads': True,
                                           'sequenceSnapshotLoopback': True})))
        self.assertEqual(both['read'], enabled['read'])
        # Only an enabled identity is granted.
        no_analytics = {host: addresses for host, addresses in PINS.items()
                        if host not in policy.ANALYTICS_HOSTS}
        writer, _ = parse(nft(policy.render({**snapshot(('gateway', 'tunnel', 'write'), no_analytics),
                                             'nodeLoopbackReads': True})))
        self.assertIn(grant, writer['write'])
        self.assertNotIn('tcp dport 18547', '\n'.join(writer['read']))

    def test_node_loopback_reads_need_an_explicit_boolean_and_a_reader_or_writer(self):
        self.reject({**snapshot(), 'nodeLoopbackReads': 'true'}, 'invalid_node_loopback_reads')
        self.reject({**snapshot(), 'nodeLoopbackReads': 1}, 'invalid_node_loopback_reads')
        self.reject({**snapshot(('gateway', 'tunnel')), 'nodeLoopbackReads': True},
                    'node_loopback_requires_reader_or_writer')

    def test_the_writer_reads_a_hosts_file_of_exactly_the_addresses_its_set_admits(self):
        # rpc.domino.money answered with one Cloudflare pair, then another, five
        # minutes apart; the writer resolved through the stub and its set held
        # only the first pair (#315). Its units now read this file instead.
        pins = {**PINS, 'rpc.domino.money': ['16.0.0.1', '16.0.0.2', '16.0.0.3', '16.0.0.4']}
        result = policy.render({**snapshot(pins=pins), 'publicDataCollectors': True})
        path = policy.ROOT + '/write.hosts'
        self.assertEqual(result['artifactMetadata'][path], {'uid': 0, 'gid': 0, 'mode': 0o644})
        lines = result['artifacts'][path].splitlines()
        self.assertEqual(lines[:2], ['127.0.0.1 localhost', '::1 localhost ip6-localhost ip6-loopback'])
        pinned = [line.split() for line in lines[2:]]
        self.assertEqual({host for _, host in pinned}, set(policy.RPC_HOSTS) | set(policy.ANALYTICS_HOSTS))
        self.assertEqual([address for address, host in pinned if host == 'rpc.domino.money'],
                         ['16.0.0.1', '16.0.0.2', '16.0.0.3', '16.0.0.4'])
        elements = re.search(r'add set inet \w+ write_ipv4 \{ type ipv4_addr; elements = \{ ([^}]+) \}; \}',
                             nft(result))[1].split(', ')
        self.assertEqual(sorted(address for address, _ in pinned), sorted(elements))
        # A file, not a unit: the writer's units are the public-data installer's.
        self.assertNotIn('/etc/systemd/system/domino-write.service.d/' + policy.DROPIN, result['artifacts'])
        self.assertEqual(result['units'], ['domino-read.service', 'domino-gateway.service', 'domino-tunnel.service'])
        without = policy.render(snapshot(('read', 'gateway', 'tunnel'),
                                         {host: addresses for host, addresses in PINS.items()}))
        self.assertNotIn(path, without['artifacts'])

    def test_every_member_restarts_for_as_long_as_it_fails(self):
        every = LIVE_ENABLED + ('auth', 'onboarding', 'deposit', 'performance',
                                'performance-collector', 'execution-status', 'execution-signer', 'position-plan',
                                'v2-automation', 'crosschain', 'monitor')
        data = {**snapshot(every, {**PINS, **UNISWAP, **BRIDGES, **TELEGRAM}),
                'identities': identities(plan_listener=True, automation=True, bridge=True, monitor=True)}
        result = policy.render(data)
        dropins = {path: text for path, text in result['artifacts'].items() if path.endswith('/' + policy.DROPIN)}
        self.assertTrue({f'/etc/systemd/system/domino-{role}.service.d/{policy.DROPIN}'
                         for role in ('read', 'gateway', 'tunnel', 'auth', 'execution-status', 'position-plan',
                                      'crosschain')} <= set(dropins))
        for path, text in dropins.items():
            with self.subTest(path=path):
                unit_section = text.split('[Service]')[0]
                self.assertIn('\nStartLimitIntervalSec=0\n', unit_section)

    def test_a_refused_connection_attempt_is_reset_and_any_other_packet_still_dropped(self):
        every = LIVE_ENABLED + ('auth', 'onboarding', 'deposit', 'performance',
                                'performance-collector', 'execution-status', 'execution-signer', 'position-plan',
                                'v2-automation', 'crosschain', 'monitor')
        data = {**snapshot(every, {**PINS, **UNISWAP, **BRIDGES, **TELEGRAM}),
                'identities': identities(plan_listener=True, automation=True, bridge=True, monitor=True)}
        chains, _ = parse(nft(policy.render(data)))
        for role in policy.ROLES:
            chain = policy.nft_name(role)
            with self.subTest(chain=chain):
                # Only a SYN without ACK, a new connection, is answered: a reset for
                # a stray packet of a connection a rule accepted would tear it down.
                self.assertEqual(chains[chain][-2:], [reset(chain), f'counter name denied_{chain} drop'])
                self.assertEqual(sum('reject' in rule for rule in chains[chain]), 1)

    def test_domino_rpc_does_not_admit_sibling_suffix_or_credential_hosts(self):
        for host, reason in (('ws.domino.money', 'unapproved_hostname'),
                             ('other.domino.money', 'unapproved_hostname'),
                             ('rpc.domino.money.evil.example', 'unapproved_hostname'),
                             ('rpc.domino.money/PRIVATE_CANARY/', 'invalid_hostname')):
            with self.subTest(host=host):
                self.reject(snapshot(pins={**PINS, host: ['16.0.0.1']}), reason)

    def test_describes_the_live_host_exactly_and_closes_the_four_identity_gaps(self):
        live_chains, live_sets = parse(BASELINE)
        rendered, sets = parse(mask(nft(policy.render(snapshot()))))
        # The one deliberate difference: each chain resets a refused connection attempt.
        chains = live(rendered)
        for chain in set(rendered) - {'', 'output'}:
            self.assertEqual(rendered[chain][-2:], [reset(chain), f'counter name denied_{chain} drop'])
            self.assertEqual(len(rendered[chain]), len(chains[chain]) + 1)
        self.assertEqual(sets, live_sets)
        for chain, rules in live_chains.items():
            if chain in ('', 'output'):
                continue
            with self.subTest(chain=chain):
                self.assertEqual(normalised(chains[chain]), normalised(rules))
        self.assertEqual(sorted(set(chains) - set(live_chains)), sorted(NEW_CHAINS))
        for chain in NEW_CHAINS:
            # Not enabled: a listener reply where there is a listener, then the drop.
            self.assertTrue(all('ct direction reply' in rule or rule.endswith('drop')
                                for rule in chains[chain]), chain)
        self.assertEqual(len(chains['output']), len(live_chains['output']) + 4)
        self.assertTrue(set(live_chains['output']) <= set(chains['output']))

    def test_a_first_apply_changes_nothing_but_the_hand_written_irregularities(self):
        def lines(text):
            result = []
            for line in text.splitlines():
                if line.startswith('#') or line.startswith('add set '):
                    continue
                result.append(line)
            return result
        live, rendered = lines(BASELINE), lines(mask(nft(policy.render(snapshot()))))
        self.assertEqual(set(live) - set(rendered), set())
        added = [line for line in rendered if line not in live
                 and not line.endswith(' reject with tcp reset comment "refused connection attempt"')]
        self.assertTrue(all(any(chain in line for chain in NEW_CHAINS) for line in added), added)
        # Only the write block was folded in by hand: its set precedes its chain
        # and its resolver pair is reversed. Everything else is in live order.
        without_write = lambda values: [v for v in values if ' write ' not in v and v.endswith(' write') is False]
        self.assertEqual([v for v in without_write(live) if v in rendered],
                         [v for v in without_write(rendered) if v in live])

    def test_the_read_path_drop_ins_and_target_are_the_installed_ones(self):
        result = policy.render(snapshot())
        read = dropin(result, 'read').splitlines()
        self.assertEqual(read[:10], [
            '# Explicit continuous read activation; fail closed behind the scoped nft policy.',
            '[Unit]', 'BindsTo=domino-continuous-egress.service',
            'After=domino-continuous-egress.service network-online.target', 'Wants=network-online.target',
            'PartOf=domino-continuous-reads.target', 'ConditionPathExists=',
            'ConditionPathExists=/run/domino-continuous-reads.ready', 'StartLimitIntervalSec=0', '[Service]'])
        allowed = [line for line in read if line.startswith('IPAddressAllow=') and line != 'IPAddressAllow=']
        self.assertEqual(allowed, ['IPAddressAllow=127.0.0.1/32'] + [
            f'IPAddressAllow={address}/32' for address in sorted(
                PINS['api.geckoterminal.com'] + PINS['robinhood-mainnet.g.alchemy.com'] + PINS['api.dexscreener.com'],
                key=lambda value: tuple(map(int, value.split('.'))))])
        self.assertIn('BindReadOnlyPaths=/etc/domino/continuous-reads/read.hosts:/etc/hosts', read)
        gateway = dropin(result, 'gateway')
        self.assertIn('Requires=domino-read.service\nAfter=domino-read.service\n[Service]', gateway)
        self.assertIn('EnvironmentFile=/etc/domino/continuous-reads/gateway.env', gateway)
        tunnel = dropin(result, 'tunnel')
        self.assertIn('IPAddressAllow=127.0.0.1/32\nIPAddressAllow=127.0.0.53/32\n', tunnel)
        self.assertEqual(tunnel.count('IPAddressAllow=198.41.'), 20)
        for role in LIVE_ENABLED[:3]:
            self.assertNotIn('ExecStart', dropin(result, role))
            self.assertNotIn('User=', dropin(result, role))
        self.assertNotIn('/etc/systemd/system/domino-write.service.d/' + policy.DROPIN, result['artifacts'])
        target = result['artifacts']['/etc/systemd/system/domino-continuous-reads.target']
        self.assertIn('Requires=domino-continuous-egress.service domino-read.service '
                      'domino-gateway.service domino-tunnel.service\n', target)
        # The connector resolves the edge names itself; the hosts file pins only
        # what the application reads through /etc/hosts.
        self.assertNotIn('argotunnel', result['artifacts'][policy.ROOT + '/tunnel.hosts'])
        self.assertEqual(result['artifacts'][policy.ROOT + '/gateway.hosts'],
                         '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n'
                         f'14.0.0.1 {ISSUER}\n14.0.0.2 {ISSUER}\n')

    def test_enabling_a_family_switches_on_exactly_its_three_layers(self):
        result = policy.render(snapshot(LIVE_ENABLED + ('auth',)))
        chains, sets = parse(nft(result))
        self.assertEqual(sets['auth_ipv4'], 5)
        self.assertEqual(chains['auth'], [
            'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport 8879 ct direction reply '
            'ct state established counter accept comment "exact listener reply"',
            'oifname != "lo" ip daddr @auth_ipv4 tcp dport 443 counter accept comment "operator pinned external"',
            reset('auth'), 'counter name denied_auth drop'])
        self.assertIn('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp dport 8879 ct direction original '
                      'counter accept comment "exact auth origin"', chains['tunnel'])
        text = dropin(result, 'auth')
        self.assertIn('ExecStart=\n' + policy.enable_command('auth') + '\n', text)
        self.assertTrue(policy.enable_command('auth').endswith(
            'backend/session_api.py --port 8879 --enable --rpc-config /run/domino-financial-auth-config/rpc.json'))
        self.assertIn('BindReadOnlyPaths=/etc/domino/continuous-reads/auth.hosts:/etc/hosts', text)
        self.assertNotIn('EnvironmentFile', text)
        # The reset line, loopback, and one line per pinned address.
        self.assertEqual(text.count('IPAddressAllow='), 1 + 1 + 5)
        self.assertNotIn('127.0.0.53', text)
        hosts = result['artifacts'][policy.ROOT + '/auth.hosts']
        self.assertIn(f'14.0.0.1 {ISSUER}\n', hosts)
        self.assertIn('12.0.0.3 robinhood-mainnet.g.alchemy.com\n', hosts)
        self.assertNotIn('geckoterminal', hosts)
        target = result['artifacts']['/etc/systemd/system/domino-continuous-reads.target']
        # The target starts the family but does not require it: a family's restarts
        # stay its own instead of restarting the read path.
        self.assertIn('Requires=domino-continuous-egress.service domino-read.service '
                      'domino-gateway.service domino-tunnel.service\n', target)
        self.assertIn('\nWants=domino-auth.service\n', target)
        self.assertIn(' domino-auth.service domino-tunnel.service\n', target.split('After=')[1])
        self.assertEqual(result['units'], ['domino-read.service', 'domino-gateway.service',
                                           'domino-auth.service', 'domino-tunnel.service'])
        # Off again: nothing of it remains.
        off = policy.render(snapshot())
        self.assertNotIn('auth_ipv4', nft(off))
        self.assertNotIn('exact auth origin', nft(off))
        self.assertNotIn('/etc/systemd/system/domino-auth.service.d/' + policy.DROPIN, off['artifacts'])

    def test_status_identity_gets_only_pinned_jwks_and_exact_loopback_rpc(self):
        result = policy.render(snapshot(LIVE_ENABLED + ('execution-status',)))
        chains, sets = parse(nft(result))
        self.assertEqual(result['roleHosts']['execution-status'],[ISSUER])
        self.assertEqual(sets['execution_status_ipv4'],2)
        self.assertEqual(len(chains['execution_status']), 5)
        self.assertIn('oifname != "lo" ip daddr @execution_status_ipv4 tcp dport 443 '
                      'counter accept comment "operator pinned external"',chains['execution_status'])
        self.assertEqual(chains['execution_status'][2],
                         'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                         'tcp dport 18547 ct direction original counter accept '
                         'comment "private execution-status EOA RPC"')
        self.assertTrue(chains['execution_status'][-1].endswith('drop'))
        self.assertNotIn('tcp dport 8547', nft(result))
        for role in ('auth','onboarding','deposit','performance'):
            self.assertNotIn('tcp dport 18547','\n'.join(chains[role]))
        self.assertIn('tcp dport 8901 ct direction original counter accept comment "exact execution-status origin"',
                      '\n'.join(chains['tunnel']))
        text = dropin(result, 'execution-status')
        self.assertEqual(text.count('IPAddressAllow='), 1 + 1 + 2)
        self.assertIn('IPAddressAllow=14.0.0.1/32\n',text)
        self.assertIn('IPAddressAllow=14.0.0.2/32\n',text)
        self.assertIn('14.0.0.1 '+ISSUER+'\n',result['artifacts'][policy.ROOT+'/execution-status.hosts'])
        self.assertIn('BindReadOnlyPaths='+policy.ROOT+'/execution-status.hosts:/etc/hosts\n',text)
        self.assertIn('--port 8901 --enable --config /run/domino-financial-execution-status-config/profile.json\n', text)

    def test_status_identity_requires_jwks_pin_and_does_not_gain_public_rpc(self):
        isolated = policy.render(snapshot(('execution-status',),{ISSUER:PINS[ISSUER]}))
        self.assertEqual(isolated['roleHosts']['execution-status'],[ISSUER])
        self.assertNotIn('rpc.mainnet.chain.robinhood.com',nft(isolated))
        self.reject(snapshot(('execution-status',),{}),'incomplete_host_inventory')

    def test_the_collector_and_the_signer_get_egress_but_no_listener_or_enable_flag(self):
        result = policy.render(snapshot(LIVE_ENABLED + ('performance-collector', 'execution-signer')))
        chains, sets = parse(nft(result))
        for chain in ('performance_collector', 'execution_signer'):
            self.assertEqual(sets[chain + '_ipv4'], 3)
            self.assertEqual(chains[chain][1:], [reset(chain), f'counter name denied_{chain} drop'])
            self.assertFalse(any('sport' in rule for rule in chains[chain]))
        self.assertNotIn('exact performance-collector origin', nft(result))
        for role in ('performance-collector', 'execution-signer'):
            text = dropin(result, role)
            self.assertNotIn('ExecStart', text)
            self.assertIn(f'BindReadOnlyPaths=/etc/domino/continuous-reads/{role}.hosts:/etc/hosts', text)

    def test_every_family_enabled_renders_only_hyphen_free_nft_identifiers(self):
        every = LIVE_ENABLED + ('auth', 'onboarding', 'deposit', 'performance',
                                'performance-collector', 'execution-status', 'execution-signer', 'position-plan',
                                'v2-automation', 'crosschain', 'monitor')
        text = nft(policy.render({**snapshot(every, {**PINS, **UNISWAP, **BRIDGES, **TELEGRAM}),
                                  'identities': identities(plan_listener=True, automation=True, bridge=True,
                                                           monitor=True)}))
        names = re.findall(r'add (?:chain|counter|set) inet \w+ (\S+)', text) + re.findall(r'jump (\S+)', text)
        self.assertTrue(names)
        for name in names:
            self.assertRegex(name, r'^[a-z_][a-z0-9_]*$')
        self.assertEqual([chain for chain, counter in drops(text) if chain == counter],
                         [policy.nft_name(role) for role in policy.ROLES])

    def test_pins_no_enabled_role_needs_are_refused(self):
        self.reject(snapshot(pins={**PINS, **UNISWAP}), 'unapproved_hostname')
        self.reject(snapshot(pins={**PINS, 'other.example.com': ['16.0.0.1']}), 'unapproved_hostname')
        self.reject(snapshot(pins={**PINS, 'RPC.example.com': ['16.0.0.1']}), 'invalid_hostname')
        self.reject(snapshot(('read', 'write'), {**PINS}), 'unapproved_hostname')

    def test_enabling_a_family_without_its_required_pins_is_refused(self):
        self.reject(snapshot(LIVE_ENABLED + ('onboarding',)), 'incomplete_host_inventory')
        without_issuer = {host: addresses for host, addresses in PINS.items() if host != ISSUER}
        self.reject(snapshot(('read', 'auth'), without_issuer), 'incomplete_host_inventory')
        one_region = {host: addresses for host, addresses in PINS.items() if host != 'region2.v2.argotunnel.com'}
        self.reject(snapshot(pins=one_region), 'incomplete_host_inventory')
        no_rpc = {host: addresses for host, addresses in PINS.items() if host != 'robinhood-mainnet.g.alchemy.com'}
        self.reject(snapshot(pins=no_rpc), 'incomplete_host_inventory')

    def test_enabled_and_identities_are_exact(self):
        for enabled, code in ((('read', 'random'), 'unknown_enabled_role'),
                              (('read', 'operator'), 'unknown_enabled_role'),
                              (('read', 'admin'), 'unknown_enabled_role'),
                              (('read', 'read'), 'invalid_enabled_roles')):
            with self.subTest(enabled=enabled):
                self.reject(snapshot(enabled), code)
        data = snapshot(); data['enabled'] = 'read'
        self.reject(data, 'invalid_enabled_roles')
        data = snapshot(); del data['identities']['performance']
        self.reject(data, 'invalid_identity_roles')
        data = snapshot(); data['identities']['write']['unit'] = 'domino-write.service'
        self.reject(data, 'unexpected_service_unit')
        data = snapshot(); data['identities']['performance']['unit'] = 'domino-performance-collector.service'
        self.reject(data, 'invalid_service_unit')
        data = snapshot(); data['identities']['read']['token'] = 'DO-NOT-ECHO'
        self.reject(data, 'invalid_identity_fields')
        data = snapshot(); data['identities']['admin'] = None
        text = nft(policy.render(data))
        self.assertEqual(len(drops(text)), 12)
        self.assertEqual(text.count(' reject with tcp reset '), 12)

    def test_addresses_issuer_and_resolver_are_bounded(self):
        for address in ('127.0.0.1', '10.1.2.3', '169.254.169.254', '2001:db8::1', '1.1.1.1/32'):
            with self.subTest(address=address):
                with self.assertRaises(policy.InvalidSnapshot):
                    policy.render(snapshot(pins={**PINS, 'api.dexscreener.com': [address]}))
        self.reject(snapshot(pins={**PINS, 'region1.v2.argotunnel.com': ['198.41.200.13']}), 'unapproved_edge_address')
        data = snapshot(); data['hosts'].append(dict(data['hosts'][0]))
        self.reject(data, 'duplicate_hostname')
        data = snapshot(); data['resolver'] = '8.8.8.8'
        self.reject(data, 'invalid_resolver')
        data = snapshot(); data['accessIssuer'] = 'cloudflareaccess.com.evil.example.com'
        self.reject(data, 'invalid_access_issuer')
        data = snapshot(); data['apiKey'] = 'not-a-real-key'
        self.reject(data, 'invalid_snapshot_fields')

    def test_every_listener_is_started_with_the_private_file_it_refuses_to_run_without(self):
        # session_api.load_session_rpc_config raises without --rpc-config;
        # onboarding and deposit use the same loader. A bare --enable exits.
        for role in ('auth', 'onboarding', 'deposit'):
            with self.subTest(role=role):
                self.assertIn(f' --enable --rpc-config /run/domino-financial-{role}-config/rpc.json',
                              policy.enable_command(role))
        self.assertIn(' --enable --profile /run/domino-financial-performance-config/profile.json',
                      policy.enable_command('performance'))
        self.assertIn(' --enable --config /run/domino-financial-execution-status-config/profile.json',
                      policy.enable_command('execution-status'))

    def test_the_uniswap_class_covers_every_host_the_listeners_post_to(self):
        # onboarding and deposit quote through the trade gateway and preview or
        # read pool info through the liquidity API; pinning only one host would
        # have the other refused at the socket while the family is enabled.
        self.assertEqual(policy.UNISWAP_HOSTS,
                         frozenset(('trade-api.gateway.uniswap.org', 'liquidity.api.uniswap.org')))
        both = policy.render(snapshot(LIVE_ENABLED + ('onboarding',), {**PINS, **UNISWAP}))
        self.assertEqual(sorted(both['roleHosts']['onboarding']),
                         ['liquidity.api.uniswap.org', 'robinhood-mainnet.g.alchemy.com',
                          'team-example.cloudflareaccess.com', 'trade-api.gateway.uniswap.org'])
        one = {**PINS, 'trade-api.gateway.uniswap.org': ['15.0.0.1']}
        self.assertEqual(policy.render(snapshot(LIVE_ENABLED + ('onboarding',), one))['roleHosts']['onboarding'].count('liquidity.api.uniswap.org'), 0)

    def test_the_plan_listener_is_optional_until_installed_and_needs_its_identity_when_enabled(self):
        self.assertEqual(policy.render(snapshot()), policy.render({**snapshot(), 'identities': identities()}))
        data = snapshot(enabled=(*LIVE_ENABLED, 'position-plan'), pins={**PINS, **UNISWAP})
        self.reject(data, 'enabled_role_without_identity')
        installed = {**snapshot(), 'identities': identities(plan_listener=True)}
        text = nft(policy.render(installed))
        chains, _ = parse(mask(text))
        # Installed but not enabled: its own chain refuses everything but the replies of its listener.
        self.assertEqual([rule for rule in chains['position_plan'] if 'accept' in rule],
                         ['oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport 8911 ct direction reply '
                          'ct state established counter accept comment "exact listener reply"'])
        self.assertFalse(any('8911' in rule for rule in chains['tunnel']))

    def test_the_plan_listener_enabled_reaches_rpc_access_and_uniswap_and_the_tunnel_reaches_it(self):
        enabled = (*LIVE_ENABLED, 'position-plan')
        data = {**snapshot(enabled=enabled, pins={**PINS, 'rpc.domino.money': ['16.0.0.1'], **UNISWAP}),
                'identities': identities(plan_listener=True)}
        rendered = policy.render(data)
        chains, sets = parse(mask(nft(rendered)))
        self.assertIn('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp dport 8911 ct direction original '
                      'counter accept comment "exact position-plan origin"', chains['tunnel'])
        self.assertEqual(sets['position_plan_ipv4'],
                         len(PINS['robinhood-mainnet.g.alchemy.com']) + 1 + len(PINS[ISSUER]) + 2)
        self.assertFalse(any('18547' in rule for rule in chains['position_plan']))
        dropin = rendered['artifacts'][policy.UNIT_DIR + 'domino-position-plan.service.d/' + policy.DROPIN]
        self.assertIn('ExecStart=\n' + policy.enable_command('position-plan') + '\n', dropin)
        self.assertTrue(policy.enable_command('position-plan').endswith(
            'v2_position_plan_api.py --port 8911 --enable --rpc-config '
            '/run/domino-financial-position-plan-config/rpc.json'))
        hosts = rendered['artifacts'][policy.ROOT + '/position-plan.hosts']
        for host in ('rpc.domino.money', 'robinhood-mainnet.g.alchemy.com', ISSUER, *UNISWAP):
            self.assertIn(' ' + host + '\n', hosts)
        target = rendered['artifacts'][policy.UNIT_DIR + policy.TARGET]
        self.assertIn('domino-position-plan.service', target.split('Wants=', 2)[1].split('\n')[0])
        self.assertNotIn('domino-position-plan.service', target.split('Requires=')[1].split('\n')[0])

    def test_the_v2_chains_grant_is_explicit_and_reaches_only_the_chain_roles(self):
        # Base and Arbitrum (backend/v2_rpc.py): the reader's chain reads, the writer's indexer instances, the plan
        # listener's plans, the V2 automation, the monitor, and the crosschain listener's Across fee proofs.
        chains = {host: [f'17.0.0.{index}'] for index, host in enumerate(sorted(policy.CHAIN_HOSTS), 1)}
        enabled = (*LIVE_ENABLED, 'auth', 'position-plan', 'v2-automation', 'monitor', 'crosschain')
        everyone = identities(plan_listener=True, automation=True, bridge=True, monitor=True)
        before = policy.render({**snapshot(enabled, {**PINS, **UNISWAP, **TELEGRAM, **BRIDGES}), 'identities': everyone})
        granted = {**snapshot(enabled, {**PINS, **UNISWAP, **TELEGRAM, **BRIDGES, **chains}), 'identities': everyone,
                   'v2Chains': True}
        after = policy.render(granted)
        for role in policy.CHAIN_ROLES:
            self.assertEqual(sorted(after['roleHosts'][role]), sorted({*before['roleHosts'][role], *chains}))
            hosts = after['artifacts'][f'{policy.ROOT}/{role}.hosts']
            for host, (address,) in chains.items():
                self.assertIn(f'{address} {host}\n', hosts)
        for role, hosts in after['roleHosts'].items():
            if role not in policy.CHAIN_ROLES:
                self.assertEqual(hosts, before['roleHosts'][role], role)
        sets_before, sets_after = parse(nft(before))[1], parse(nft(after))[1]
        granted_sets = ('read_ipv4', 'write_ipv4', 'position_plan_ipv4', 'v2_automation_ipv4', 'ops_monitor_ipv4',
                        'crosschain_ipv4')
        for name in granted_sets:
            self.assertEqual(sets_after[name], sets_before[name] + len(chains), name)
        self.assertEqual({name: count for name, count in sets_after.items() if name not in granted_sets},
                         {name: count for name, count in sets_before.items() if name not in granted_sets})
        for unit in ('domino-read.service', 'domino-position-plan.service', 'domino-crosschain.service'):
            listener = after['artifacts'][policy.UNIT_DIR + unit + '.d/' + policy.DROPIN]
            for (address,) in chains.values():
                self.assertIn(f'IPAddressAllow={address}/32\n', listener)
        self.assertNotEqual(before['pinSetSha256'], after['pinSetSha256'])
        # Pinned without the grant, they are no role's.
        self.reject({**granted, 'v2Chains': False}, 'unapproved_hostname')
        self.reject({key: value for key, value in granted.items() if key != 'v2Chains'}, 'unapproved_hostname')

    def test_the_chain_list_is_the_enabled_profiles_each_hosted_one_with_its_names(self):
        # v2-chains.json, the one list the V2 installers and this policy read (v2_release_chains), against the
        # profiles themselves: enabling a chain without its hosts, or listing one not enabled, fails here.
        import v2_release_chains as chains
        profiles = Path(__file__).resolve().parents[3] / 'api-contracts/v2/chains'
        documents = [json.loads(path.read_text()) for path in sorted(profiles.glob('*.json'))]
        enabled = sorted(f"{d['slug']}-{d['chainId']}" for d in documents if d['enabled'])
        self.assertEqual(sorted(chains.CHAINS), enabled)
        # Robinhood's routes are the own node's and its fallback (RPC_HOSTS); every other chain is hosted.
        self.assertEqual(chains.CHAINS['robinhood-4663'], ())
        self.assertTrue(all(hosts for name, hosts in chains.CHAINS.items() if name != 'robinhood-4663'))
        self.assertEqual(policy.CHAIN_HOSTS, frozenset(host for hosts in chains.CHAINS.values() for host in hosts))
        self.assertFalse(policy.CHAIN_HOSTS & policy.RPC_HOSTS)

    def test_a_malformed_chain_list_is_refused_whole_and_a_new_chain_with_its_hosts_loads(self):
        import tempfile
        import v2_release_chains as chains
        good = json.loads(chains.PATH.read_text())
        cases = {
            'another kind': lambda d: d.update(kind='domino-v2-chains'),
            'no chain': lambda d: d.update(chains={}),
            'a name without its id': lambda d: d['chains'].update({'elysium': {'egressHosts': []}}),
            'an extra key': lambda d: d['chains']['base-8453'].update(rpc='hosted'),
            'a URL for a host': lambda d: d['chains']['base-8453'].update(egressHosts=['https://mainnet.base.org/']),
            'one host for two chains': lambda d: d['chains']['arbitrum-42161']['egressHosts'].append('mainnet.base.org'),
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'v2-chains.json'
            for case, change in cases.items():
                document = deepcopy(good)
                change(document)
                path.write_text(json.dumps(document))
                with self.subTest(case=case), self.assertRaisesRegex(ValueError, '^invalid_v2_release_chains$'):
                    chains.load(path)
            document = deepcopy(good)
            document['chains']['synthetic-424242'] = {'egressHosts': ['rpc.synthetic.example']}
            path.write_text(json.dumps(document))
            self.assertEqual(list(chains.load(path)), [*good['chains'], 'synthetic-424242'])

    def test_the_chains_class_is_every_host_the_provisioned_file_names(self):
        # /etc/domino/v2/chain-rpc.json since 3 Oct: Chainstack, then Alchemy, then each chain's public endpoint
        # (docs/v2/F6_BACKEND.md). A host the file names and the set lacks would be refused at the socket, and
        # the clients would fail over past it.
        self.assertEqual(policy.CHAIN_HOSTS, frozenset((
            'base-mainnet.core.chainstack.com', 'base-mainnet.g.alchemy.com', 'mainnet.base.org',
            'arbitrum-mainnet.core.chainstack.com', 'arb-mainnet.g.alchemy.com', 'arb1.arbitrum.io')))

    def test_the_v2_chains_grant_needs_a_boolean_and_a_role_that_reads_them(self):
        self.reject({**snapshot(), 'v2Chains': 'true'}, 'invalid_v2_chains')
        self.reject({**snapshot(('gateway', 'tunnel')), 'v2Chains': True}, 'v2_chains_require_a_chain_role')
        # The reader alone takes it too: read-v6's chain reads (chain-pools, chain-balances).
        chains = {host: [f'17.0.0.{index}'] for index, host in enumerate(sorted(policy.CHAIN_HOSTS), 1)}
        reader = policy.render({**snapshot(('read', 'gateway', 'tunnel'), {**PINS, **chains}), 'v2Chains': True})
        self.assertLessEqual(set(chains), set(reader['roleHosts']['read']))
        self.assertFalse(set(chains) & set(reader['roleHosts']['gateway']))
        # The writer alone takes it, before the plan listener's identity exists.
        chains = {host: [f'17.0.0.{index}'] for index, host in enumerate(sorted(policy.CHAIN_HOSTS), 1)}
        result = policy.render({**snapshot(pins={**PINS, **chains}), 'v2Chains': True})
        self.assertLessEqual(set(chains), set(result['roleHosts']['write']))
        self.assertNotIn('position-plan', result['roleHosts'])

    def test_the_balance_chains_grant_is_explicit_and_reaches_the_reader_alone(self):
        # Ethereum and OP Mainnet (the reader's balance chain RPC file): read-v6's chain-balances, when asked.
        balances = {host: [f'21.0.0.{index}'] for index, host in enumerate(sorted(policy.BALANCE_CHAIN_HOSTS), 1)}
        chains = {host: [f'17.0.0.{index}'] for index, host in enumerate(sorted(policy.CHAIN_HOSTS), 1)}
        enabled = (*LIVE_ENABLED, 'auth', 'position-plan', 'v2-automation', 'monitor', 'crosschain')
        everyone = identities(plan_listener=True, automation=True, bridge=True, monitor=True)
        pins = {**PINS, **UNISWAP, **TELEGRAM, **BRIDGES, **chains}
        before = policy.render({**snapshot(enabled, pins), 'identities': everyone, 'v2Chains': True})
        granted = {**snapshot(enabled, {**pins, **balances}), 'identities': everyone, 'v2Chains': True,
                   'balanceChains': True}
        after = policy.render(granted)
        self.assertEqual(sorted(after['roleHosts']['read']), sorted({*before['roleHosts']['read'], *balances}))
        for role, hosts in after['roleHosts'].items():
            if role != 'read':
                self.assertEqual(hosts, before['roleHosts'][role], role)
        hosts = after['artifacts'][f'{policy.ROOT}/read.hosts']
        listener = after['artifacts'][policy.UNIT_DIR + 'domino-read.service.d/' + policy.DROPIN]
        for host, (address,) in balances.items():
            self.assertIn(f'{address} {host}\n', hosts)
            self.assertIn(f'IPAddressAllow={address}/32\n', listener)
        sets_before, sets_after = parse(nft(before))[1], parse(nft(after))[1]
        self.assertEqual(sets_after['read_ipv4'], sets_before['read_ipv4'] + len(balances))
        self.assertEqual({name: count for name, count in sets_after.items() if name != 'read_ipv4'},
                         {name: count for name, count in sets_before.items() if name != 'read_ipv4'})
        self.assertNotEqual(before['pinSetSha256'], after['pinSetSha256'])
        # Pinned without the grant, they are no role's; the V2 chains' grant is not theirs.
        self.reject({**granted, 'balanceChains': False}, 'unapproved_hostname')
        self.reject({key: value for key, value in granted.items() if key != 'balanceChains'}, 'unapproved_hostname')
        # Granted alone, beside the live roles and without the V2 chains.
        alone = policy.render({**snapshot(pins={**PINS, **balances}), 'balanceChains': True})
        self.assertLessEqual(set(balances), set(alone['roleHosts']['read']))
        self.assertFalse(set(balances) & set(alone['roleHosts']['write']))

    def test_the_balance_chains_class_is_every_host_their_file_names(self):
        # Ethereum's and OP Mainnet's: Chainstack, then Alchemy, and OP Mainnet's public endpoint as a last resort.
        self.assertEqual(policy.BALANCE_CHAIN_HOSTS, frozenset((
            'ethereum-mainnet.core.chainstack.com', 'eth-mainnet.g.alchemy.com',
            'optimism-mainnet.core.chainstack.com', 'opt-mainnet.g.alchemy.com', 'mainnet.optimism.io')))
        self.assertFalse(policy.BALANCE_CHAIN_HOSTS & policy.CHAIN_HOSTS)

    def test_the_balance_chains_grant_needs_a_boolean_and_the_reader(self):
        self.reject({**snapshot(), 'balanceChains': 'true'}, 'invalid_balance_chains')
        self.reject({**snapshot(('gateway', 'tunnel', 'write')), 'balanceChains': True}, 'balance_chains_require_the_reader')
        # The grant is part of the pin digest, even before a host is pinned for it.
        self.assertNotEqual(policy.render(snapshot())['pinSetSha256'],
                            policy.render({**snapshot(), 'balanceChains': True})['pinSetSha256'])

    def test_every_class_fits_the_host_inventory_and_one_more_host_is_refused(self):
        every = {*policy.RPC_HOSTS, *policy.ANALYTICS_HOSTS, *policy.UNISWAP_HOSTS, *policy.EDGE_HOSTS,
                 *policy.CHAIN_HOSTS, *policy.BALANCE_CHAIN_HOSTS, *policy.BRIDGE_HOSTS, *policy.TELEGRAM_HOSTS,
                 ISSUER}
        self.assertLess(len(every), policy.MAX_HOSTS)
        data = snapshot()
        data['hosts'] = [{'hostname': f'h{index}.example.com', 'addresses': ['16.0.0.1']}
                         for index in range(policy.MAX_HOSTS + 1)]
        self.reject(data, 'invalid_host_inventory')

    def test_the_v2_automation_reaches_the_node_and_its_rpc_through_a_hosts_file_of_its_own(self):
        # Optional until install_v2_automation.py creates the account; enabled, it needs that identity.
        self.assertEqual(policy.render(snapshot()), policy.render({**snapshot(), 'identities': identities()}))
        self.reject({**snapshot((*LIVE_ENABLED, 'v2-automation')), 'identities': identities()},
                    'enabled_role_without_identity')
        enabled = (*LIVE_ENABLED, 'v2-automation')
        rendered = policy.render({**snapshot(enabled), 'identities': identities(automation=True),
                                  'nodeLoopbackReads': True})
        chains, sets = parse(nft(rendered))
        rules = chains['v2_automation']
        self.assertIn('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp dport 18547 ct direction original '
                      'counter accept comment "private node RPC"', rules)
        self.assertFalse(any('sport' in rule for rule in rules))  # it serves nothing
        self.assertFalse(any('dport 53' in rule for rule in rules))  # it reads its hosts file, never the stub
        self.assertEqual(sorted(rendered['roleHosts']['v2-automation']), sorted(policy.RPC_HOSTS & set(PINS)))
        self.assertEqual(sets['v2_automation_ipv4'], sum(len(PINS[h]) for h in policy.RPC_HOSTS & set(PINS)))
        hosts = rendered['artifacts'][policy.ROOT + '/v2-automation.hosts']
        self.assertIn('robinhood-mainnet.g.alchemy.com', hosts)
        # One template per chain binds that file itself: no drop-in, and the target does not name it.
        self.assertFalse(any('v2-automation' in path for path in rendered['artifacts'] if path.endswith('.conf')))
        self.assertNotIn('v2-automation', rendered['artifacts'][policy.UNIT_DIR + policy.TARGET])
        self.assertNotIn('domino-v2-automation', ' '.join(rendered['units']))

    def test_the_crosschain_listener_is_optional_until_installed_and_needs_its_identity_when_enabled(self):
        self.assertEqual(policy.render(snapshot()), policy.render({**snapshot(), 'identities': identities()}))
        self.reject(snapshot((*LIVE_ENABLED, 'crosschain'), {**PINS, **BRIDGES}), 'enabled_role_without_identity')
        installed = {**snapshot(), 'identities': identities(bridge=True)}
        chains, _ = parse(mask(nft(policy.render(installed))))
        # Installed but not enabled: its own chain refuses everything but the replies of its listener.
        self.assertEqual([rule for rule in chains['crosschain'] if 'accept' in rule],
                         ['oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport 8910 ct direction reply '
                          'ct state established counter accept comment "exact listener reply"'])
        self.assertFalse(any('8910' in rule for rule in chains['tunnel']))

    def test_the_crosschain_listener_enabled_reaches_rpc_access_and_both_bridges_and_the_tunnel_reaches_it(self):
        enabled = (*LIVE_ENABLED, 'crosschain')
        data = {**snapshot(enabled, {**PINS, 'rpc.domino.money': ['16.0.0.1'], **BRIDGES}),
                'identities': identities(bridge=True)}
        rendered = policy.render(data)
        chains, sets = parse(mask(nft(rendered)))
        self.assertIn('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp dport 8910 ct direction original '
                      'counter accept comment "exact crosschain origin"', chains['tunnel'])
        self.assertEqual(sets['crosschain_ipv4'], len(PINS['robinhood-mainnet.g.alchemy.com']) + 1
                         + len(PINS[ISSUER]) + sum(map(len, BRIDGES.values())))
        self.assertEqual(sorted(rendered['roleHosts']['crosschain']),
                         sorted(['api.relay.link', 'app.across.to', 'rpc.domino.money',
                                 'robinhood-mainnet.g.alchemy.com', ISSUER]))
        # No other role reaches the bridges; the crosschain listener reaches no Uniswap, chain or analytics host.
        for role, hosts in rendered['roleHosts'].items():
            if role != 'crosschain':
                self.assertFalse(set(hosts) & set(BRIDGES), role)
        dropin = rendered['artifacts'][policy.UNIT_DIR + 'domino-crosschain.service.d/' + policy.DROPIN]
        self.assertIn('ExecStart=\n' + policy.enable_command('crosschain') + '\n', dropin)
        self.assertTrue(policy.enable_command('crosschain').endswith(
            'crosschain_api.py --port 8910 --enable --rpc-config /run/domino-financial-crosschain-config/rpc.json'))
        for address in (a for addresses in BRIDGES.values() for a in addresses):
            self.assertIn(f'IPAddressAllow={address}/32\n', dropin)
        hosts = rendered['artifacts'][policy.ROOT + '/crosschain.hosts']
        for host in ('rpc.domino.money', 'robinhood-mainnet.g.alchemy.com', ISSUER, *BRIDGES):
            self.assertIn(' ' + host + '\n', hosts)
        target = rendered['artifacts'][policy.UNIT_DIR + policy.TARGET]
        self.assertIn('domino-crosschain.service', target.split('Wants=', 2)[1].split('\n')[0])
        self.assertNotIn('domino-crosschain.service', target.split('Requires=')[1].split('\n')[0])

    def test_the_bridges_are_required_by_the_crosschain_listener_and_nobody_else_s(self):
        self.assertEqual(policy.BRIDGE_HOSTS, frozenset(('api.relay.link', 'app.across.to')))
        enabled = (*LIVE_ENABLED, 'crosschain')
        self.reject({**snapshot(enabled), 'identities': identities(bridge=True)}, 'incomplete_host_inventory')
        for host in BRIDGES:
            with self.subTest(only=host):
                self.reject({**snapshot(enabled, {**PINS, host: BRIDGES[host]}), 'identities': identities(bridge=True)},
                            'incomplete_host_inventory')
        # Pinned while the listener is not enabled, they are no role's.
        self.reject({**snapshot(LIVE_ENABLED, {**PINS, **BRIDGES}), 'identities': identities(bridge=True)},
                    'unapproved_hostname')

    def test_the_monitor_reaches_telegram_the_node_and_its_rpc_through_a_hosts_file_of_its_own(self):
        # Optional until install_monitor.py creates the account; enabled, it needs that identity and Telegram.
        self.assertEqual(policy.render(snapshot()), policy.render({**snapshot(), 'identities': identities()}))
        enabled = (*LIVE_ENABLED, 'monitor')
        self.reject(snapshot(enabled, {**PINS, **TELEGRAM}), 'enabled_role_without_identity')
        self.reject({**snapshot(enabled), 'identities': identities(monitor=True)}, 'incomplete_host_inventory')
        rendered = policy.render({**snapshot(enabled, {**PINS, **TELEGRAM}), 'identities': identities(monitor=True),
                                  'nodeLoopbackReads': True})
        chains, sets = parse(nft(rendered))
        # nft reads `monitor` as its event command where a chain's name goes (refused on the VM, 5 Oct).
        self.assertNotIn('monitor', chains)
        uid = identities(monitor=True)['monitor']['realUid']
        self.assertIn(f'add rule inet domino_continuous_reads output meta skuid {uid} jump ops_monitor',
                      nft(rendered).splitlines())
        rules = chains['ops_monitor']
        self.assertIn('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp dport 18547 ct direction original '
                      'counter accept comment "private node RPC"', rules)
        self.assertFalse(any('sport' in rule for rule in rules))  # it serves nothing
        self.assertFalse(any('dport 53' in rule for rule in rules))  # its hosts file, never the stub
        self.assertEqual(sorted(rendered['roleHosts']['monitor']),
                         sorted([*(policy.RPC_HOSTS & set(PINS)), 'api.telegram.org']))
        self.assertEqual(sets['ops_monitor_ipv4'], sum(len(PINS[h]) for h in policy.RPC_HOSTS & set(PINS)) + 1)
        hosts = rendered['artifacts'][policy.ROOT + '/monitor.hosts']
        self.assertIn('20.0.0.1 api.telegram.org\n', hosts)
        # Its own unit binds that file and is wanted at boot by itself: no drop-in, and the read path's target,
        # whose stop would take its members with it, does not name it.
        self.assertFalse(any('monitor' in path for path in rendered['artifacts'] if path.endswith('.conf')))
        self.assertNotIn('monitor', rendered['artifacts'][policy.UNIT_DIR + policy.TARGET])
        # Telegram is the monitor's alone.
        for role, hosts in rendered['roleHosts'].items():
            if role != 'monitor':
                self.assertNotIn('api.telegram.org', hosts, role)
        self.reject({**snapshot(LIVE_ENABLED, {**PINS, **TELEGRAM}), 'identities': identities(monitor=True)},
                    'unapproved_hostname')

    def test_the_monitor_reads_base_and_arbitrum_only_with_the_v2_chains_grant(self):
        chains = {host: [f'17.0.0.{index}'] for index, host in enumerate(sorted(policy.CHAIN_HOSTS), 1)}
        enabled = (*LIVE_ENABLED, 'monitor')
        data = {**snapshot(enabled, {**PINS, **TELEGRAM, **chains}), 'identities': identities(monitor=True),
                'v2Chains': True}
        self.assertLessEqual(set(chains), set(policy.render(data)['roleHosts']['monitor']))
        self.reject({**data, 'v2Chains': False}, 'unapproved_hostname')

    def test_enable_commands_are_derived_from_the_installer_not_copied(self):
        for role in policy.ENABLE_ARGUMENTS:
            with self.subTest(role=role):
                installers = {'position-plan': position_plan, 'crosschain': crosschain}
                text = (installers[role].unit_text('0' * 40) if role in installers
                        else financial.unit_text(role, '0' * 40))
                installed = next(line for line in text.splitlines() if line.startswith('ExecStart='))
                self.assertTrue(policy.enable_command(role).startswith(installed + ' --enable'))

    def test_render_is_pure_and_the_cli_is_stdin_only_and_never_echoes(self):
        data = snapshot(); previous = deepcopy(data)
        first = policy.render(data)
        self.assertEqual(first, policy.render(data))
        self.assertEqual(data, previous)
        self.assertIs(first['applied'], False)
        self.assertIs(first['policyQualified'], False)
        self.assertIn('service start or restart', first['notPerformed'])
        self.assertEqual(set(first['artifacts']), set(first['artifactSha256']))
        self.assertEqual(first['artifactMetadata'][policy.ROOT + '/policy.nft']['mode'], 0o600)
        result = subprocess.run([sys.executable, str(SCRIPT), '--apply'], input=b'', capture_output=True, check=False)
        self.assertEqual(json.loads(result.stdout)['error'], 'stdin_only_no_arguments')
        result = subprocess.run([sys.executable, str(SCRIPT)], input=b'{"secret":"DO-NOT-ECHO"}',
                                capture_output=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b'DO-NOT-ECHO', result.stdout + result.stderr)
        result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(snapshot()).encode(),
                                capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout)['kind'], 'domino-continuous-egress-v1')


if __name__ == '__main__':
    unittest.main()
