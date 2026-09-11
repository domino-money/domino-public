"""Bounded local operator access to wallet admission; never an HTTP endpoint."""
import math

import psycopg
from psycopg.rows import dict_row
from eth_utils import is_checksum_address

from discovery import DataError, address
from read_deadline import check_read_deadline, read_deadline, read_timeout
from session_models import CHAIN_ID, utc
from session_store import LOCK_ID, _DeadlineConnection

OPERATOR_ROLE = 'domino_wallet_access_operator'
MAX_WALLETS = 10000
MAX_AUDIT_EVENTS = 100000
GRANT_AUDIT_LIMIT = MAX_AUDIT_EVENTS - MAX_WALLETS
MAX_LIST = 100
ERRORS = frozenset(('wallet_access_invalid_request', 'wallet_access_capacity',
                   'wallet_access_not_found', 'wallet_access_unavailable'))


class WalletAccessError(Exception):
    def __init__(self, code):
        self.code = code if code in ERRORS else 'wallet_access_unavailable'
        super().__init__(self.code)


def canonical_wallet(value, *, chain_id=CHAIN_ID):
    try:
        if type(chain_id) is not int or chain_id != CHAIN_ID:
            raise ValueError()
        normalized = address(value)
        if normalized == '0x'+'0'*40 or value != normalized and not is_checksum_address(value):
            raise ValueError()
        return normalized
    except Exception:
        raise WalletAccessError('wallet_access_invalid_request') from None


class WalletAccessAdmin:
    def __init__(self, settings, *, connect=psycopg.connect):
        if type(settings) is not dict or set(settings) != {'host','port','dbname'}:
            raise WalletAccessError('wallet_access_invalid_request')
        self.settings, self.connect = dict(settings), connect

    def _transaction(self, operation, *, readonly=False):
        try:
            with read_deadline(5):
                millis=max(1,min(1000,int(read_timeout(1)*1000)))
                with self.connect(**self.settings,user=OPERATOR_ROLE,
                        connect_timeout=max(1,math.ceil(read_timeout(2))),row_factory=dict_row,
                        options=f'-c statement_timeout={millis} -c lock_timeout={min(millis,250)} '
                            '-c idle_in_transaction_session_timeout=1000 -c search_path=domino_wallet_access -c TimeZone=UTC') as raw:
                    conn=_DeadlineConnection(raw)
                    if readonly:conn.execute('SET TRANSACTION READ ONLY')
                    conn.execute('SELECT pg_advisory_xact_lock(%s)',(LOCK_ID,))
                    result=operation(conn)
                    check_read_deadline()
                check_read_deadline()
                return result
        except psycopg.errors.RaiseException as error:
            code=error.diag.message_primary
            raise WalletAccessError(code) from None
        except (psycopg.Error,DataError):
            raise WalletAccessError('wallet_access_unavailable') from None
        except WalletAccessError:
            raise
        except Exception:
            raise WalletAccessError('wallet_access_unavailable') from None

    @staticmethod
    def _row(row, *, changed=False):
        value={'chainId':row['chain_id'],'address':row['address'],'allowed':row['allowed'],
               'generation':row['generation'],'updatedAt':utc(row['updated_at'])}
        if changed:value['changed']=row['changed']
        return value

    def _set(self, value, allowed, chain_id):
        normalized=canonical_wallet(value,chain_id=chain_id)
        return self._transaction(lambda conn:self._row(conn.execute(
            'SELECT * FROM domino_wallet_access.set_access(%s,%s)',(normalized,allowed)).fetchone(),changed=True))

    def grant(self, address, *, chain_id=CHAIN_ID):
        return self._set(address,True,chain_id)

    def revoke(self, address, *, chain_id=CHAIN_ID):
        return self._set(address,False,chain_id)

    def list(self, *, limit=20, after=None):
        if type(limit) is not int or not 1<=limit<=MAX_LIST:
            raise WalletAccessError('wallet_access_invalid_request')
        after=canonical_wallet(after) if after is not None else None
        def operation(conn):
            rows=conn.execute('SELECT * FROM domino_wallet_access.grants WHERE chain_id=4663 '
                'AND (%s::text IS NULL OR address>%s) ORDER BY address LIMIT %s',(after,after,limit+1)).fetchall()
            more=len(rows)>limit;rows=rows[:limit]
            return {'wallets':[self._row(row) for row in rows],'hasMore':more,
                    'nextAfter':rows[-1]['address'] if more else None}
        return self._transaction(operation,readonly=True)
