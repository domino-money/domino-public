"""read-v6 activity's reserves_returned (v2_read_service): a closed vault's reserves paid to its owner by a
returnReserves() someone else sent, told apart from the owner's own withdrawals at read time, from the stored
transaction's sender and the registry's OperatorSet events (0xdecimal's item 8, 5 Oct 2026)."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import read_v6_contract_fixtures as fixtures  # noqa: E402
from read_v6_contract_fixtures import CHAIN, OPERATOR, OTHER, T0, T1, VAULT, WALLET, Ledger  # noqa: E402

RETURN = [(VAULT, 'ReservesWithdrawn', {'token': T0, 'amount': 1_200, 'stateNonce': 11}),
          (VAULT, 'ReservesWithdrawn', {'token': T1, 'amount': 3_000, 'stateNonce': 11})]


def answer(entries, *, sender=OPERATOR, gas=True, operators=None):
    book = Ledger()
    book.tx('return', entries, seconds_ago=300, sender=sender, gas=gas)
    rows = book.newest_first()
    body = fixtures.build_activity(WALLET, fixtures.NOW, 20, deployments=fixtures.deployments(), rows=rows,
                                   logs=book.logs, transactions=book.transactions, modes={}, tokens=fixtures.tokens,
                                   waiting_reports=fixtures.waiting_reports(),
                                   operators=fixtures.OPERATORS if operators is None else operators)
    item, = body['items']
    return item, rows[0]


class ReturnedTests(unittest.TestCase):
    def test_the_operators_return_is_its_own_kind(self):
        item, row = answer(RETURN)
        self.assertEqual(item['kind'], 'reserves_returned')
        self.assertEqual((item['vault'], item['returnedBy'], item['byOperator'], item['stateNonce']),
                         (VAULT, OPERATOR, True, '11'))
        self.assertEqual(item['reservesReturned'], [{'token': T0, 'amount': '1200'}, {'token': T1, 'amount': '3000'}])
        self.assertEqual(item['tx']['gas']['sender'], OPERATOR)
        self.assertEqual(item['id'], f"{CHAIN}:{row['block_number']}:{row['log_index']}")

    def test_anyone_else_may_return_them_and_is_no_operator(self):
        item, _ = answer(RETURN, sender=OTHER)
        self.assertEqual((item['kind'], item['returnedBy'], item['byOperator']), ('reserves_returned', OTHER, False))

    def test_operator_means_admitted_before_the_transaction(self):
        item, row = answer(RETURN)
        block, index = row['block_number'], row['log_index']  # the item's last log: 1
        cases = {'admitted later in the block': ([(block, index + 1, True)], False),
                 'admitted earlier in the block': ([(block, index - 1, True)], True),
                 'admitted then revoked': ([(block - 9, 0, True), (block - 5, 3, False)], False),
                 'revoked then admitted again': ([(block - 9, 0, True), (block - 5, 3, False), (block - 1, 0, True)],
                                                 True),
                 'revoked after': ([(block - 9, 0, True), (block + 1, 0, False)], True),
                 'another chain': ([], False)}
        for name, (changes, admitted) in cases.items():
            operators = {(CHAIN, OPERATOR): changes} if changes else {(8453, OPERATOR): [(1, 0, True)]}
            with self.subTest(case=name):
                self.assertIs(answer(RETURN, operators=operators)[0]['byOperator'], admitted)

    def test_the_owners_own_withdrawals_and_anything_else_stay_vault_events(self):
        cases = {'the owner sent it': dict(entries=RETURN, sender=WALLET),
                 'no transaction row': dict(entries=RETURN, gas=False),
                 'another event too': dict(entries=RETURN + [(VAULT, 'RootDisarmed', {'reason': 2, 'stateNonce': 11})]),
                 'two nonces': dict(entries=[RETURN[0], (VAULT, 'ReservesWithdrawn',
                                                         {'token': T1, 'amount': 3_000, 'stateNonce': 12})]),
                 'one token twice': dict(entries=[RETURN[0], RETURN[0]])}
        for name, case in cases.items():
            with self.subTest(case=name):
                item, _ = answer(**case)
                self.assertEqual(item['kind'], 'vault_event')
                self.assertEqual([event['event'] for event in item['events']][:2], ['ReservesWithdrawn'] * 2
                                 if len(case['entries']) > 1 else ['ReservesWithdrawn'])


if __name__ == '__main__':
    unittest.main()


class MandateWaitingTests(unittest.TestCase):
    """A mandate's waiting reason as the automation decided it, until its vault's exit module changes (6 Oct 2026, the
    app's Auto-exit item 10: after "Turn back on", exit_module_not_enabled held until the automation's next pass)."""

    def mandate(self, changed_block):
        rows = fixtures.mandates()
        rows[0] = dict(rows[0], exit_module_block=changed_block)
        at = fixtures.NOW - 40
        waiting = fixtures.waiting()
        waiting[(CHAIN, 'mandate', fixtures.MANDATE)] = fixtures.waiting_row('exit_module_not_enabled', at=at,
                                                                            since=at - 60)
        body = fixtures.portfolio(mandates=rows, waiting=waiting)
        return next(m for m in body['mandates'] if m['mandateHash'] == fixtures.MANDATE)

    def test_a_reason_decided_before_the_vaults_latest_module_change_is_not_shown(self):
        decided = 73_400_090  # the pass's block, waiting_row's
        self.assertIsNone(self.mandate(decided + 1)['waiting'])
        # A pass at the change's own block read the state after it; an older change, or none read, changes nothing.
        for changed in (decided, decided - 90, None):
            with self.subTest(changed=changed):
                self.assertEqual(self.mandate(changed)['waiting']['reason'], 'exit_module_not_enabled')



class VaultLinkTests(unittest.TestCase):
    """read-v6's `vault` of a position: the vault it belongs to now (v2_read_service.vault_link). The 2 Nov 2026 review
    found the index kept a position's first vault forever: the app's Setup takes any link as "automated", so a position
    that left its vault (Leave automation) was never offered again, and a position with a new vault named the old one."""
    ROOT = {'address': VAULT, 'role': 'root'}
    SUCCESSOR = {'address': VAULT, 'role': 'successor'}
    ON = ('ExitModuleSet', {'module': fixtures.MODULE, 'stateNonce': 3})
    OFF = ('ExitModuleSet', {'module': fixtures.ZERO, 'stateNonce': 4})

    @staticmethod
    def disarmed(reason):
        return ('RootDisarmed', {'reason': reason, 'stateNonce': 2})

    def link(self, events=(), *, successor=False, status='live', owner=None):
        if successor:  # held by the vault, as an active successor is
            owner = owner or VAULT
            row = fixtures.position_row(8, 'vault_successor', VAULT, status=status, owner=owner, link_events=events,
                                        state=fixtures.position_state(owner, subscriber=None, approved=None))
        else:
            row = fixtures.position_row(7, 'vault_root', VAULT, status=status, owner=owner or WALLET,
                                        link_events=events)
        position, = fixtures.portfolio(positions=[row])['positions']
        return position['vault']

    def test_a_root_the_vault_let_go_has_no_vault(self):
        exited = ('ExitExecuted', {'module': fixtures.MODULE, 'tokenId': 7, 'amount0': 5, 'amount1': 6,
                                   'stateNonce': 3})
        cases = {'held since its arming': ([], self.ROOT),
                 'left by its owner (exitAll)': ([self.OFF, self.disarmed(7)], None),
                 'closed by the auto-exit': ([self.disarmed(6), exited], None),
                 'closed by the auto-exit after a disarm (no second RootDisarmed)': ([self.disarmed(2), exited], None),
                 'burned': ([self.disarmed(3)], None),
                 # The owner rearms these in the same vault: the position is still the vault's.
                 'unsubscribed or transferred': ([self.disarmed(1)], self.ROOT),
                 'changed outside Domino': ([self.disarmed(2)], self.ROOT),
                 'custody lost': ([self.disarmed(4)], self.ROOT),
                 'v3 checkpoint mismatch': ([self.disarmed(5)], self.ROOT),
                 # An exit needs the approval alone: Auto-exit turned back on after Leave protects the root again.
                 'Auto-exit turned back on after Leave': ([self.disarmed(7), self.ON], self.ROOT),
                 'then turned off again, or a second Leave': ([self.disarmed(7), self.ON, self.OFF], None),
                 'Auto-exit on and off while armed': ([self.ON, self.OFF], self.ROOT)}
        for name, (events, expected) in cases.items():
            with self.subTest(case=name):
                self.assertEqual(self.link(events), expected)

    def test_a_successor_withdrawn_to_the_wallet_has_no_vault(self):
        self.assertEqual(self.link(successor=True), self.SUCCESSOR)
        # The root's own end leaves an active successor in the vault (an auto-exit of the root withdraws no child).
        self.assertEqual(self.link([self.disarmed(6)], successor=True), self.SUCCESSOR)
        withdrawn = [('ChildWithdrawn', {'tokenId': 8, 'stateNonce': 5})]
        self.assertIsNone(self.link(withdrawn, successor=True, owner=WALLET))

    def test_a_position_another_wallet_holds_is_no_vaults(self):
        # A vault acts on its root only while its owner holds it; the old owner's vault is not the new holder's.
        self.assertIsNone(self.link(owner=OTHER))
        self.assertIsNone(self.link(successor=True, owner=OTHER))
        # Held by its vault's owner, by the vault itself, or not read live: the events decide.
        self.assertEqual(self.link(owner=WALLET), self.ROOT)
        self.assertEqual(self.link(successor=True, owner=VAULT), self.SUCCESSOR)
        for status in ('unavailable', None):
            with self.subTest(status=status):
                self.assertEqual(self.link(status=status), self.ROOT)
