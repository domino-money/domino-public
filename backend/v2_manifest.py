"""The V2 deployment manifest of one chain, as the automation consumes it.

Issue #301's tooling (PR #302: scripts/v2/deploy.mjs, documented in
docs/v2/DEPLOYMENT.md) writes one manifest per chain at
docs/deployments/v2-<slug>-<chainId>-<date>/deployment.json, and its local mode
(`scripts/v2/deploy-local.mjs`) the same format for a disposable Anvil. The
structural schema is scripts/v2/deploy-manifest.schema.json and the semantic
validator `validateManifest` in scripts/v2/deploy-schema.mjs. `checked_manifest`
is both in Python, rule for rule:

- exact keys at every level; `schemaVersion` 1, `kind` domino-v2-deployment,
  `status` prepared or verified, `environment` public-chain-preparation,
  fork-rehearsal or local-test (any chain id only for local-test);
- the 13 contract names (F0's eleven components and the two vault executors)
  and the fixed policies;
- six roles, none a placeholder (below 2^16 or one digit repeated; #302's
  `0x0…dead`, `beef` and `cafe` are below 2^16), operator != publisher, none a
  component or CreateX;
- every address is the one CreateX's deployCreate3 gives F0's salt for the
  deployer (`deployer ‖ 0x00 ‖ bytes11(keccak256("domino.v2.<component>"))`,
  guarded as keccak256(abi.encode(deployer, salt))), each executor is its
  implementation's first CREATE, and the salts recorded are those;
- the eleven dependencies, a runtime code hash for every contract and
  dependency, two or more charge currencies, the build's fixed compiler profile
  and its source-tree hash;
- a verified manifest has one distinct receipt per deployed component and an
  anchored verification record; a prepared one has neither.

`checked_deployment` binds the manifest to the chain profile the service
serves (the chain id and the dependencies at the profile's addresses; outside
local tests also the chain's name and native symbol, the dependencies' verified
code hashes and the charge currencies, exactly as deploy.mjs derives them) and
applies the backend's admission (DEPLOYMENT.md: "Backend production admission
must additionally reject local-test and fork-rehearsal, unqualified source
candidates, provisional verification and stale/changed on-chain state"):
`production` admits only a verified public-chain manifest built from committed
sources (`workingTreeSourceChanges` false) and verified at the `finalized` tag.
`fork-rehearsal` and `local-test` exist for rehearsals and tests and are never
reachable from the service's configuration. The on-chain half is
`Deployment.verify_code`, run before a pass acts: the recorded runtime code
hashes, and the verification block still canonical.
"""
from dataclasses import dataclass
from datetime import datetime
from functools import cached_property
import hashlib
import json
from pathlib import Path
import re

from eth_abi import encode
from eth_hash.auto import keccak

from discovery import DataError, parse_block, prefetched
from v2_chains import ChainProfile
from v2_rpc import CodeCache, batched_reads

MAX_MANIFEST_BYTES = 262144
CREATE_X = '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed'
CREATE_X_CODE_HASH = '0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f'
# CreateX's CREATE3 proxy init code (0x67363d3d37363d34f03d5260086018f3).
CREATE3_PROXY_INITCODE_HASH = bytes.fromhex('21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f')
CONTRACT_NAMES = {
    'registry': 'DominoRegistry', 'priceAnchor': 'DominoPriceAnchor', 'autoExit': 'DominoAutoExit',
    'vaultSwap': 'DominoV2VaultSwapModule', 'vault.v3': 'DominoV2VaultV3', 'vault.v4': 'DominoV2VaultV4',
    'vaultFactory.v3': 'DominoV2VaultFactory', 'vaultFactory.v4': 'DominoV2VaultFactory',
    'zap.v4.steps': 'DominoZapV4Steps', 'zap.v3': 'DominoZapV3', 'zap.v4': 'DominoZapV4',
    'vaultExecutor.v3': 'DominoV2VaultExecutorV3', 'vaultExecutor.v4': 'DominoV2VaultExecutorV4',
}
COMPONENTS = tuple(CONTRACT_NAMES)
# The eleven deployCreate3 components; the implementations create the executors.
DEPLOY_ORDER = tuple(name for name in COMPONENTS if not name.startswith('vaultExecutor.'))
ROLE_NAMES = ('deployer', 'governance', 'guardian', 'feeRecipient', 'operator', 'publisher')
POLICIES = {
    'assistedSwapFeeBps': 65, 'bridgeAppFeeBps': 35, 'simpleCompoundFeeBps': 200, 'dominoCompoundFeeBps': 400,
    'autoExitFeeBps': 20, 'automationFeeBasis': 'consumed_original_earned_fees_once_not_principal',
    'additionalAutomationSwapFeeBps': 0, 'timelockSeconds': 86400, 'minTwapSeconds': 60,
    'autoExitMaxObservationAgeSeconds': 300, 'autoExitMinTwapSeconds': 600, 'minimumUniversalRouterVersion': 212,
    'hookedPoolsAllowed': False,
}
DEPENDENCIES = ('v3Factory', 'v3PositionManager', 'v3Quoter', 'v3SwapRouter', 'v4PoolManager', 'v4PositionManager',
                'v4StateView', 'v4Quoter', 'universalRouter', 'permit2', 'wrappedNative')
ENVIRONMENTS = ('public-chain-preparation', 'local-test', 'fork-rehearsal')
ENABLED_CHAINS = (4663, 8453, 42161)
ADMISSIONS = ('production', 'fork-rehearsal', 'local-test')
BUILD = {'version': '0.8.26+commit.8a97fa7a', 'optimizerRuns': 200, 'viaIR': True, 'evmVersion': 'cancun',
         'bytecodeHash': 'none'}
TOP_LEVEL = ('schemaVersion', 'kind', 'status', 'environment', 'chain', 'sourceCommit', 'releaseTag', 'contractNames',
             'contracts', 'dependencies', 'roles', 'policies', 'chargeCurrencies', 'runtimeCodeHashes', 'createx',
             'build', 'deploymentReceipts', 'verification')
RECEIPT_KEYS = ('transactionHash', 'blockNumber', 'blockHash', 'gasUsed', 'effectiveGasPrice')
VERIFICATION_KEYS = ('blockNumber', 'blockHash', 'blockTag', 'codeHashes', 'wiring', 'checkedAt')
_ADDRESS = re.compile(r'0x[0-9a-f]{40}')
_HASH = re.compile(r'0x[0-9a-f]{64}')
_HEX64 = re.compile(r'[0-9a-f]{64}')
_DECIMAL = re.compile(r'0|[1-9][0-9]*')


def _ensure(condition):
    if not condition:
        raise DataError('v2_deployment_invalid')


def _keys(value, expected):
    _ensure(type(value) is dict and sorted(value) == sorted(expected))


def _address(value):
    return type(value) is str and _ADDRESS.fullmatch(value) is not None


def _hash(value):
    return type(value) is str and _HASH.fullmatch(value) is not None


def _integer(value):
    """Number.isSafeInteger(x) && x >= 0, for a JSON integer."""
    return type(value) is int and 0 <= value < 2**53


def _sorted(value):
    if type(value) is dict:
        # JavaScript sorts keys by UTF-16 code unit, Python by code point.
        return {key: _sorted(value[key]) for key in sorted(value, key=lambda key: key.encode('utf-16-be'))}
    if type(value) is list:
        return [_sorted(item) for item in value]
    return value


def canonical(value):
    """deploy.mjs `canonical`: JSON.stringify with every object's keys sorted."""
    try:
        return json.dumps(_sorted(value), separators=(',', ':'), ensure_ascii=False)
    except UnicodeError:  # a lone surrogate, which JavaScript would escape
        raise DataError('v2_deployment_invalid') from None


def component_salt(deployer, component):
    """F0: deployer (20 bytes) ‖ 0x00 ‖ bytes11(keccak256("domino.v2.<component>"))."""
    return '0x' + deployer[2:].lower() + '00' + keccak(f'domino.v2.{component}'.encode())[:11].hex()


def guarded_salt(deployer, salt):
    """CreateX's guard for a sender-prefixed salt without the chain flag."""
    return '0x' + keccak(encode(['address', 'bytes32'], [deployer, bytes.fromhex(salt[2:])])).hex()


def create_address(sender, nonce):
    """The address of `sender`'s CREATE at a nonce below 128 (RLP of [sender, nonce])."""
    body = b'\x94' + bytes.fromhex(sender[2:]) + (bytes([nonce]) if nonce else b'\x80')
    return '0x' + keccak(bytes([0xc0 + len(body)]) + body)[12:].hex()


def create3_proxy(createx, guarded):
    """CREATE2(createx, guarded salt, CreateX's CREATE3 proxy)."""
    preimage = b'\xff' + bytes.fromhex(createx[2:]) + bytes.fromhex(guarded[2:]) + CREATE3_PROXY_INITCODE_HASH
    return '0x' + keccak(preimage)[12:].hex()


def create3_address(createx, deployer, salt):
    """CreateX.computeCreate3Address of the guarded salt: the proxy's first CREATE."""
    return create_address(create3_proxy(createx, guarded_salt(deployer, salt)), 1)


def predict(deployer):
    """deploy.mjs `precomputeAddresses`: the 13 addresses, the salts and the guarded salts."""
    contracts, salts, guarded = {}, {}, {}
    for component in DEPLOY_ORDER:
        salts[component] = component_salt(deployer, component)
        guarded[component] = guarded_salt(deployer, salts[component])
        contracts[component] = create_address(create3_proxy(CREATE_X, guarded[component]), 1)
    for dex in ('v3', 'v4'):
        contracts[f'vaultExecutor.{dex}'] = create_address(contracts[f'vault.{dex}'], 1)
    return contracts, salts, guarded


def _roles(roles):
    """deploy.mjs `validateRoles` on lower-case addresses (the schema's form)."""
    _keys(roles, ROLE_NAMES)
    for value in roles.values():
        _ensure(_address(value) and int(value, 16) >= 65536 and re.fullmatch(r'0x([0-9a-f])\1{39}', value) is None)
    _ensure(roles['operator'] != roles['publisher'])


def _checked_at(value):
    _ensure(type(value) is str)
    try:
        datetime.fromisoformat(value)
    except ValueError:
        raise DataError('v2_deployment_invalid') from None


def checked_manifest(m):
    """validateManifest (scripts/v2/deploy-schema.mjs) and the structural schema."""
    _keys(m, TOP_LEVEL)
    _ensure(type(m['schemaVersion']) is int and m['schemaVersion'] == 1 and m['kind'] == 'domino-v2-deployment'
            and m['status'] in ('prepared', 'verified'))
    chain = m['chain']
    _keys(chain, ('name', 'chainId', 'nativeCurrency'))
    _ensure(_integer(chain['chainId']) and chain['chainId'] > 0 and type(chain['name']) is str and chain['name']
            and type(chain['nativeCurrency']) is str and chain['nativeCurrency'])
    _ensure(m['environment'] in ENVIRONMENTS)
    _ensure(m['environment'] == 'local-test' or chain['chainId'] in ENABLED_CHAINS)
    _ensure(type(m['sourceCommit']) is str and re.fullmatch(r'[0-9a-f]{40}', m['sourceCommit']) is not None
            and type(m['releaseTag']) is str
            and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}', m['releaseTag']) is not None)
    _ensure(canonical(m['contractNames']) == canonical(CONTRACT_NAMES)
            and canonical(m['policies']) == canonical(POLICIES))
    _roles(m['roles'])
    contracts, salts, guarded = predict(m['roles']['deployer'])
    _ensure(canonical(m['contracts']) == canonical(contracts))
    _ensure(all(role not in contracts.values() and role != CREATE_X for role in m['roles'].values()))
    createx = m['createx']
    _keys(createx, ('address', 'runtimeCodeHash', 'salts', 'guardedSalts'))
    _ensure(createx['address'] == CREATE_X and createx['runtimeCodeHash'] == CREATE_X_CODE_HASH
            and canonical(createx['salts']) == canonical(salts)
            and canonical(createx['guardedSalts']) == canonical(guarded))
    _keys(m['dependencies'], DEPENDENCIES)
    _ensure(all(_address(value) and int(value, 16) > 0 for value in m['dependencies'].values()))
    _keys(m['runtimeCodeHashes'], (*COMPONENTS, *DEPENDENCIES))
    _ensure(all(_hash(value) and int(value, 16) > 0 for value in m['runtimeCodeHashes'].values()))
    charge = m['chargeCurrencies']
    _ensure(type(charge) is list and len(charge) >= 2)
    for currency in charge:
        _keys(currency, ('token', 'rank'))
        _ensure(_address(currency['token']) and type(currency['rank']) is int and 0 < currency['rank'] < 256)
    _ensure(len({currency['token'] for currency in charge}) == len(charge))
    build = m['build']
    _keys(build, (*BUILD, 'sourceTreeSha256', 'workingTreeSourceChanges', 'sourceHashes', 'chainProfileSha256'))
    _ensure(all(type(build[key]) is type(value) and build[key] == value for key, value in BUILD.items()))
    _ensure(type(build['chainProfileSha256']) is str and _HEX64.fullmatch(build['chainProfileSha256']) is not None
            and type(build['workingTreeSourceChanges']) is bool)
    hashes = build['sourceHashes']
    _ensure(type(hashes) is dict and len(hashes) > 0)
    for path, value in hashes.items():
        _ensure(path.startswith(('src/v2/', 'deploy-fixtures/')) and '..' not in path.split('/')
                and type(value) is str and _HEX64.fullmatch(value) is not None)
    _ensure(type(build['sourceTreeSha256']) is str
            and build['sourceTreeSha256'] == hashlib.sha256(canonical(hashes).encode()).hexdigest())
    receipts, verification = m['deploymentReceipts'], m['verification']
    _ensure(type(receipts) is dict)
    if m['status'] == 'prepared':
        _ensure(verification is None and not receipts)
        return m
    _keys(receipts, DEPLOY_ORDER)
    for receipt in receipts.values():
        _keys(receipt, RECEIPT_KEYS)
        _ensure(_hash(receipt['transactionHash']) and _hash(receipt['blockHash']) and _integer(receipt['blockNumber'])
                and type(receipt['gasUsed']) is str and _DECIMAL.fullmatch(receipt['gasUsed']) is not None
                and type(receipt['effectiveGasPrice']) is str
                and _DECIMAL.fullmatch(receipt['effectiveGasPrice']) is not None)
    _ensure(len({receipt['transactionHash'] for receipt in receipts.values()}) == len(DEPLOY_ORDER))
    _keys(verification, VERIFICATION_KEYS)
    _ensure(_integer(verification['blockNumber']) and _hash(verification['blockHash'])
            and type(verification['blockTag']) is str
            and verification['codeHashes'] == 'exact_precomputed_immutable_runtime'
            and verification['wiring'] == 'checked')
    _checked_at(verification['checkedAt'])
    return m


def profile_dependencies(chain):
    """deploy.mjs `dependencyMap`: the dependencies a deployment on `chain` is built against."""
    u = chain.uniswap
    return {'v3Factory': u.v3.factory, 'v3PositionManager': u.v3.positionManager, 'v3Quoter': u.v3.quoterV2,
            'v3SwapRouter': u.v3.swapRouter02, 'v4PoolManager': u.v4.poolManager,
            'v4PositionManager': u.v4.positionManager, 'v4StateView': u.v4.stateView, 'v4Quoter': u.v4.quoter,
            'universalRouter': u.universalRouter.address, 'permit2': chain.permit2,
            'wrappedNative': chain.wrappedNative.address}


@dataclass(frozen=True)
class Deployment:
    """A checked, admitted manifest bound to its chain profile."""
    chain: ChainProfile
    manifest: dict

    def address(self, component):
        if component not in COMPONENTS:
            raise DataError('v2_deployment_component_unknown')
        return self.manifest['contracts'][component]

    @property
    def registry(self):
        return self.address('registry')

    @property
    def price_anchor(self):
        return self.address('priceAnchor')

    @property
    def auto_exit(self):
        return self.address('autoExit')

    def factory(self, dex):
        return self.address({3: 'vaultFactory.v3', 4: 'vaultFactory.v4'}[dex])

    @property
    def operator(self):
        return self.manifest['roles']['operator']

    @property
    def publisher(self):
        return self.manifest['roles']['publisher']

    @cached_property
    def receipts(self):
        return dict(self.manifest['deploymentReceipts'])

    def start_block(self, component):
        """The block a log scan for `component`'s events starts at: its deployment's."""
        if component not in DEPLOY_ORDER:
            raise DataError('v2_deployment_component_unknown')
        return self.receipts[component]['blockNumber']

    def verify_code(self, rpc, block, *, components=COMPONENTS, cache=None):
        """The on-chain half of admission at `block` (a Block the client pinned):
        each recorded runtime code hash, and the verification block still
        canonical (deploy.mjs re-reads it against a reorganization). Once per
        process: the chain's code cache keeps what one eth_getCode proved."""
        cache = cache or getattr(rpc, 'code_cache', None) or CodeCache()
        expected = {name: self.manifest['runtimeCodeHashes'][name] for name in components}
        pending = [name for name in components
                   if not cache.proven(self.address(name), expected[name], block.number)]
        if not pending:
            return
        anchor = self.manifest['verification']
        if anchor['blockNumber'] > block.number:
            raise DataError('v2_deployment_ahead_of_head')
        raw_anchor, *codes = batched_reads(rpc, [('eth_getBlockByNumber', [hex(anchor['blockNumber']), False]),
                                                 *(('eth_getCode', [self.address(name), block.tag])
                                                   for name in pending)])
        if parse_block(prefetched(raw_anchor)).hash != anchor['blockHash']:
            raise DataError('v2_deployment_anchor_reorganized')
        for name, raw in zip(pending, codes):
            code = prefetched(raw)
            if (type(code) is not str or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', code)
                    or '0x' + keccak(bytes.fromhex(code[2:])).hex() != expected[name]):
                raise DataError('v2_deployment_code_mismatch')
            cache.record(self.address(name), expected[name], block.number)


def checked_deployment(document, chain, *, admission='production'):
    """The manifest `document` for `chain`, admitted for `admission`, or a refusal."""
    if not isinstance(chain, ChainProfile):
        raise DataError('v2_chain_profile_required')
    if admission not in ADMISSIONS:
        raise DataError('v2_deployment_admission_invalid')
    m = checked_manifest(document)
    local = m['environment'] == 'local-test'
    if m['chain']['chainId'] != chain.chainId or (
            not local and (m['chain']['name'] != chain.name or m['chain']['nativeCurrency'] != chain.nativeSymbol)):
        raise DataError('v2_deployment_chain_mismatch')
    dependencies = profile_dependencies(chain)
    if m['dependencies'] != dependencies:
        raise DataError('v2_deployment_dependency_mismatch')
    if not local:
        listed = [{'token': currency.address, 'rank': currency.rank} for currency in chain.chargeCurrencies]
        if (any(m['runtimeCodeHashes'][name] != chain.verified_codehash(address)
                for name, address in dependencies.items()) or m['chargeCurrencies'] != listed):
            raise DataError('v2_deployment_dependency_mismatch')
    if m['status'] != 'verified':
        raise DataError('v2_deployment_not_executed')
    if {'production': m['environment'] != 'public-chain-preparation' or m['build']['workingTreeSourceChanges']
                      or m['verification']['blockTag'] != 'finalized',
            'fork-rehearsal': m['environment'] != 'fork-rehearsal',
            'local-test': not local}[admission]:
        raise DataError('v2_deployment_not_admitted')
    return Deployment(chain, m)


def _number(text):
    """A JSON number with a fraction or exponent, read as JavaScript reads it
    (the nearest double): an integral value is an integer ("1.0", "1e3"). No
    rule admits any other float, nor NaN or an infinity."""
    value = float(text)
    return int(value) if value.is_integer() else value


def parse_manifest(raw):
    """The manifest file's bytes as a document, one value per key."""
    if len(raw) > MAX_MANIFEST_BYTES:
        raise DataError('v2_deployment_invalid')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_json_key')
            result[key] = value
        return result

    try:
        return json.loads(raw, object_pairs_hook=unique, parse_float=_number)
    except (ValueError, RecursionError):  # JSON, UTF-8 (UnicodeDecodeError) and duplicate keys; nesting
        raise DataError('v2_deployment_invalid') from None


def load_deployment(path, chain, *, admission='production'):
    """The deployment manifest at `path` (public repository data)."""
    try:
        raw = Path(path).read_bytes()
    except OSError:
        raise DataError('v2_deployment_unreadable') from None
    return checked_deployment(parse_manifest(raw), chain, admission=admission)
