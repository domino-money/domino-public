"""How one transaction's V2 events become the receipts each wallet sees.

The event sequences are the contracts' own (docs/v2/F2_ZAP.md "The receipt",
F3_VAULT.md "Order of checks and steps", F4_AUTO_EXIT.md and the vault's
executeExit): every event lands in exactly one item, and an event that moves
fees or positions outside an action, an execution or an exit is refused.
"""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import DataError  # noqa: E402
from v2_activity import Context, derive_transaction, positions_seen  # noqa: E402
from v2_events import catalog, decode_log  # noqa: E402
from v2_index_fixtures import block_hash, encode_log, tx_hash  # noqa: E402

ZAP, VAULT, FACTORY, MODULE = '0x' + 'a1' * 20, '0x' + 'a2' * 20, '0x' + 'a3' * 20, '0x' + 'a4' * 20
OWNER, RECIPIENT, OPERATOR = '0x' + 'b1' * 20, '0x' + 'b2' * 20, '0x' + 'b3' * 20
T0, T1, USDG = '0x' + '11' * 20, '0x' + '22' * 20, '0x' + '33' * 20
ZERO = '0x' + '00' * 20
POOL = {'dex': 4, 'currency0': T0, 'currency1': T1, 'fee': 3000, 'tickSpacing': 60, 'hooks': ZERO}
INTENT, PLAN, MANDATE = '0x' + 'c1' * 32, '0x' + 'c2' * 32, '0x' + 'c3' * 32
KINDS = {ZAP: 'zap', VAULT: 'vault', FACTORY: 'vault_factory', MODULE: 'auto_exit'}
POLICY = {'mode': 1, 'triggerDistanceBps': 100, 'maxOverlapBps': 100, 'minimumIntervalSeconds': 60,
          'maxPositions': 1}
LIMITS = {'maxSlippageBps': 100, 'maxPriceImpactBps': 100, 'maxObservationAgeSeconds': 300, 'upsideBps': 500}


class Tx:
    """Logs of one transaction, in emission order."""
    def __init__(self, label='t'):
        self.label, self.logs = label, []

    def add(self, address, name, **args):
        raw = encode_log(KINDS[address], name, args, address=address, block_number=50, block_hash=block_hash(50),
                         tx_hash=tx_hash(self.label), log_index=len(self.logs))
        self.logs.append(decode_log(catalog(), raw, KINDS.get))
        return self


def ctx(mandates=None):
    return Context(vault=lambda a: (OWNER, 4, 7) if a == VAULT else None,
                   mandate=lambda h: (mandates or {}).get(h), auto_exit=MODULE, zap_dex={ZAP: 4})


def s1(tx, *, intent=INTENT, fee=True, token_id=9):
    tx.add(ZAP, 'InputPulled', intentHash=intent, owner=OWNER, token=USDG, amount=1000)
    tx.add(ZAP, 'SwapLegExecuted', kind=3, tokenIn=USDG, tokenOut=T1, venue='0x' + '44' * 20, amountIn=500,
           amountOut=490)
    if fee:
        tx.add(ZAP, 'FeeCharged', kind=1, token=USDG, payer=OWNER, amount=3, ref=intent)
        tx.add(ZAP, 'FeeDeferred', token=USDG, amount=3, totalOwed=3)
    tx.add(ZAP, 'PositionLiquidityChanged', intentHash=intent, owner=OWNER, tokenId=token_id, pool=POOL,
           liquidityDelta=100, amount0=-400, amount1=-490)
    tx.add(ZAP, 'Refunded', recipient=RECIPIENT, token=USDG, amount=97)
    tx.add(ZAP, 'PositionActionExecuted', action=1, recipient=RECIPIENT, tokenId=token_id, previousTokenId=0,
           liquidity=100, intentHash=intent)
    return tx


class DeriveTests(unittest.TestCase):
    def test_an_s1_action_is_one_receipt_for_its_owner_and_recipient(self):
        tx = s1(Tx()).add(ZAP, 'NoncesInvalidated', owner=OWNER, word=0, mask=1)
        tx.add(ZAP, 'OwedFeesFlushed', token=USDG, recipient='0x' + '99' * 20, amount=3)
        items = derive_transaction(tx.logs, ctx())
        self.assertEqual([i.kind for i in items], ['s1_action', 'zap_event'])
        action = items[0]
        self.assertEqual((action.wallets, action.ref, action.address), ((OWNER, RECIPIENT), INTENT, ZAP))
        self.assertEqual([log.log_index for log in action.logs], list(range(7)))
        self.assertEqual(items[1].wallets, (OWNER,))

    def test_two_actions_in_one_transaction_split_at_each_summary(self):
        tx = s1(s1(Tx()), intent='0x' + 'd1' * 32, fee=False, token_id=10)
        first, second = derive_transaction(tx.logs, ctx())
        self.assertEqual((first.ref, len(first.logs), second.ref, len(second.logs)), (INTENT, 7, '0x' + 'd1' * 32, 5))

    def test_receipt_lines_after_the_last_summary_are_refused(self):
        tx = s1(Tx()).add(ZAP, 'Refunded', recipient=RECIPIENT, token=USDG, amount=1)
        with self.assertRaisesRegex(DataError, 'v2_receipt_unanchored'):
            derive_transaction(tx.logs, ctx())

    def test_the_creation_takes_the_vault_s_initialization(self):
        tx = (Tx().add(VAULT, 'Initialized', owner=OWNER, dex=4, rootTokenId=7, mode=1)
              .add(VAULT, 'PolicyChanged', policy=POLICY, stateNonce=1)
              .add(VAULT, 'LimitsChanged', limits=LIMITS, stateNonce=1).add(VAULT, 'RootRearmed', stateNonce=1)
              .add(FACTORY, 'VaultCreated', owner=OWNER, vault=VAULT, rootTokenId=7, dex=4, ownerNonce=0))
        item, = derive_transaction(tx.logs, ctx())
        self.assertEqual((item.kind, item.wallets, item.vault, len(item.logs)), ('vault_created', (OWNER,), VAULT, 5))

    def test_an_execution_ends_at_executed(self):
        tx = (Tx().add(VAULT, 'FeesCollected', tokenId=7, amount0=10, amount1=20)
              .add(VAULT, 'SwapLegExecuted', kind=3, tokenIn=T0, tokenOut=T1, venue='0x' + '44' * 20, amountIn=5,
                   amountOut=4)
              .add(VAULT, 'Swapped', source=7, zeroForOne=True, amountIn=5, amountOut=4)
              .add(VAULT, 'FeeCharged', kind=2, token=T0, payer=OWNER, amount=1, ref=PLAN)
              .add(VAULT, 'FeeCharged', kind=2, token=T1, payer=OWNER, amount=1, ref=PLAN)
              .add(VAULT, 'Compounded', tokenId=7, liquidityAdded=50, fees0=5, fees1=24, serviceFee0=1,
                   serviceFee1=1, stateNonce=5)
              .add(VAULT, 'Executed', planHash=PLAN, action=1, stateNonce=5))
        item, = derive_transaction(tx.logs, ctx())
        self.assertEqual((item.kind, item.wallets, item.ref, len(item.logs)), ('vault_execution', (OWNER,), PLAN, 7))

    def test_a_failed_custody_check_and_exit_all_are_vault_events(self):
        custody, = derive_transaction(Tx().add(VAULT, 'RootDisarmed', reason=4, stateNonce=6).logs, ctx())
        self.assertEqual((custody.kind, custody.wallets), ('vault_event', (OWNER,)))
        # exitAll also disables the exit module (3 Oct 2026): one more event, the same item.
        exit_all = (Tx().add(VAULT, 'ChildWithdrawn', tokenId=8, stateNonce=7)
                    .add(VAULT, 'ReservesWithdrawn', token=T0, amount=3, stateNonce=7)
                    .add(VAULT, 'ExitModuleSet', module=ZERO, stateNonce=7)
                    .add(VAULT, 'RootDisarmed', reason=7, stateNonce=7))
        item, = derive_transaction(exit_all.logs, ctx())
        self.assertEqual((item.kind, item.wallets, len(item.logs)), ('vault_event', (OWNER,), 4))

    def test_fee_or_position_events_outside_an_execution_are_refused(self):
        for name, args in (('Compounded', dict(tokenId=7, liquidityAdded=1, fees0=1, fees1=1, serviceFee0=0,
                                               serviceFee1=0, stateNonce=2)),
                           ('FeeCharged', dict(kind=2, token=T0, payer=OWNER, amount=1, ref=PLAN)),
                           ('FeesCollected', dict(tokenId=7, amount0=1, amount1=1))):
            with self.subTest(event=name), self.assertRaisesRegex(DataError, 'v2_receipt_unanchored'):
                derive_transaction(Tx().add(VAULT, name, **args).logs, ctx())

    def test_an_auto_exit_takes_the_vault_s_exit_events(self):
        tx = (Tx().add(VAULT, 'ReservesWithdrawn', token=T0, amount=2, stateNonce=9)
              .add(VAULT, 'RootDisarmed', reason=6, stateNonce=9)
              .add(VAULT, 'ExitExecuted', module=MODULE, tokenId=7, amount0=100, amount1=200, stateNonce=9)
              .add(MODULE, 'FeeCharged', kind=3, token=T1, payer=OWNER, amount=1, ref=MANDATE)
              .add(MODULE, 'SwapLegExecuted', kind=3, tokenIn=T0, tokenOut=T1, venue='0x' + '44' * 20, amountIn=100,
                   amountOut=95)
              .add(MODULE, 'DeliveryDeferred', owner=OWNER, token=T1, amount=294, totalUnclaimed=294)
              .add(MODULE, 'MandateExecuted', mandateHash=MANDATE, anchorSqrtPriceX96=2**96, recipient=OWNER,
                   amount0=0, amount1=294))
        item, = derive_transaction(tx.logs, ctx())
        self.assertEqual((item.kind, item.wallets, item.vault, item.ref, len(item.logs)),
                         ('auto_exit', (OWNER,), VAULT, MANDATE, 7))

    def test_an_exit_without_the_vault_s_exit_is_refused(self):
        tx = Tx().add(MODULE, 'MandateExecuted', mandateHash=MANDATE, anchorSqrtPriceX96=2**96, recipient=OWNER,
                      amount0=0, amount1=0)
        with self.assertRaisesRegex(DataError, 'v2_receipt_unanchored'):
            derive_transaction(tx.logs, ctx())

    def test_mandate_events_name_the_owner(self):
        registered = Tx().add(MODULE, 'MandateRegistered', mandateHash=MANDATE, owner=OWNER, vault=VAULT, tokenId=7,
                              validUntil=99)
        item, = derive_transaction(registered.logs, ctx())
        self.assertEqual((item.kind, item.wallets, item.vault), ('auto_exit_event', (OWNER,), VAULT))
        revoked = Tx().add(MODULE, 'MandateRevoked', mandateHash=MANDATE)
        item, = derive_transaction(revoked.logs, ctx({MANDATE: (OWNER, VAULT)}))
        self.assertEqual((item.wallets, item.vault), ((OWNER,), VAULT))
        with self.assertRaisesRegex(DataError, 'v2_mandate_unknown'):
            derive_transaction(revoked.logs, ctx())

    def test_a_vault_the_index_does_not_know_is_refused(self):
        with self.assertRaisesRegex(DataError, 'v2_vault_unknown'):
            derive_transaction(Tx().add(VAULT, 'RootRearmed', stateNonce=2).logs,
                               Context(vault=lambda a: None, mandate=lambda h: None, auto_exit=MODULE, zap_dex={}))

    def test_positions_named(self):
        tx = (Tx().add(FACTORY, 'VaultCreated', owner=OWNER, vault=VAULT, rootTokenId=7, dex=4, ownerNonce=0)
              .add(VAULT, 'SuccessorCreated', parentTokenId=7, tokenId=8, stateNonce=3)
              .add(VAULT, 'RootDisarmed', reason=2, stateNonce=4))
        s1(tx)
        seen, touched = positions_seen(tx.logs, ctx())
        # The created position is the recipient's, though its mint step names the payer first.
        self.assertEqual([(p.token_id, p.source, p.vault, p.wallet) for p in seen],
                         [(7, 'vault_root', VAULT, OWNER), (8, 'vault_successor', VAULT, OWNER),
                          (9, 's1', None, RECIPIENT)])
        self.assertEqual({(dex, token) for dex, token, _ in touched}, {(4, 7), (4, 8), (4, 9)})


if __name__ == '__main__':
    unittest.main()
