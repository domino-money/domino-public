"""GeckoTerminal listing items read exactly like the collector's pool observation."""
import copy
from decimal import Decimal
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError
from gt_listing import GeckoListing, MAX_MULTI, listing_url, multi_url, pool_item
from market_data import GeckoMarketData

FIXTURES=Path(__file__).resolve().parent/'fixtures'
PONS='0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a'
ETH_USDG='0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e'
USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168'


def recorded(name):
    # json_http parses provider numbers as Decimal; read the recording the same way.
    return json.loads((FIXTURES/name).read_text(),parse_float=Decimal)


class Transport:
    def __init__(self,body):
        self.body,self.urls=body,[]
    def __call__(self,url,timeout=None):
        self.urls.append(url)
        return copy.deepcopy(self.body)


class ListingParseTests(unittest.TestCase):
    page=recorded('geckoterminal-listing-page1-2026-09-25.json')

    def test_every_recorded_item_is_the_collector_s_own_observation(self):
        url=listing_url(1)
        for row in self.page['data']:
            with self.subTest(pool=row['id']):
                item=pool_item(row,url=url,retrieved=1790380000)
                pool_id=item['poolId']
                collector=GeckoMarketData(transport=Transport({'data':row}),clock=lambda:1790380000).pool(pool_id)
                self.assertEqual({**item['market'],'sourceUrl':None},{**collector,'sourceUrl':None})
                self.assertEqual(item['market']['sourceUrl'],url)
                self.assertEqual(item['market']['dexLabel'],'uniswap-v4-robinhood')

    def test_the_listing_fields_the_rules_read(self):
        items={item['poolId']:item for item in
               (pool_item(row,url=listing_url(1),retrieved=1) for row in self.page['data'])}
        pons=items[PONS]['listing']
        row=next(row for row in self.page['data'] if row['id']=='robinhood_'+PONS)['attributes']
        self.assertEqual(row['pool_created_at'],'2026-07-18T01:42:13Z')
        self.assertEqual(pons['createdAt'],1784338933)
        self.assertEqual(pons['transactions24h'],{name:row['transactions']['h24'][name]
                                                  for name in ('buys','sells','buyers','sellers')})
        self.assertEqual(Decimal(pons['volume6hUsd']),Decimal(row['volume_usd']['h6']))
        self.assertEqual(Decimal(pons['baseTokenPriceQuoteToken']),Decimal(row['base_token_price_quote_token']))
        self.assertEqual(pons['name'],row['name'])
        changes=[item['listing']['priceChange24hPercent'] for item in items.values()]
        self.assertTrue(any(value.startswith('-') for value in changes),'the recording has falling prices')
        self.assertEqual(items[ETH_USDG]['market']['baseToken'],'0x'+'0'*40)

    def test_created_at_is_the_provider_utc_timestamp(self):
        row=copy.deepcopy(self.page['data'][0])
        for text,expected in (('2026-07-18T01:42:13Z',1784338933),('2026-07-18T01:42:13.5Z',1784338933)):
            row['attributes']['pool_created_at']=text
            self.assertEqual(pool_item(row,url='u',retrieved=1)['listing']['createdAt'],expected)
        for text in ('2026-07-18 01:42:13','2026-02-30T00:00:00Z','2026-07-18T01:42:13+00:00',1784338933):
            row['attributes']['pool_created_at']=text
            with self.subTest(text=text),self.assertRaisesRegex(DataError,'invalid_market_timestamp'):
                pool_item(row,url='u',retrieved=1)
        row['attributes']['pool_created_at']=None
        self.assertIsNone(pool_item(row,url='u',retrieved=1)['listing']['createdAt'])

    def test_a_signed_price_change_keeps_its_sign_and_exactness(self):
        row=copy.deepcopy(self.page['data'][0])
        for text,expected in (('-0.115','-0.115'),('12.50','12.5'),('-0','0'),('0','0')):
            row['attributes']['price_change_percentage']={'h24':text}
            self.assertEqual(pool_item(row,url='u',retrieved=1)['listing']['priceChange24hPercent'],expected)
        for text in ('--1','-1e999','1.5.5',-1.5):
            row['attributes']['price_change_percentage']={'h24':text}
            with self.subTest(text=text),self.assertRaisesRegex(DataError,'invalid_market_number'):
                pool_item(row,url='u',retrieved=1)

    def test_identity_and_count_errors_have_fixed_codes(self):
        base=self.page['data'][0]
        cases=[
            (lambda r:r.update(type='token'),'market_pool_identity_mismatch'),
            (lambda r:r.update(id='ethereum_'+r['id'][len('robinhood_'):]),'market_pool_identity_mismatch'),
            (lambda r:r['attributes'].update(address='0x'+'00'*32),'market_pool_identity_mismatch'),
            (lambda r:r['relationships']['base_token']['data'].update(id='robinhood_nope'),'market_currency_identity_mismatch'),
            (lambda r:r['relationships']['dex']['data'].update(type='pool'),'invalid_market_response'),
            (lambda r:r['attributes'].update(reserve_in_usd=1.5),'invalid_market_number'),
            (lambda r:r['attributes']['transactions']['h24'].update(buyers=-1),'invalid_market_number'),
            (lambda r:r['attributes']['transactions']['h24'].update(buys=True),'invalid_market_number'),
        ]
        for change,code in cases:
            row=copy.deepcopy(base);change(row)
            with self.subTest(code=code),self.assertRaisesRegex(DataError,'^'+code+'$'):
                pool_item(row,url='u',retrieved=1)


class ListingCallTests(unittest.TestCase):
    page=recorded('geckoterminal-listing-page1-2026-09-25.json')

    def test_a_malformed_item_is_rejected_alone(self):
        body=copy.deepcopy(self.page);body['data'][3]['attributes']['address']='0x'+'11'*32
        result=GeckoListing(transport=Transport(body),clock=lambda:5).page(1)
        self.assertEqual((len(result['items']),result['returned']),(19,20))
        self.assertEqual(result['rejected'],[{'index':3,'reason':'market_pool_identity_mismatch'}])
        self.assertEqual(result['retrievedAt'],5)

    def test_a_page_larger_than_the_provider_serves_is_refused(self):
        body=copy.deepcopy(self.page);body['data'].append(body['data'][0])
        with self.assertRaisesRegex(DataError,'invalid_market_response'):
            GeckoListing(transport=Transport(body)).page(1)
        with self.assertRaisesRegex(DataError,'invalid_market_response'):
            GeckoListing(transport=Transport({'data':{}})).page(1)

    def test_a_refused_allowance_makes_no_request(self):
        transport=Transport(self.page)
        listing=GeckoListing(transport=transport,reserve=lambda:False)
        with self.assertRaisesRegex(DataError,'provider_capacity_busy'):
            listing.page(1)
        self.assertEqual((transport.urls,listing.calls),([],0))
        allowed=GeckoListing(transport=transport,reserve=lambda:True)
        allowed.page(2)
        self.assertEqual((transport.urls,allowed.calls),([listing_url(2)],1))

    def test_urls_and_their_bounds(self):
        self.assertEqual(listing_url(10),'https://api.geckoterminal.com/api/v2/networks/robinhood/dexes/'
                         'uniswap-v4-robinhood/pools?sort=h24_volume_usd_desc&page=10')
        for page in (0,11,True,'1'):
            with self.subTest(page=page),self.assertRaisesRegex(DataError,'invalid_listing_page'):
                listing_url(page)
        self.assertEqual(multi_url([ETH_USDG,PONS,ETH_USDG.upper().replace('0X','0x')]),
                         'https://api.geckoterminal.com/api/v2/networks/robinhood/pools/multi/'+ETH_USDG+','+PONS)
        many=['0x%064x'%n for n in range(MAX_MULTI+1)]
        for ids in ([],many):
            with self.subTest(n=len(ids)),self.assertRaisesRegex(DataError,'invalid_listing_request'):
                multi_url(ids)
        self.assertTrue(multi_url(many[:MAX_MULTI]))

    def test_the_recorded_multi_call_reads_like_the_listing(self):
        body=recorded('geckoterminal-multi-2026-09-25.json')
        result=GeckoListing(transport=Transport(body),clock=lambda:9).multi([PONS,ETH_USDG])
        self.assertEqual(sorted(item['poolId'] for item in result['items']),sorted([PONS,ETH_USDG]))
        pons=next(item for item in result['items'] if item['poolId']==PONS)
        self.assertEqual(pons['market']['quoteToken'],USDG)
        self.assertEqual(pons['listing']['createdAt'],1784338933)
        self.assertEqual(result['rejected'],[])


if __name__=='__main__':unittest.main()
