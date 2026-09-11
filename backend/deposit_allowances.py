"""Fresh owner-bound allowance observations; no transaction preparation or signer."""
import math
import time

from deposit_models import AllowanceReport, DepositSelection
from deposit_receipt import ReceiptReconciler, PERMIT2
from discovery import CHAIN_ID, POSITION_MANAGER, ZERO, DataError, address, quantity
from read_deadline import check_read_deadline, read_deadline


class AllowanceReader:
    def __init__(self, rpc, *, clock=time.time):
        self.reader, self.clock = ReceiptReconciler(rpc), clock

    def read(self, owner, selection):
        owner = address(owner)
        if owner == ZERO:
            raise DataError('invalid_allowance_owner')
        selected = DepositSelection.model_validate(selection)
        r = self.reader
        with read_deadline(10):
            if quantity(r._rpc('eth_chainId', [])) != CHAIN_ID:
                raise DataError('allowance_chain_mismatch')
            block, _ = r._get_block('latest')
            now = self.clock()
            if (type(now) not in (int, float) or not math.isfinite(now)
                    or not now-120 <= block['timestamp'] <= now+15):
                raise DataError('allowance_snapshot_stale')
            rows = []
            for currency in (selected.poolKey.currency0, selected.poolKey.currency1):
                if currency == ZERO:
                    continue
                row = {'currency': currency, 'erc20Spender': PERMIT2, 'permit2Spender': POSITION_MANAGER,
                    'erc20Status': 'unavailable', 'erc20AllowanceRaw': None,
                    'permit2Status': 'unavailable', 'permit2AllowanceRaw': None, 'permit2Expiration': None,
                    'revocationGuidance': 'wallet_erc20_approve_zero_and_permit2_approve_zero'}
                try:
                    amount, = r._call(currency, 'allowance(address,address)', ['address','address'],
                                      [owner, PERMIT2], ['uint256'], block)
                    row.update(erc20Status='observed', erc20AllowanceRaw=str(amount))
                except DataError:
                    check_read_deadline()
                try:
                    amount, expiration, _ = r._call(PERMIT2, 'allowance(address,address,address)',
                        ['address','address','address'], [owner, currency, POSITION_MANAGER],
                        ['uint160','uint48','uint48'], block)
                    row.update(permit2AllowanceRaw=str(amount), permit2Expiration=expiration,
                        permit2Status='zero' if amount == 0 else 'expired' if expiration < block['timestamp'] else 'active')
                except DataError:
                    check_read_deadline()
                rows.append(row)
            if not r._canonical(block) or quantity(r._rpc('eth_chainId', [])) != CHAIN_ID:
                raise DataError('allowance_snapshot_changed')
            return AllowanceReport.model_validate({'snapshot': block,
                'basis': 'pinned_contract_reads_not_token_admission', 'observations': rows}).model_dump()
