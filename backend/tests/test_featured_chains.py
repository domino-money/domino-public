"""Featured pools on Base and Arbitrum One: each chain's policy against its profile, the rules on v3 and v4 pools, the
listing per network, the estimate, and the evidence read at one block through the chain's V2 endpoints.

The endpoints are v2_rpc's own ChainEndpoints over a scripted hosted provider (v2_fixtures.FakeChain): every call is
billed and logged, a batch above the endpoint's limit fails the test, and Multicall3's reads answer from a script.
"""
import copy
from datetime import datetime, timezone
from decimal import Decimal
from fractions import Fraction
import json
from math import isqrt
from pathlib import Path
import sys
import unittest
import unittest.mock

from eth_abi import encode
from eth_hash.auto import keccak

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from discovery import KEY_TYPES, ZERO, DataError
import featured_chain_evidence as evidence
from featured_chain_selector import estimate, lp_share
from featured_chains import CHAINS, POLICY_DIRECTORY, check_chain_policy, load_chain_policy, network_of
from featured_live import window
import featured_pools as rules
from gt_listing import MAX_MULTI, ROBINHOOD, GeckoListing, listing_url, multi_url, pool_item
from market_data import PREFIX, ROOT
from v2_chain_reads import load_token_list
from v2_chains import default_registry
from v2_fixtures import FakeChain
from v2_quotes import AGGREGATE3
from v2_rpc import ChainReadRpc, checked_chain_rpc_config, configured_endpoints
from v2_uniswap import v3_pool_address
from v4_math import amount_delta, tick_at_sqrt

REGISTRY=default_registry()
BASE,ARBITRUM=REGISTRY.chain(8453),REGISTRY.chain(42161)
POLICY,_=load_chain_policy('base-8453')
ARBITRUM_POLICY,_=load_chain_policy('arbitrum-42161')
ROBINHOOD_POLICY=rules.load_policy()
DAY=86400
NOW=int(datetime(2026,11,5,9,32,tzinfo=timezone.utc).timestamp())   # in Base's window
USDC,WETH=BASE.chargeCurrencies[0].address,BASE.wrappedNative.address
CBBTC='0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'
TOKEN='0x'+'7a'*20
FAKE_USDC='0x'+'5c'*20
CHAINSTACK,ALCHEMY='https://chainstack.example.invalid/SYNTHETIC_KEY','https://alchemy.example.invalid/v2/SYNTHETIC_KEY'
V3,V4=rules.DEX_V3,rules.DEX_V4
ROUND=['uint80','int256','uint256','uint256','uint80']
V3_SLOT0=['uint160','int24','uint16','uint16','uint16','uint8','bool']
KEY=['address','address','uint24','int24','address']
PLAIN=lambda token:'0x73'+token[2:]+'5000'   # PUSH20 <token> POP STOP: code that cannot DELEGATECALL
PROXY='0x6000f400'                           # PUSH1 0 DELEGATECALL STOP
BITMAPS=frozenset((keccak(b'tickBitmap(int16)')[:4].hex(),keccak(b'getTickBitmap(bytes32,int16)')[:4].hex()))


def sel(signature):
    return keccak(signature.encode())[:4].hex()


def sqrt_of(price):
    """sqrtPriceX96 of a raw currency1-per-currency0 price."""
    price=Fraction(price)
    return isqrt(price.numerator*2**192//price.denominator)


# WETH (token0, 18 decimals) at 4,000 USDC (token1, 6); one ETH (currency0) for a million TOKEN (currency1).
WETH_USDC_SQRT=sqrt_of(Fraction(4000*10**6,10**18))
ETH_TOKEN_SQRT=sqrt_of(10**6)


class Chain(FakeChain):
    """One chain's hosted provider: headers, code, and Multicall3 reads answered from `answers`
    ({(target, selector hex, argument bytes): (ok, return bytes)}). A bitmap word nobody set is empty, as on any
    pool; any other unscripted read answers as an address without code would, success and no data."""
    def __init__(self,chain=BASE,*,now=NOW,age=5):
        super().__init__(chain.chainId,head={'number':hex(30_000_000),'hash':'0x'+'ab'*32,'timestamp':hex(now-age)})
        self.chain,self.answers,self.subcalls,self.rounds=chain,{},[],[]
        self.on(chain.multicall3,AGGREGATE3,self.aggregate)
        feed(self)

    def aggregate(self,calls):
        rows=[]
        self.rounds.append(len(calls))
        for target,_,data in calls:
            key=(target.lower(),data[:4].hex(),bytes(data[4:]))
            self.subcalls.append(key)
            if key in self.answers:
                rows.append(self.answers[key])
            elif key[1] in BITMAPS:
                rows.append((True,encode(['uint256'],[0])))
            else:
                rows.append((True,b''))
        return (rows,)

    def methods(self):
        return [entry[1] for entry in self.log]


def feed(fake,*,usd=4000,age=60,up_for=DAY):
    """The profile's Chainlink ETH/USD `age` seconds old at the head, and its sequencer up for `up_for`."""
    chain,at=fake.chain,int(fake.head['timestamp'],16)
    proxy=chain.gasPrice.chainlinkEthUsd
    fake.answers[(proxy.proxy,sel('latestRoundData()'),b'')]=(True,encode(ROUND,[9,usd*10**proxy.decimals,at-age,at-age,9]))
    started=at-up_for
    fake.answers[(proxy.sequencerUptimeFeed,sel('latestRoundData()'),b'')]=(True,encode(ROUND,[3,0,started,started,3]))


def token(fake,address,symbol,decimals=18,code=None):
    fake.answers[(address,sel('decimals()'),b'')]=(True,encode(['uint8'],[decimals]))
    fake.answers[(address,sel('symbol()'),b'')]=(True,encode(['string'],[symbol]))
    fake.codes[address]=code or PLAIN(address)


def v3_pool(fake,token0,token1,fee,spacing,*,sqrt,liquidity,protocol=0,at=None,ticks=None):
    """A v3 pool at its CREATE2 address (or `at`): its immutables, slot0, liquidity and initialized `ticks`
    ({tick: liquidityNet}) in otherwise empty bitmap words. Returns its address."""
    pool=at or v3_pool_address(fake.chain,token0,token1,fee)
    fake.answers.update({
        (pool,sel('token0()'),b''):(True,encode(['address'],[token0])),
        (pool,sel('token1()'),b''):(True,encode(['address'],[token1])),
        (pool,sel('fee()'),b''):(True,encode(['uint24'],[fee])),
        (pool,sel('tickSpacing()'),b''):(True,encode(['int24'],[spacing])),
        (pool,sel('slot0()'),b''):(True,encode(V3_SLOT0,[sqrt,tick_at_sqrt(sqrt) if sqrt else 0,0,1,1,protocol,True])),
        (pool,sel('liquidity()'),b''):(True,encode(['uint128'],[liquidity]))})
    words={}
    for initialized,net in (ticks or {}).items():
        compressed=initialized//spacing
        words[compressed>>8]=words.get(compressed>>8,0)|1<<(compressed&255)
        fake.answers[(pool,sel('ticks(int24)'),encode(['int24'],[initialized]))]=(True,encode(
            ['uint128','int128','uint256','uint256','int56','uint160','uint32','bool'],[abs(net),net,0,0,0,0,0,True]))
    for position,value in words.items():
        fake.answers[(pool,sel('tickBitmap(int16)'),encode(['int16'],[position]))]=(True,encode(['uint256'],[value]))
    return pool


def v4_pool(fake,key,*,sqrt,liquidity,protocol=0,lp_fee=None,recorded=True,ticks=None):
    """A v4 pool: its key as the PositionManager recorded it (all zero if `recorded` is false), its StateView slot0
    and liquidity, and initialized `ticks` in otherwise empty words. Returns its id."""
    pool_id='0x'+keccak(encode(KEY_TYPES,key)).hex()
    raw=bytes.fromhex(pool_id[2:])
    view,manager=fake.chain.uniswap.v4.stateView,fake.chain.uniswap.v4.positionManager
    fake.answers.update({
        (manager,sel('poolKeys(bytes25)'),encode(['bytes25'],[raw[:25]])):
            (True,encode(KEY,list(key) if recorded else [ZERO,ZERO,0,0,ZERO])),
        (view,sel('getSlot0(bytes32)'),raw):
            (True,encode(['uint160','int24','uint24','uint24'],[sqrt,tick_at_sqrt(sqrt) if sqrt else 0,protocol,
                                                               key[2] if lp_fee is None else lp_fee])),
        (view,sel('getLiquidity(bytes32)'),raw):(True,encode(['uint128'],[liquidity]))})
    words={}
    for initialized,net in (ticks or {}).items():
        compressed=initialized//key[3]
        words[compressed>>8]=words.get(compressed>>8,0)|1<<(compressed&255)
        fake.answers[(view,sel('getTickLiquidity(bytes32,int24)'),encode(['bytes32','int24'],[raw,initialized]))]=(
            True,encode(['uint128','int128'],[abs(net),net]))
    for position,value in words.items():
        fake.answers[(view,sel('getTickBitmap(bytes32,int16)'),encode(['bytes32','int16'],[raw,position]))]=(
            True,encode(['uint256'],[value]))
    return pool_id


def endpoints(fake,chain=BASE,*,batch=100):
    """The chain's endpoints in the owner's order, Chainstack then Alchemy, over the scripted provider: v2_rpc's
    production transport. A batch above `batch` reaching the provider fails the test."""
    def entry(name,url):
        return {'name':name,'host':f'{name}.example.invalid','url':url,'archive':True,'maxBatchItems':batch,
                'maxLogBlocks':10000,'requestsPerSecond':None}
    fake.batch_limits={CHAINSTACK:batch,ALCHEMY:batch}
    document={'schemaVersion':1,'kind':'domino-v2-chain-rpc',
              'chains':{chain.key:{'endpoints':[entry('chainstack',CHAINSTACK),entry('alchemy',ALCHEMY)]}}}
    return configured_endpoints(chain,chain_rpc_config=checked_chain_rpc_config(document,environ={}),send=fake)


def gt_pool(pool_id,base,quote,*,dex,network='base',volume='5000000',tvl='2000000',created=NOW-30*DAY,
            price='0.000001'):
    """One GeckoTerminal JSON:API pool object of a chain network, in the shape the Robinhood recordings show."""
    return {'id':f'{network}_{pool_id}','type':'pool',
            'attributes':{'address':pool_id,'name':'A / B','reserve_in_usd':tvl,
                          'volume_usd':{'h24':volume,'h6':str(Decimal(volume)/5)},
                          'transactions':{'h24':{'buys':300,'sells':300,'buyers':150,'sellers':150}},
                          'pool_created_at':datetime.fromtimestamp(created,timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                          'price_change_percentage':{'h24':'1'},'base_token_price_quote_token':price},
            'relationships':{'base_token':{'data':{'id':f'{network}_{base}','type':'token'}},
                             'quote_token':{'data':{'id':f'{network}_{quote}','type':'token'}},
                             'dex':{'data':{'id':dex,'type':'dex'}}}}


class Provider:
    """GeckoTerminal for one network: listing pages per DEX label, /pools/multi rows, scripted failures."""
    def __init__(self,pages,multi=()):
        self.pages,self.multi_rows,self.urls,self.fail,self.fail_multi=dict(pages),list(multi),[],None,None
        self.fail_once={}
    def __call__(self,url,timeout=None):
        self.urls.append(url)
        for fragment in [fragment for fragment in self.fail_once if fragment in url]:
            raise DataError(self.fail_once.pop(fragment))
        if self.fail:raise DataError(self.fail)
        if '/pools/multi/' in url:
            if self.fail_multi:raise DataError(self.fail_multi)
            wanted=url.rsplit('/',1)[1].split(',')
            return {'data':[copy.deepcopy(row) for row in self.multi_rows if row['attributes']['address'] in wanted]}
        label=url.split('/dexes/')[1].split('/')[0]
        page=int(url.rsplit('=',1)[1])
        pages=self.pages.get(label,[])
        return {'data':copy.deepcopy(pages[page-1]) if page<=len(pages) else []}


def read(fake,pool_ids,*,policy=POLICY,chain=BASE,now=NOW,budget=64):
    rpc=ChainReadRpc(endpoints(fake,chain),batch_reads=True,max_requests=budget)
    return evidence.read(chain,rpc,policy,pool_ids,now=now),rpc


class ChainPolicyTests(unittest.TestCase):
    def test_each_chain_selects_with_robinhood_s_v2_values_and_its_own_facts(self):
        # The owner, 4 Nov 2026: Robinhood's floors (US$ 1M, 100k, 10k), its ceilings (off), v3 and v4.
        facts=('chain','selectionHourUtc','referenceTokens','sameAssetPairs','ethUsdPricePool','reviewedTokens')
        for policy,chain in ((POLICY,BASE),(ARBITRUM_POLICY,ARBITRUM)):
            with self.subTest(chain=chain.key):
                self.assertEqual({key:value for key,value in policy.items() if key not in facts},
                                 {key:value for key,value in ROBINHOOD_POLICY.items() if key not in facts})
                stable=chain.chargeCurrencies[0].address
                self.assertEqual(policy['referenceTokens'],{ZERO:{'symbol':'ETH','decimals':18},
                                                            chain.wrappedNative.address:{'symbol':'WETH','decimals':18},
                                                            stable:{'symbol':'USDC','decimals':6}})
                self.assertEqual((rules.stable_of(policy),policy['ethUsdPricePool']),(stable,None))
                self.assertEqual(sorted(rules.dex_labels(policy).values()),[V3,V4])
                self.assertEqual(network_of(policy).chain_id,chain.chainId)
        self.assertEqual(rules.dex_labels(POLICY),{'uniswap-v3-base':V3,'uniswap-v4-base':V4})
        self.assertEqual(rules.dex_labels(ARBITRUM_POLICY),{'uniswap_v3_arbitrum':V3,'uniswap-v4-arbitrum':V4})
        # Each chain's choices are versioned apart from Robinhood's, which keeps its own.
        none={'pins':[],'excludedPools':[],'excludedTokens':[]}
        versions={rules.policy_version(policy,none) for policy in (POLICY,ARBITRUM_POLICY,ROBINHOOD_POLICY)}
        self.assertEqual(len(versions),3)
        self.assertIn('featured-v1:603500f6d873',versions)

    def test_the_windows_are_staggered_clear_of_robinhood_s(self):
        # Robinhood selects 11:30-12:00 and publishes until 12:30 UTC; each chain lists alone on the allowance.
        robinhood=window(ROBINHOOD_POLICY,NOW)
        base,arbitrum=window(POLICY,NOW),window(ARBITRUM_POLICY,NOW)
        hour=lambda moment:datetime.fromtimestamp(moment,timezone.utc).strftime('%H:%M')
        self.assertEqual([hour(moment) for moment in base],['09:30','09:50','10:00'])
        self.assertEqual([hour(moment) for moment in arbitrum],['10:30','10:50','11:00'])
        self.assertLessEqual(base[2]+30*60,arbitrum[0])
        self.assertLessEqual(arbitrum[2]+30*60,robinhood[0])

    def test_only_the_shadow_chains_have_policies(self):
        self.assertEqual(sorted(path.stem for path in POLICY_DIRECTORY.glob('*.json')),sorted(CHAINS))
        for key in ('robinhood-4663','base-1','ethereum-1'):
            with self.subTest(key=key),self.assertRaisesRegex(DataError,'featured_chain_unknown'):
                load_chain_policy(key)

    def test_a_policy_whose_facts_are_not_its_profile_s_is_refused(self):
        listed=load_token_list()
        changes=[
            ('chain','chainId',42161),('chain','profile','arbitrum-42161'),('chain','stable',WETH),
            ('referenceTokens',USDC,{'symbol':'USDC','decimals':18}),
            ('referenceTokens','0x'+'11'*20,{'symbol':'USDT','decimals':6}),
            ('sameAssetPairs',None,[[ZERO,'0x'+'11'*20]]),
            ('reviewedTokens',None,['0x'+'11'*20]),     # a token the registry does not name
            ('reviewedTokens',None,[USDC]),             # a reference token is never reviewed
            ('reviewedTokens',None,['0xaf88d065e77c8cc2239327c5edb3a432268e5831']),   # Arbitrum's USDC
        ]
        for name,key,value in changes:
            policy=copy.deepcopy(POLICY)
            if key is None:policy[name]=value
            else:policy[name][key]=value
            with self.subTest(name=name,key=key),self.assertRaisesRegex(DataError,'invalid_featured_chain_policy'):
                check_chain_policy(policy,BASE,listed)
        for dexes in ({'uniswap-v4-base':V4},{'uniswap-v3-base':V3}):
            policy=copy.deepcopy(POLICY);policy['chain']['geckoTerminal']['dexes']=dexes
            with self.subTest(dexes=dexes),self.assertRaisesRegex(DataError,'invalid_featured_chain_policy'):
                check_chain_policy(policy,BASE,listed)
        with self.assertRaisesRegex(DataError,'invalid_featured_chain_policy'):
            check_chain_policy(ROBINHOOD_POLICY,BASE,listed)
        check_chain_policy(copy.deepcopy(POLICY),BASE,listed)

    def test_the_reviewed_tokens_are_the_registry_s_canonical_tokens_by_address(self):
        # USDC is each chain's stable. USDT, cbBTC and WBTC are reviewed where the pinned token list names them:
        # Base's names cbBTC only; Arbitrum's names USDT0 (Tether's USDT there), WBTC and cbBTC.
        _,listed=load_token_list()
        for policy,chain,symbols in ((POLICY,BASE,['cbBTC']),(ARBITRUM_POLICY,ARBITRUM,['USDT0','WBTC','cbBTC'])):
            with self.subTest(chain=chain.key):
                named={entry[0]:entry[1] for entry in listed[chain.chainId]}
                self.assertEqual(sorted(named[token] for token in policy['reviewedTokens']),symbols)
                self.assertEqual(rules.stable_of(policy),next(token for token,symbol in named.items() if symbol=='USDC'))

    def test_the_rules_module_checks_the_chain_block_itself(self):
        cases=[(('chain',),{'chainId':8453}),(('chain','chainId'),'8453'),(('chain','profile'),'base'),
               (('chain','profile'),'base-42161'),(('chain','stable'),'0x'+'11'*20),
               (('chain','geckoTerminal','network'),'Base'),(('chain','geckoTerminal','dexes'),{}),
               (('chain','geckoTerminal','dexes'),{'uniswap-v3-base':3,'uniswap-v3-base2':3}),
               (('chain','geckoTerminal','dexes'),{'uniswap-v5-base':5}),
               (('chain','geckoTerminal','dexes'),{'Uniswap V3':3}),(('ethUsdPricePool',),'0x'+'11'*32),
               (('chain','rpc'),'https://example.invalid'),(('chain','geckoTerminal','apiKey'),'x')]
        for path,value in cases:
            policy=copy.deepcopy(POLICY);target=policy
            for name in path[:-1]:target=target[name]
            target[path[-1]]=value
            with self.subTest(path=path,value=value),self.assertRaisesRegex(DataError,'invalid_featured_policy'):
                rules.check_policy(policy)
        # A chain id is a positive 63-bit integer, not a truth value that happens to read as one.
        for chain_id in (True,0,-8453,2**63):
            policy=copy.deepcopy(POLICY);policy['chain'].update(chainId=chain_id,profile=f'base-{chain_id}')
            with self.subTest(chain_id=chain_id),self.assertRaisesRegex(DataError,'invalid_featured_policy'):
                rules.check_policy(policy)
        # Robinhood's policy names its ETH/USDG pool, and no chain.
        policy=copy.deepcopy(ROBINHOOD_POLICY);policy['ethUsdPricePool']=None
        with self.assertRaisesRegex(DataError,'invalid_featured_policy'):rules.check_policy(policy)


class ChainRuleTests(unittest.TestCase):
    def candidate(self,*,dex=V3,label='uniswap-v3-base',protocol=0,currencies=(CBBTC,USDC)):
        c0,c1=sorted(currencies)
        key={'currency0':c0,'currency1':c1,'fee_pips':500,'tick_spacing':10,'hooks':ZERO,'feeMode':'fixed'}
        pool_id=v3_pool_address(BASE,c0,c1,500) if dex==V3 else '0x'+'4b'*32
        return {'poolId':pool_id,
                'market':{'currencies':[c0,c1],'baseToken':c0,'quoteToken':c1,'dexLabel':label,
                          'volume24hUsd':'5000000','reportedLiquidityUsd':'2000000'},
                'listing':{},
                'chain':{'pool':{'poolId':pool_id,'dex':dex,'currencies':[c0,c1],'poolKey':key,'currentLpFeePips':500,
                                 'protocolFeeRaw':protocol,'integrationClass':'hookless_fixed_fee'},'liquidity':10**18},
                'estimate':{'status':'available','feeAprEstimate24hPercent':'45.6'},
                'depth':{'status':'measured','usd':'50000'},
                'token':{'address':CBBTC,'code':True,'codeHash':'0xaa','decimals':8,'symbol':'cbBTC',
                         'proxy':'delegatecall'}}

    def judged(self,candidate,policy=POLICY):
        return rules.evaluate(candidate,policy,now=NOW,previous={})

    def test_robinhood_keeps_usdg_and_its_one_dex_label(self):
        usdg='0x5fc5360d0400a0fd4f2af552add042d716f1d168'
        self.assertEqual(rules.stable_of(ROBINHOOD_POLICY),usdg)
        self.assertEqual(rules.dex_labels(ROBINHOOD_POLICY),{'uniswap-v4-robinhood':V4})
        # A pool read without a version is v4: Robinhood's pool_market reads v4 alone.
        self.assertIsNone(rules.protocol_fee_reason({'protocolFeeRaw':(300<<12)|300}))
        self.assertEqual(rules.depth_usd(10**6,usdg,ROBINHOOD_POLICY,None),1)

    def test_a_canonical_token_passes_by_address_on_its_chain(self):
        result=self.judged(self.candidate())
        self.assertEqual(result['reasons'],[])
        self.assertEqual((result['reference'],result['token']),(USDC,CBBTC))
        # On Robinhood the same evidence is a protected, upgradeable token: there it is a look-alike.
        self.assertEqual(rules.token_reasons(self.candidate()['token'],ROBINHOOD_POLICY,published_readings={}),
                         ['token_protected_unreviewed','token_upgradeable_unreviewed'])

    def test_the_provider_must_list_a_pool_under_its_own_version(self):
        for dex,label,expected in ((V3,'uniswap-v4-base',['provider_dex_unconfirmed']),
                                   (V4,'uniswap-v3-base',['provider_dex_unconfirmed']),
                                   (V3,'uniswap-v4-robinhood',['provider_dex_unconfirmed']),
                                   (V4,'uniswap-v4-base',[]),(V3,'uniswap-v3-base',[])):
            with self.subTest(dex=dex,label=label):
                self.assertEqual(self.judged(self.candidate(dex=dex,label=label))['reasons'],expected)

    def test_a_v3_protocol_fee_is_a_share_of_the_swap_fee_alike_both_ways(self):
        for protocol,expected in ((0,[]),(0x44,[]),(0xaa,[]),(0x40,['protocol_fee_directional_unsupported']),
                                  (0x45,['protocol_fee_directional_unsupported']),(0x33,['invalid_protocol_fee']),
                                  (0xb0,['invalid_protocol_fee']),(0x1aa,['invalid_protocol_fee'])):
            with self.subTest(protocol=hex(protocol)):
                self.assertEqual(self.judged(self.candidate(protocol=protocol))['reasons'],expected)
        # v4 reads the same raw value as two 12-bit directional fees.
        self.assertEqual(self.judged(self.candidate(dex=V4,label='uniswap-v4-base',protocol=0x44))['reasons'],
                         ['protocol_fee_directional_unsupported'])

    def test_the_stable_is_the_dollar_side_of_a_major_pair(self):
        for currencies in ((WETH,USDC),(ZERO,USDC)):
            with self.subTest(currencies=currencies):
                side,problem=rules.reference_side(sorted(currencies),POLICY)
                self.assertEqual((side,problem),((USDC,currencies[0],True),None))
        self.assertEqual(rules.reference_side(sorted((ZERO,WETH)),POLICY),(None,'same_asset_pair'))
        self.assertEqual(rules.depth_usd(25*10**6,USDC,POLICY,Fraction(4000)),25)
        self.assertEqual(rules.depth_usd(10**18,WETH,POLICY,Fraction(4000)),4000)
        self.assertEqual(rules.reference_side(sorted((CBBTC,TOKEN)),POLICY),(None,'no_reference_side'))
        # The stable is the dollar side wherever its address sorts, below the other reference too.
        low='0x'+'01'*20
        policy=copy.deepcopy(POLICY)
        policy['referenceTokens'][low]=policy['referenceTokens'].pop(USDC)
        policy['chain']['stable']=low
        self.assertEqual(rules.reference_side([low,WETH],policy),((low,WETH,True),None))


class NetworkListingTests(unittest.TestCase):
    BASE_NETWORK=network_of(POLICY)

    def test_robinhood_s_network_reads_as_before(self):
        self.assertEqual((ROBINHOOD.root,ROBINHOOD.prefix,ROBINHOOD.chain_id),(ROOT,PREFIX,4663))
        self.assertEqual(listing_url(3),ROOT+'/dexes/uniswap-v4-robinhood/pools?sort=h24_volume_usd_desc&page=3')
        pool=v3_pool_address(BASE,WETH,USDC,500)
        with self.assertRaisesRegex(DataError,'invalid_bytes32'):multi_url([pool])
        row=gt_pool(pool,WETH,USDC,dex='uniswap-v4-robinhood',network='robinhood')
        with self.assertRaisesRegex(DataError,'market_pool_identity_mismatch'):pool_item(row,retrieved=1)

    def test_a_chain_lists_each_version_under_its_label(self):
        network=self.BASE_NETWORK
        self.assertEqual(network.dexes,(('uniswap-v3-base',V3),('uniswap-v4-base',V4)))
        self.assertEqual(listing_url(2,network=network,dex='uniswap-v3-base'),
                         'https://api.geckoterminal.com/api/v2/networks/base/dexes/uniswap-v3-base/pools'
                         '?sort=h24_volume_usd_desc&page=2')
        for dex in ('uniswap-v4-robinhood','uniswap_v3_arbitrum'):
            with self.subTest(dex=dex),self.assertRaisesRegex(DataError,'invalid_listing_dex'):
                listing_url(1,network=network,dex=dex)
        with self.assertRaisesRegex(DataError,'invalid_listing_dex'):GeckoListing(network=network).page(1)

    def test_a_v3_pool_is_named_by_its_address_beside_v4_ids(self):
        network=self.BASE_NETWORK
        pool,v4='0x'+'D0'*20,'0x'+'4B'*32
        self.assertEqual(multi_url([pool,v4,pool.lower()],network=network),
                         network.root+'/pools/multi/'+v4.lower()+','+pool.lower())
        self.assertEqual(len(multi_url(['0x%040x'%n for n in range(MAX_MULTI)],network=network).rsplit('/',1)[1]
                             .split(',')),MAX_MULTI)
        row=gt_pool(v3_pool_address(BASE,WETH,USDC,500),WETH,USDC,dex='uniswap-v3-base')
        item=pool_item(row,retrieved=7,network=network)
        self.assertEqual(item['poolId'],v3_pool_address(BASE,WETH,USDC,500))
        self.assertEqual(item['market']['chainId'],8453)
        self.assertEqual(item['market']['sourceUrl'],network.root+'/pools/'+item['poolId'])
        self.assertEqual(item['market']['currencies'],sorted((WETH,USDC)))
        self.assertEqual(item['market']['dexLabel'],'uniswap-v3-base')

    def test_an_item_of_another_network_is_refused(self):
        network=self.BASE_NETWORK
        row=gt_pool('0x'+'4b'*32,ZERO,USDC,dex='uniswap-v4-base')
        for change,code in ((lambda r:r.update(id='robinhood_'+r['id'][len('base_'):]),'market_pool_identity_mismatch'),
                            (lambda r:r['relationships']['quote_token']['data'].update(id='robinhood_'+USDC),
                             'market_currency_identity_mismatch'),
                            # Another network's token whose prefix is as long as this one's.
                            (lambda r:r['relationships']['quote_token']['data'].update(id='ethx_'+USDC),
                             'market_currency_identity_mismatch'),
                            (lambda r:r['attributes'].update(address='0x'+'4b'*20),'market_pool_identity_mismatch')):
            broken=copy.deepcopy(row);change(broken)
            with self.subTest(code=code),self.assertRaisesRegex(DataError,'^'+code+'$'):
                pool_item(broken,retrieved=1,network=network)
        self.assertEqual(pool_item(row,retrieved=1,network=network)['market']['baseToken'],ZERO)


class EstimateTests(unittest.TestCase):
    def pool(self,dex=V3,protocol=0,fee=500,lp=None,hooks=ZERO,mode='fixed'):
        c0,c1=sorted((WETH,USDC))
        pool_id=v3_pool_address(BASE,c0,c1,fee) if dex==V3 else '0x'+'4b'*32
        return {'poolId':pool_id,'dex':dex,'currencies':[c0,c1],'protocolFeeRaw':protocol,
                'currentLpFeePips':fee if lp is None else lp,
                'poolKey':{'currency0':c0,'currency1':c1,'fee_pips':fee,'tick_spacing':10,'hooks':hooks,'feeMode':mode}}

    def market(self,pool,volume='10000000',tvl='2000000'):
        return {'poolId':pool['poolId'],'currencies':pool['currencies'],'baseToken':pool['currencies'][0],
                'quoteToken':pool['currencies'][1],'volume24hUsd':volume,'reportedLiquidityUsd':tvl}

    def test_the_site_s_method_on_v3_and_v4(self):
        # 10M x 0.05% x 365 x 100 / 2M: the method pool_apr states, on both versions.
        for dex in (V3,V4):
            pool=self.pool(dex)
            found=estimate(pool,self.market(pool))
            self.assertEqual((found['status'],Decimal(found['feeAprEstimate24hPercent'])),('available',Decimal('91.25')))
        # v3's protocol keeps 1/4 of the fee; v4's 1000 pips leave the LP 99.9% of its fee.
        self.assertEqual(lp_share(self.pool(V3,protocol=0x44)),375)
        self.assertEqual(lp_share(self.pool(V4,protocol=(1000<<12)|1000)),Fraction(500*999,1000))
        pool=self.pool(V3,protocol=0x44)
        self.assertEqual(Decimal(estimate(pool,self.market(pool))['feeAprEstimate24hPercent']),Decimal('68.4375'))

    def test_what_leaves_it_unavailable(self):
        pool=self.pool()
        cases=[(pool,None,'market_unavailable'),(pool,self.market(pool,tvl=None),'missing_reported_tvl'),
               (pool,self.market(pool,tvl='0'),'zero_reported_tvl'),
               (pool,self.market(pool,volume=None),'missing_volume24h'),
               (pool,{**self.market(pool),'poolId':'0x'+'11'*20},'market_identity_mismatch'),
               (self.pool(protocol=0x40),self.market(pool),'protocol_fee_directional_unsupported'),
               (self.pool(V4,hooks='0x'+'11'*20),self.market(self.pool(V4)),'hooked_pool_unsupported'),
               (self.pool(V4,mode='dynamic'),self.market(self.pool(V4)),'dynamic_fee_unsupported'),
               (self.pool(V4,lp=3000),self.market(self.pool(V4)),'fixed_fee_mismatch')]
        for pool_case,market,reason in cases:
            with self.subTest(reason=reason):
                found=estimate(pool_case,market)
                self.assertEqual((found['status'],found['feeAprEstimate24hPercent']),('unavailable',None))
                self.assertIn(reason,found['reasons'])


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fake=Chain()
        token(self.fake,CBBTC,'cbBTC',8,PROXY)
        token(self.fake,TOKEN,'TOKEN')
        self.weth_usdc=v3_pool(self.fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18)
        self.eth_token=v4_pool(self.fake,(ZERO,TOKEN,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=10**23)

    def test_every_pool_at_one_block_in_a_few_billed_calls(self):
        found,rpc=read(self.fake,[self.weth_usdc,self.eth_token])
        # The head, two Multicall3 rounds around one eth_getCode, and no third: neither band holds an initialized
        # tick. Every call billed, none for the chain id.
        self.assertEqual(self.fake.methods(),['eth_getBlockByNumber','eth_call','eth_getCode','eth_call'])
        self.assertEqual(rpc.count,len(self.fake.log))
        self.assertTrue(all(url==CHAINSTACK for url,_,_ in self.fake.log))
        blocks={params[-1] for _,method,params in self.fake.log if method in ('eth_call','eth_getCode')}
        self.assertEqual(blocks,{found.block.tag})
        v3,v4=found.pools[self.weth_usdc]['pool'],found.pools[self.eth_token]['pool']
        self.assertEqual((v3['dex'],v3['address'],v3['currencies'],v3['poolKey']['fee_pips'],v3['poolKey']['tick_spacing']),
                         (V3,self.weth_usdc,[WETH,USDC],500,10))
        self.assertEqual((v4['dex'],v4['address'],v4['currencies'],v4['integrationClass']),
                         (V4,None,[ZERO,TOKEN],'hookless_fixed_fee'))
        self.assertEqual(found.pools[self.eth_token]['liquidity'],10**23)
        self.assertEqual(found.eth[0],4000)
        # The major pair has no token to judge; the v4 pool's TOKEN is read once, with its metadata.
        self.assertEqual(sorted(found.tokens),[TOKEN])
        self.assertEqual({name:found.tokens[TOKEN][name] for name in ('code','proxy','decimals','symbol')},
                         {'code':True,'proxy':None,'decimals':18,'symbol':'TOKEN'})

    def test_a_v3_pool_must_sit_at_its_factory_s_create2_address(self):
        impostor=v3_pool(self.fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18,at='0x'+'1d'*20)
        reversed_tokens=v3_pool(self.fake,USDC,WETH,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18,
                                at=v3_pool_address(BASE,USDC,WETH,500))
        uninitialized=v3_pool(self.fake,WETH,USDC,3000,60,sqrt=0,liquidity=0)
        found,_=read(self.fake,[impostor,reversed_tokens,uninitialized,'0x'+'2e'*20])
        for pool_id in (impostor,reversed_tokens,uninitialized,'0x'+'2e'*20):
            with self.subTest(pool=pool_id):
                self.assertEqual(found.pools[pool_id],{'error':'identity_unresolved'})

    def test_a_v3_pool_s_spacing_and_a_v4_pool_s_price_must_be_in_shape(self):
        flat=v3_pool(self.fake,WETH,USDC,100,0,sqrt=WETH_USDC_SQRT,liquidity=1)    # a spacing no walk can step
        empty=v4_pool(self.fake,(ZERO,TOKEN,10000,200,ZERO),sqrt=0,liquidity=0)
        found,_=read(self.fake,[flat,empty])
        self.assertEqual((found.pools[flat],found.pools[empty]),({'error':'identity_unresolved'},)*2)

    def test_a_v4_key_must_be_the_position_manager_s_for_that_id(self):
        unrecorded=v4_pool(self.fake,(ZERO,TOKEN,500,10,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=1,recorded=False)
        other='0x'+'4c'*32
        self.fake.answers[(BASE.uniswap.v4.positionManager,sel('poolKeys(bytes25)'),
                           encode(['bytes25'],[bytes.fromhex(other[2:])[:25]]))]=(True,encode(KEY,[ZERO,TOKEN,3000,60,ZERO]))
        view,raw=BASE.uniswap.v4.stateView,bytes.fromhex(other[2:])
        self.fake.answers[(view,sel('getSlot0(bytes32)'),raw)]=(True,encode(['uint160','int24','uint24','uint24'],
                                                                             [ETH_TOKEN_SQRT,tick_at_sqrt(ETH_TOKEN_SQRT),0,3000]))
        self.fake.answers[(view,sel('getLiquidity(bytes32)'),raw)]=(True,encode(['uint128'],[1]))
        hooked=v4_pool(self.fake,(ZERO,TOKEN,3000,60,'0x'+'44'*20),sqrt=ETH_TOKEN_SQRT,liquidity=1)
        dynamic=v4_pool(self.fake,(ZERO,TOKEN,0x800000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=1,lp_fee=3000)
        found,_=read(self.fake,[unrecorded,other,hooked,dynamic])
        self.assertEqual(found.pools[unrecorded],{'error':'identity_unresolved'})
        self.assertEqual(found.pools[other],{'error':'identity_unresolved'})
        self.assertEqual((found.pools[hooked]['pool']['poolKey']['hooks'],found.pools[hooked]['pool']['integrationClass']),
                         ('0x'+'44'*20,'requires_separate_adapter'))
        self.assertEqual((found.pools[dynamic]['pool']['poolKey']['feeMode'],found.pools[dynamic]['pool']['currentLpFeePips']),
                         ('dynamic',3000))

    def test_the_depth_walks_the_band_as_on_robinhood(self):
        found,_=read(self.fake,[self.weth_usdc,self.eth_token])
        band=Fraction(1,10)
        # WETH sold into WETH/USDC releases USDC (currency1) down to 90% of the price; TOKEN sold into ETH/TOKEN
        # releases ETH (currency0) up to the price at which TOKEN is 10% cheaper. No tick in either band: Robinhood's
        # own walk over empty words, within one floor a word of the closed form.
        walked={}
        for pool_id,sqrt,spacing,liquidity,currency1 in ((self.weth_usdc,WETH_USDC_SQRT,10,10**18,True),
                                                         (self.eth_token,ETH_TOKEN_SQRT,60,10**23,False)):
            walked[pool_id]=rules.reference_depth(lambda word:0,lambda tick:0,sqrt_price=sqrt,tick=tick_at_sqrt(sqrt),
                                                  liquidity=liquidity,tick_spacing=spacing,reference_is_currency1=currency1,
                                                  band=band,max_steps=300)
            exact=amount_delta(sqrt,rules.band_bound(sqrt,band,zero_for_one=currency1),liquidity,
                               1 if currency1 else 0,False)
            self.assertLessEqual(exact-walked[pool_id],8)
        self.assertEqual(found.depths,{pool_id:(amount,None) for pool_id,amount in walked.items()})
        self.assertGreater(Fraction(walked[self.eth_token],10**18)*4000,10000)

    def test_an_initialized_tick_in_the_band_changes_the_liquidity_on_the_way(self):
        # Six hundred ticks below the price, within the 10% band a sale of WETH walks down.
        crossed=(tick_at_sqrt(WETH_USDC_SQRT)//60-10)*60
        pool=v3_pool(self.fake,WETH,USDC,3000,60,sqrt=WETH_USDC_SQRT,liquidity=10**18,ticks={crossed:10**18//2})
        found,_=read(self.fake,[pool])
        flat=Chain();v3_pool(flat,WETH,USDC,3000,60,sqrt=WETH_USDC_SQRT,liquidity=10**18)
        without,_=read(flat,[pool])
        # Crossing it downwards takes its net liquidity out: less USDC is released than without it.
        self.assertLess(found.depths[pool][0],without.depths[pool][0])
        self.assertIn((pool,sel('ticks(int24)'),encode(['int24'],[crossed])),self.fake.subcalls)
        self.assertEqual(self.fake.methods()[-1],'eth_call')
        self.assertEqual(len(self.fake.rounds),3)

    def test_a_walk_past_the_policy_s_steps_is_unmeasured(self):
        spot=tick_at_sqrt(WETH_USDC_SQRT)//10
        ticks={(spot-1-n)*10:1 for n in range(4)}
        pool=v3_pool(self.fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18,ticks=ticks)
        policy=copy.deepcopy(POLICY);policy['referenceDepth']['maxSteps']=3
        found,_=read(self.fake,[pool],policy=policy)
        self.assertEqual(found.depths[pool],(None,'walk_exceeds_max_steps'))
        # Nothing past the steps is read: no tick of that pool.
        self.assertFalse([key for key in self.fake.subcalls if key[1]==sel('ticks(int24)')])
        # Two ticks in the band and four above the price, in the same words: a sale walks down through two.
        fake=Chain()
        above={(spot+1+n)*10:1 for n in range(4)}
        pool=v3_pool(fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18,ticks={**above,(spot-1)*10:1,(spot-2)*10:1})
        found,_=read(fake,[pool],policy=policy)
        self.assertIsNone(found.depths[pool][1])
        self.assertEqual(sorted(key[2] for key in fake.subcalls if key[1]==sel('ticks(int24)')),
                         sorted(encode(['int24'],[tick]) for tick in ((spot-1)*10,(spot-2)*10)))

    def test_a_token_s_code_is_judged_as_on_robinhood(self):
        clone='0x'+'c1'*20;target='0x'+'c2'*20
        self.fake.codes[clone]='0x363d3d373d3d3d363d73'+target[2:]+'5af43d82803e903d91602b57fd5bf3'
        self.fake.codes[target]=PLAIN(target)
        token(self.fake,clone,'CLONE',code=self.fake.codes[clone])
        empty='0x'+'e0'*20
        pools=[v4_pool(self.fake,(ZERO,other,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=1)
               for other in (CBBTC,clone,empty)]
        found,_=read(self.fake,pools)
        self.assertEqual(found.tokens[CBBTC]['proxy'],'delegatecall')
        self.assertEqual((found.tokens[clone]['proxy'],found.tokens[clone]['implementation']),(None,target))
        self.assertEqual(found.tokens[empty],{'address':empty,'code':False})
        self.assertEqual(found.tokens[CBBTC]['codeHash'],'0x'+keccak(bytes.fromhex(PROXY[2:])).hex())
        # A clone of an empty account, or of code that delegates, is upgradeable.
        for target_code in ('0x',PROXY):
            fake=Chain();hollow='0x'+'c3'*20
            fake.codes[target]=target_code
            token(fake,hollow,'HOLLOW',code='0x363d3d373d3d3d363d73'+target[2:]+'5af43d82803e903d91602b57fd5bf3')
            pool=v4_pool(fake,(ZERO,hollow,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=1)
            with self.subTest(target=target_code):
                self.assertEqual(read(fake,[pool])[0].tokens[hollow]['proxy'],'delegatecall')
        # An answer that is not code is the provider's failure, never a token without code.
        fake=Chain();token(fake,TOKEN,'TOKEN',code='0xzz')
        pool=v4_pool(fake,(ZERO,TOKEN,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=1)
        with self.assertRaisesRegex(DataError,'token_code_unavailable'):read(fake,[pool])

    def test_the_depth_reads_stay_within_their_bounds(self):
        # Past the words or the ticks one selection may read, a pool is unmeasured, and nothing past them is read.
        crossed=(tick_at_sqrt(WETH_USDC_SQRT)//60-10)*60
        ticked=v3_pool(self.fake,WETH,USDC,3000,60,sqrt=WETH_USDC_SQRT,liquidity=10**18,ticks={crossed:1})
        # Pools take the words in id order, two each here: the 0.3% pool's first; the 0.05% pool's would pass three.
        self.assertLess(ticked,self.weth_usdc)
        with unittest.mock.patch.object(evidence,'DEPTH_WORDS',3):
            found,_=read(self.fake,[self.weth_usdc,ticked])
        self.assertEqual(found.depths[self.weth_usdc],(None,'depth_read_limit'))
        self.assertEqual(found.depths[ticked][1],None)
        fake=Chain();ticked=v3_pool(fake,WETH,USDC,3000,60,sqrt=WETH_USDC_SQRT,liquidity=10**18,ticks={crossed:1})
        with unittest.mock.patch.object(evidence,'DEPTH_TICKS',0):
            found,_=read(fake,[ticked])
        self.assertEqual(found.depths[ticked],(None,'depth_read_limit'))
        self.assertEqual(len(fake.rounds),2)

    def test_any_failed_round_fails_the_read(self):
        for failing in ('eth_getBlockByNumber','eth_call','eth_getCode'):
            fake=Chain();token(fake,TOKEN,'TOKEN')
            pool=v4_pool(fake,(ZERO,TOKEN,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=1)
            fake.fail={(CHAINSTACK,failing):'http_503',(ALCHEMY,failing):'http_503'}
            with self.subTest(failing=failing),self.assertRaises(DataError):
                read(fake,[pool])
        # A bitmap word that does not decode is a failed read, never an empty word.
        fake=Chain();pool=v3_pool(fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=1)
        low,high=evidence.band_ticks({'sqrtPriceX96':str(WETH_USDC_SQRT),'tick':tick_at_sqrt(WETH_USDC_SQRT),
                                      'poolKey':{'tick_spacing':10}},True,Fraction(1,10))
        fake.answers[(pool,sel('tickBitmap(int16)'),encode(['int16'],[low>>8]))]=(False,b'')
        with self.assertRaisesRegex(DataError,'chain_read_failed'):read(fake,[pool])
        # Nor is an initialized tick that does not decode an empty one.
        fake=Chain();crossed=(tick_at_sqrt(WETH_USDC_SQRT)//60-10)*60
        pool=v3_pool(fake,WETH,USDC,3000,60,sqrt=WETH_USDC_SQRT,liquidity=1,ticks={crossed:1})
        fake.answers[(pool,sel('ticks(int24)'),encode(['int24'],[crossed]))]=(False,b'')
        with self.assertRaisesRegex(DataError,'chain_read_failed'):read(fake,[pool])

    def test_a_head_far_behind_the_chain_is_refused(self):
        fake=Chain(age=evidence.HEAD_MAX_AGE_SECONDS+1)
        with self.assertRaisesRegex(DataError,'chain_head_stale'):read(fake,[self.weth_usdc])
        read(Chain(age=evidence.HEAD_MAX_AGE_SECONDS),[self.weth_usdc])

    def test_chainstack_first_then_alchemy_and_never_beyond_the_budget(self):
        self.fake.fail={(CHAINSTACK,'eth_getBlockByNumber'):'http_503'}
        found,rpc=read(self.fake,[self.weth_usdc])
        self.assertEqual([url for url,_,_ in self.fake.log][:2],[CHAINSTACK,ALCHEMY])
        self.assertTrue(all(url==ALCHEMY for url,_,_ in self.fake.log[1:]))
        self.assertIn(self.weth_usdc,found.pools)
        # The head, the identity round and the bitmap round: a third billed call past a budget of two is never sent.
        fake=Chain();v3_pool(fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18)
        with self.assertRaisesRegex(DataError,'request_budget_exhausted'):
            read(fake,[self.weth_usdc],budget=2)
        self.assertEqual(fake.methods(),['eth_getBlockByNumber','eth_call'])


class NoChainlinkEvidenceTests(unittest.TestCase):
    """A chain Chainlink does not serve (v2_hype_chain's synthetic HYPE chain): the evidence's native USD is the spot
    of the pool its profile names, qualified as the chain reads qualify it (v2_chain_reads.survey), read before round
    1; a read whose depth round fails is no read."""

    @classmethod
    def setUpClass(cls):
        import shutil
        import tempfile
        import v2_hype_chain as hype
        directory=tempfile.mkdtemp(prefix='domino-hype-')
        try:
            cls.registry=hype.registry(directory)
        finally:
            shutil.rmtree(directory)
        cls.hype,cls.chain=hype,cls.registry.chain(hype.CHAIN_ID)
        cls.whype,cls.usdc=hype.WHYPE.lower(),hype.USDC.lower()

    def fake(self,liquidity=None):
        """The chain's provider, no feed to script; with `liquidity`, HYPE at US$ 40 in its WHYPE/USDC 0.05% pool."""
        with unittest.mock.patch(f'{__name__}.feed'):
            fake=Chain(self.chain)
        if liquidity is not None:
            low,high=sorted((self.whype,self.usdc))
            price=Fraction(40*10**6,10**18) if low==self.whype else Fraction(10**18,40*10**6)
            self.pool=v3_pool(fake,low,high,500,10,sqrt=sqrt_of(price),liquidity=liquidity)
        return fake

    def rpc(self,fake,budget=64):
        entry=lambda name,url:{'name':name,'host':f'{name}.example.invalid','url':url,'archive':True,'maxBatchItems':100,
                               'maxLogBlocks':10000,'requestsPerSecond':None}
        document={'schemaVersion':1,'kind':'domino-v2-chain-rpc',
                  'chains':{self.chain.key:{'endpoints':[entry('chainstack',CHAINSTACK),entry('alchemy',ALCHEMY)]}}}
        endpoints=configured_endpoints(self.chain,chain_rpc_config=checked_chain_rpc_config(document,self.registry,environ={}),
                                       send=fake)
        return ChainReadRpc(endpoints,batch_reads=True,max_requests=budget)

    def test_the_native_price_is_the_profile_pool_s_spot_once_it_qualifies(self):
        fake=self.fake(10**18)
        found=evidence.pools(self.chain,self.rpc(fake),[self.pool],now=NOW)
        usd,entry,reason=found.eth
        self.assertTrue(Fraction(39)<usd<Fraction(41),usd)
        self.assertEqual((entry,reason),(None,None))  # no feed's round on this chain
        self.assertEqual(found.pools[self.pool]['pool']['currencies'],sorted((self.whype,self.usdc)))
        # The head, the pool's state, its words within the band, then round 1; no Chainlink round anywhere.
        self.assertEqual(fake.methods(),['eth_getBlockByNumber','eth_call','eth_call','eth_call'])
        self.assertNotIn(sel('latestRoundData()'),{call[1] for call in fake.subcalls})

    def test_a_shallow_or_absent_pool_prices_nothing_and_a_failed_depth_round_fails_the_read(self):
        for case,fake in (('shallow',self.fake(10**12)),('absent',self.fake())):
            with self.subTest(case=case):
                self.assertEqual(evidence.pools(self.chain,self.rpc(fake),[],now=NOW).eth,
                                 (None,None,'no_qualified_price_source'))
        # The head and the pool's state fit the budget; its words do not come, so nothing is judged.
        fake=self.fake(10**18)
        with self.assertRaisesRegex(DataError,'^chain_read_failed$'):
            evidence.pools(self.chain,self.rpc(fake,budget=2),[],now=NOW)


if __name__=='__main__':unittest.main()
