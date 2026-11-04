"""Test wallets from the public test mnemonic, derived the same way every time: tests only, never production.

Launch round P3 (4 Nov 2026), item 7: a test may use any of the mnemonic's first 100 accounts (m/44'/60'/0'/0/i,
the path Anvil and Hardhat derive), not only the ten Anvil funds by default. Every account handed out here is one
production refuses as a role (v2_manifest.PUBLIC_TEST_ACCOUNTS, api-contracts/v2/public-test-accounts.json): an index
the list does not cover is refused rather than derived, so no test can introduce a key production would admit.
"""
from functools import lru_cache
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_account import Account
from eth_account.hdaccount import key_from_seed, seed_from_mnemonic

from v2_manifest import PUBLIC_TEST_ACCOUNTS, PUBLIC_TEST_ACCOUNTS_FILE

DOCUMENT = json.loads(PUBLIC_TEST_ACCOUNTS_FILE.read_text())
MNEMONIC = DOCUMENT['mnemonic']
ADDRESSES = tuple(DOCUMENT['addresses'])


@lru_cache(maxsize=1)
def _seed():
    return seed_from_mnemonic(MNEMONIC, '')


@lru_cache(maxsize=None)
def public_test_account(index):
    """The mnemonic's account `index` (0 to 99): an eth_account LocalAccount, its key derived here, never stored."""
    if type(index) is not int or not 0 <= index < len(ADDRESSES):
        raise ValueError('public_test_account_index')
    account = Account.from_key(key_from_seed(_seed(), DOCUMENT['accountPath'].format(index=index)))
    if account.address.lower() not in PUBLIC_TEST_ACCOUNTS:
        raise ValueError('public_test_account_not_refused_by_production')
    return account


def public_test_accounts(count):
    """The first `count` accounts, index 0 first."""
    return [public_test_account(index) for index in range(count)]
