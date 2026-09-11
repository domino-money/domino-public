"""Reviewed token identities and bounded checks, never token discovery or signing.

Profiles are trusted review records, not claims accepted from a browser. A
reviewId binds their complete content. Matching block-end identities cannot
exclude an issuer's transient in-block upgrade or a later freeze/upgrade.
"""
from copy import deepcopy
import hashlib
import json
import re

from eth_abi import encode
from eth_hash.auto import keccak

from deposit_models import DepositError
from discovery import ZERO, POOL_MANAGER, POSITION_MANAGER, address, bytes32, DataError
from read_deadline import check_read_deadline

POLICY = 'direct_existing_pool_v2'
PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
IMPLEMENTATION_SLOT = '0x' + (int.from_bytes(keccak(b'eip1967.proxy.implementation'), 'big') - 1).to_bytes(32, 'big').hex()
ADMIN_SLOT = '0x' + (int.from_bytes(keccak(b'eip1967.proxy.admin'), 'big') - 1).to_bytes(32, 'big').hex()
BEACON_SLOT = '0x' + (int.from_bytes(keccak(b'eip1967.proxy.beacon'), 'big') - 1).to_bytes(32, 'big').hex()
ZERO_WORD = '0x' + '00' * 32
ACCOUNTS = frozenset(('owner', 'permit2', 'pool_manager', 'position_manager'))
PROFILE_FIELDS = {'reviewId', 'address', 'codeHash', 'reviewReference', 'standardTransfer',
    'nonRebasing', 'approvalReturn', 'kind', 'implementation', 'admin', 'dependencies',
    'identityStorage', 'identityCalls', 'stateStorage', 'accountStorage'}

# Leave room for protocol/NFT/finality reads in the shared bounded clients.
MAX_PAIR_IDENTITY_READS = 36
MAX_PAIR_OPERATIONAL_READS = 48


def check_cost(profile):
    identity = (1 + len(profile['dependencies']) + len(profile['identityStorage'])
        + len(profile['identityCalls']) + (4 if profile['implementation'] else 0))
    operative = identity + len(profile['stateStorage']) + sum(len(r['accounts']) for r in profile['accountStorage'])
    return identity, operative


def validate_check_budget(profiles):
    costs = [check_cost(p) for p in profiles]
    if (sum(c[0] for c in costs) > MAX_PAIR_IDENTITY_READS
            or sum(c[1] for c in costs) > MAX_PAIR_OPERATIONAL_READS):
        raise DepositError('deposit_admission_required')


def digest(value, field):
    return hashlib.sha256(json.dumps({k: v for k, v in value.items() if k != field},
        sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _address(value, *, zero=False):
    if address(value) != value or not zero and value == ZERO:
        raise ValueError()
    return value


def _word(value):
    if bytes32(value) != value:
        raise ValueError()
    return value


def _rows(value, maximum):
    if type(value) is not list or len(value) > maximum:
        raise ValueError()
    return value


def _code(row):
    if type(row) is not dict or set(row) != {'address', 'codeHash'}:
        raise ValueError()
    _address(row['address']); _word(row['codeHash'])


def validate_profile(profile):
    try:
        if type(profile) is not dict or set(profile) != PROFILE_FIELDS:
            raise ValueError()
        p = deepcopy(profile)
        _address(p['address']); _word(p['codeHash']); _address(p['admin'], zero=True)
        if (p['standardTransfer'] is not True or p['nonRebasing'] is not True
                or p['approvalReturn'] not in ('bool', 'empty')
                or p['kind'] not in ('immutable', 'erc1967_transparent', 'erc1967_uups')
                or not isinstance(p['reviewReference'], str) or not 1 <= len(p['reviewReference']) <= 256
                or any(not 32 <= ord(c) <= 126 for c in p['reviewReference'])):
            raise ValueError()
        if p['kind'] == 'immutable':
            if p['implementation'] is not None or p['admin'] != ZERO:
                raise ValueError()
        else:
            _code(p['implementation'])
            if p['implementation']['address'] == p['address']:
                raise ValueError()
            if (p['kind'] == 'erc1967_transparent') != (p['admin'] != ZERO):
                raise ValueError()
        targets = {p['address']}
        if p['implementation']:
            targets.add(p['implementation']['address'])
        for row in _rows(p['dependencies'], 8):
            _code(row)
            if row['address'] in targets:
                raise ValueError()
            targets.add(row['address'])
        if p['admin'] != ZERO and p['admin'] not in targets:
            raise ValueError()  # An admin address alone does not pin its code.
        for row in _rows(p['identityStorage'], 16):
            if type(row) is not dict or set(row) != {'address', 'slot', 'value'} or row['address'] not in targets:
                raise ValueError()
            _word(row['slot']); _word(row['value'])
        for row in _rows(p['identityCalls'], 8):
            if (type(row) is not dict or set(row) != {'address', 'data', 'result'}
                    or row['address'] not in targets
                    or not isinstance(row['data'], str) or not re.fullmatch(r'0x(?:[0-9a-f]{2}){4,132}', row['data'])
                    or not isinstance(row['result'], str) or not re.fullmatch(r'0x(?:[0-9a-f]{2}){1,256}', row['result'])):
                raise ValueError()
        for field in ('stateStorage', 'accountStorage'):
            for row in _rows(p[field], 8):
                expected = {'slot', 'mask', 'value'} | ({'accounts'} if field == 'accountStorage' else set())
                if type(row) is not dict or set(row) != expected:
                    raise ValueError()
                for key in ('slot', 'mask', 'value'): _word(row[key])
                mask, value = int(row['mask'], 16), int(row['value'], 16)
                if mask == 0 or value & ~mask:
                    raise ValueError()
                if field == 'accountStorage' and (type(row['accounts']) is not list
                        or not row['accounts'] or len(row['accounts']) > 4
                        or any(a not in ACCOUNTS for a in row['accounts'])
                        or len(set(row['accounts'])) != len(row['accounts'])):
                    raise ValueError()
        if (not isinstance(p['reviewId'], str) or not re.fullmatch('[0-9a-f]{64}', p['reviewId'])
                or digest(p, 'reviewId') != p['reviewId']):
            raise ValueError()
        validate_check_budget([p])
        return p
    except Exception:
        raise DepositError('deposit_admission_required') from None


def validate_manifest(manifest, *, now, deployments):
    try:
        m = deepcopy(manifest)
        required = {'schemaVersion', 'policyVersion', 'manifestId', 'reviewedAt',
                    'expiresAt', 'reviewReference', 'nativeEnabled', 'deployments', 'tokens'}
        if (type(m) is not dict or set(m) not in (required, required | {'reviewArchive'})
                or type(m['schemaVersion']) is not int or m['schemaVersion'] != 2 or m['policyVersion'] != POLICY
                or type(m['nativeEnabled']) is not bool or type(m['reviewedAt']) is not int
                or type(m['expiresAt']) is not int or not 0 <= m['reviewedAt'] <= now < m['expiresAt'] <= m['reviewedAt'] + 30*86400
                or not isinstance(m['reviewReference'], str) or not 1 <= len(m['reviewReference']) <= 256
                or any(not 32 <= ord(c) <= 126 for c in m['reviewReference'])
                or type(m['deployments']) is not dict or set(m['deployments']) != set(deployments)):
            raise ValueError()
        for value in m['deployments'].values(): _word(value)
        m['tokens'] = [validate_profile(p) for p in _rows(m['tokens'], 32)]
        if len({p['address'] for p in m['tokens']}) != len(m['tokens']):
            raise ValueError()
        archive = [validate_profile(p) for p in _rows(m.get('reviewArchive', []), 32)]
        ids = [p['reviewId'] for p in [*m['tokens'], *archive]]
        if len(set(ids)) != len(ids):
            raise ValueError()
        if not isinstance(m['manifestId'], str) or digest(m, 'manifestId') != m['manifestId']:
            raise ValueError()
        return m
    except Exception:
        raise DepositError('deposit_admission_required') from None


def _code_hash(raw):
    if not isinstance(raw, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', raw) or len(raw) > 49154:
        raise DataError('token_check_invalid_response')
    return '0x' + keccak(bytes.fromhex(raw[2:])).hex()


def check_profile(request, profile, *, owner, block, operational=True):
    """Read one reviewed identity at one canonical block, with no retries/cache."""
    pinned = {'blockHash': block['hash'], 'requireCanonical': True}
    def read(method, params):
        check_read_deadline()
        result = request(method, params)
        check_read_deadline()
        return result
    def storage(target, slot):
        return _word(read('eth_getStorageAt', [target, slot, pinned]))
    def equal(actual, expected):
        if actual != expected:
            raise DepositError('deposit_token_changed')
    try:
        p = profile
        for row in [p, *([p['implementation']] if p['implementation'] else []), *p['dependencies']]:
            equal(_code_hash(read('eth_getCode', [row['address'], pinned])), row['codeHash'])
        if p['implementation']:
            equal(storage(p['address'], IMPLEMENTATION_SLOT), '0x' + p['implementation']['address'][2:].rjust(64, '0'))
            equal(storage(p['address'], ADMIN_SLOT), '0x' + p['admin'][2:].rjust(64, '0'))
            equal(storage(p['address'], BEACON_SLOT), ZERO_WORD)
        for row in p['identityStorage']:
            equal(storage(row['address'], row['slot']), row['value'])
        for row in p['identityCalls']:
            equal(read('eth_call', [{'to': row['address'], 'data': row['data'], 'gas': hex(500000)}, pinned]), row['result'])
        if operational:
            contexts = {'owner': owner, 'permit2': PERMIT2, 'pool_manager': POOL_MANAGER, 'position_manager': POSITION_MANAGER}
            for row in p['stateStorage']:
                if int(storage(p['address'], row['slot']), 16) & int(row['mask'], 16) != int(row['value'], 16):
                    raise DepositError('deposit_token_restricted')
            for row in p['accountStorage']:
                for label in row['accounts']:
                    slot = '0x' + keccak(encode(['address', 'uint256'], [contexts[label], int(row['slot'], 16)])).hex()
                    if int(storage(p['address'], slot), 16) & int(row['mask'], 16) != int(row['value'], 16):
                        raise DepositError('deposit_token_restricted')
    except DepositError:
        raise
    except Exception:
        check_read_deadline()
        raise DepositError('deposit_token_check_unavailable') from None


class TokenAdmission:
    def __init__(self, profiles):
        # Detached content-addressed review archive. A new manifest cannot turn
        # an old unknown review into a silently approved new implementation.
        values = [validate_profile(p) for p in profiles]
        self._profiles = {p['reviewId']: p for p in values}

    def check(self, request, profiles, *, owner, block):
        for profile in profiles:
            check_profile(request, profile, owner=owner, block=block)

    def receipt(self, *, request, currency, admission, before, block):
        result = {'status': 'unavailable', 'reviewId': None, 'upgradeable': None}
        try:
            if admission['policyVersion'] != POLICY:
                return {**result, 'status': 'legacy_unqualified'}
            refs = admission['tokenReviews']
            matches = [ref for ref in refs if ref['address'] == currency]
            if len(matches) != 1:
                return result
            result['reviewId'] = matches[0]['reviewId']
            p = self._profiles.get(result['reviewId'])
            if p is None or p['address'] != currency:
                return result
            result['upgradeable'] = p['implementation'] is not None
            for snapshot in (before, block):
                check_profile(request, p, owner=ZERO, block=snapshot, operational=False)
            return {**result, 'status': 'matched'}
        except DepositError as error:
            return {**result, 'status': 'changed' if error.code == 'deposit_token_changed' else 'unavailable'}
        except Exception:
            check_read_deadline()
            return result
