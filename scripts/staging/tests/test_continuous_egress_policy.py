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
NEW_CHAINS = ('performance', 'performance_collector', 'execution_status', 'execution_signer')


def identities():
    result = {}
    for index, role in enumerate(policy.ROLES):
        unit = policy.unit_of(role)
        result[role] = {'user': 'domino-' + role, 'realUid': 2000 + index, 'effectiveUid': 2000 + index,
                        'gid': 3000 + index, 'supplementaryGids': [], 'unit': unit,
                        'cgroup': '/system.slice/' + unit if unit else None}
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
        pins = {**PINS, 'rpc.domino.money': ['16.0.0.1'],
                'rpc.mainnet.chain.robinhood.com': ['16.0.0.2']}
        result = policy.render(snapshot(pins=pins))
        for role in ('read', 'write'):
            self.assertTrue({'rpc.domino.money', 'rpc.mainnet.chain.robinhood.com',
                             'robinhood-mainnet.g.alchemy.com'} <= set(result['roleHosts'][role]))
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
        self.assertEqual(enabled['read'], baseline['read'][:-1] + [grant, baseline['read'][-1]])
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

    def test_domino_rpc_does_not_admit_sibling_suffix_or_credential_hosts(self):
        for host, reason in (('ws.domino.money', 'unapproved_hostname'),
                             ('other.domino.money', 'unapproved_hostname'),
                             ('rpc.domino.money.evil.example', 'unapproved_hostname'),
                             ('rpc.domino.money/PRIVATE_CANARY/', 'invalid_hostname')):
            with self.subTest(host=host):
                self.reject(snapshot(pins={**PINS, host: ['16.0.0.1']}), reason)

    def test_describes_the_live_host_exactly_and_closes_the_four_identity_gaps(self):
        live_chains, live_sets = parse(BASELINE)
        chains, sets = parse(mask(nft(policy.render(snapshot()))))
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
        added = [line for line in rendered if line not in live]
        self.assertTrue(all(any(chain in line for chain in NEW_CHAINS) for line in added), added)
        # Only the write block was folded in by hand: its set precedes its chain
        # and its resolver pair is reversed. Everything else is in live order.
        without_write = lambda values: [v for v in values if ' write ' not in v and v.endswith(' write') is False]
        self.assertEqual([v for v in without_write(live) if v in rendered],
                         [v for v in without_write(rendered) if v in live])

    def test_the_read_path_drop_ins_and_target_are_the_installed_ones(self):
        result = policy.render(snapshot())
        read = dropin(result, 'read').splitlines()
        self.assertEqual(read[:9], [
            '# Explicit continuous read activation; fail closed behind the scoped nft policy.',
            '[Unit]', 'BindsTo=domino-continuous-egress.service',
            'After=domino-continuous-egress.service network-online.target', 'Wants=network-online.target',
            'PartOf=domino-continuous-reads.target', 'ConditionPathExists=',
            'ConditionPathExists=/run/domino-continuous-reads.ready', '[Service]'])
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
            'counter name denied_auth drop'])
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
        self.assertIn('domino-auth.service', result['artifacts']['/etc/systemd/system/domino-continuous-reads.target'])
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
        self.assertEqual(len(chains['execution_status']), 4)
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
            self.assertEqual(len(chains[chain]), 2)
            self.assertFalse(any('sport' in rule for rule in chains[chain]))
        self.assertNotIn('exact performance-collector origin', nft(result))
        for role in ('performance-collector', 'execution-signer'):
            text = dropin(result, role)
            self.assertNotIn('ExecStart', text)
            self.assertIn(f'BindReadOnlyPaths=/etc/domino/continuous-reads/{role}.hosts:/etc/hosts', text)

    def test_every_family_enabled_renders_only_hyphen_free_nft_identifiers(self):
        every = LIVE_ENABLED + ('auth', 'onboarding', 'deposit', 'performance',
                                'performance-collector', 'execution-status', 'execution-signer')
        text = nft(policy.render(snapshot(every, {**PINS, **UNISWAP})))
        names = re.findall(r'add (?:chain|counter|set) inet \w+ (\S+)', text) + re.findall(r'jump (\S+)', text)
        self.assertTrue(names)
        for name in names:
            self.assertRegex(name, r'^[a-z_][a-z0-9_]*$')
        self.assertEqual(text.count('counter name denied_'), 13)

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
        self.assertEqual(nft(policy.render(data)).count('counter name denied_'), 12)

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

    def test_enable_commands_are_derived_from_the_installer_not_copied(self):
        for role in policy.ENABLE_ARGUMENTS:
            with self.subTest(role=role):
                installed = next(line for line in financial.unit_text(role, '0' * 40).splitlines()
                                 if line.startswith('ExecStart='))
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
