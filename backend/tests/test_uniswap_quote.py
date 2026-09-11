import copy
from decimal import Decimal
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, DataError, KEY_TYPES, ZERO, json_http
from eth_abi import encode
from eth_hash.auto import keccak
from uniswap_quote import (ENDPOINT, MAX_HOPS, MAX_PATHS, TIMEOUT_SECONDS,
                           TRADING_QUOTE_HEADERS, UniswapQuote)

A, B, C, OWNER, OTHER = ['0x' + digit * 40 for digit in '12345']
KEY = 'offline-private-header-canary'


def hop(a=A, b=B, incoming='1000', outgoing='2000', *, fee=3000, spacing=60):
    pair = (*sorted((a, b)), fee, spacing, ZERO)
    row = {'type': 'v4-pool', 'address': '0x' + keccak(encode(KEY_TYPES, pair)).hex(),
        'tokenIn': {'address': a, 'chainId': 4663, 'decimals': '18'},
        'tokenOut': {'address': b, 'chainId': 4663, 'decimals': '18'},
        'fee': str(fee), 'tickSpacing': str(spacing), 'hooks': ZERO}
    if incoming is not None:
        row['amountIn'] = incoming
    if outgoing is not None:
        row['amountOut'] = outgoing
    return row


def payload():
    return {'routing': 'CLASSIC', 'quote': {'chainId': 4663, 'swapper': OWNER,
        'tradeType': 'EXACT_INPUT', 'slippage': Decimal('0.5'),
        'input': {'token': A, 'amount': '1000'},
        'output': {'token': B, 'amount': '2000', 'minimumAmount': '1990', 'recipient': OWNER},
        'route': [[hop()]], 'portionBips': 0, 'portionAmount': '0',
        'gasFee': '10000000000000', 'gasUseEstimate': '192161', 'gasFeeUSD': '0.07',
        'priceImpact': Decimal('0.03'), 'blockNumber': '59031060', 'txFailureReasons': []},
        'permitData': {'privateCanary': KEY}, 'permitTransaction': {'data': KEY},
        'isTokenApprovalApplicable': True, 'requestId': KEY}


class Transport:
    def __init__(self, data=None, error=None):
        self.data = payload() if data is None else data
        self.error, self.calls = error, []

    def __call__(self, url, body, **options):
        self.calls.append((url, copy.deepcopy(body), options))
        if self.error:
            raise self.error
        return copy.deepcopy(self.data)


class QuoteTests(unittest.TestCase):
    def preview(self, data=None, transport=None, clock=lambda: 1000.5, **overrides):
        transport = transport or Transport(data)
        args = dict(owner=OWNER, token_in=A, token_out=B, amount_raw='1000',
                    slippage_bps=50, max_price_impact_bps=100)
        args.update(overrides)
        return UniswapQuote(KEY, transport=transport, clock=clock).preview(**args)

    def test_exact_request_and_non_executable_projection(self):
        transport = Transport()
        result = self.preview(transport=transport)
        self.assertEqual(len(transport.calls), 1)
        url, body, opts = transport.calls[0]
        self.assertEqual(url, ENDPOINT)
        self.assertEqual(body, {'type': 'EXACT_INPUT', 'amount': '1000',
            'tokenInChainId': 4663, 'tokenOutChainId': 4663, 'tokenIn': A, 'tokenOut': B,
            'swapper': OWNER, 'recipient': OWNER, 'slippageTolerance': .5,
            'routingPreference': 'BEST_PRICE', 'protocols': ['V4'], 'hooksOptions': 'V4_NO_HOOKS',
            'generatePermitAsTransaction': False, 'permitAmount': 'EXACT'})
        self.assertEqual(opts, {'timeout': TIMEOUT_SECONDS,
            'headers': {'x-api-key': KEY, **TRADING_QUOTE_HEADERS}})
        self.assertEqual(result['quote']['outputAfterProviderFeeRaw'], '2000')
        self.assertEqual(result['quote']['policyMinimumOutputRaw'], '1990')
        self.assertEqual(result['expiresAt'], 1030)
        self.assertEqual(result['previewChecks']['status'], 'within_observed_limits')
        self.assertFalse(result['executionAvailable'])
        self.assertFalse(result['simulation']['independentSuccessProven'])
        self.assertFalse(result['provenance']['onchainSnapshotVerified'])
        self.assertIsNone(result['dominoFee']['amountRaw'])
        encoded = json.dumps(result)
        for excluded in (KEY, 'permitData', 'permitTransaction', 'quoteId', 'calldata'):
            self.assertNotIn(excluded, encoded)

    def test_invalid_input_does_not_contact_provider(self):
        for values in ({'owner': ZERO}, {'owner': 'malicious'}, {'token_out': A},
                       {'amount_raw': '0'}, {'amount_raw': '01'}, {'amount_raw': 1000},
                       {'amount_raw': str(2**256)}, {'amount_raw': '1e18'},
                       {'slippage_bps': True}, {'slippage_bps': 10000}, {'slippage_bps': -1},
                       {'max_price_impact_bps': 10001}, {'chain_id': 4663.0}, {'chain_id': 1}):
            transport = Transport()
            with self.subTest(values=values), self.assertRaises(DataError):
                self.preview(transport=transport, **values)
            self.assertFalse(transport.calls)

    def test_substitutions_fail_closed(self):
        for field, value in (('chainId', 1), ('chainId', 4663.0), ('swapper', OTHER),
                             ('tradeType', 'EXACT_OUTPUT'), ('slippage', Decimal('.51'))):
            data = payload(); data['quote'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(DataError):
                self.preview(data)
        for side, field, value in (('input', 'token', C), ('input', 'amount', '1001'),
                ('input', 'maximumAmount', '1001'), ('output', 'token', C),
                ('output', 'recipient', OTHER), ('output', 'minimumAmount', '1989'),
                ('output', 'minimumAmount', '2001'), ('output', 'amount', str(2**256))):
            data = payload(); data['quote'][side][field] = value
            with self.subTest(side=side, field=field), self.assertRaises(DataError):
                self.preview(data)

    def test_zero_slippage_and_stricter_provider_floor(self):
        data = payload(); data['quote']['slippage'] = 0
        data['quote']['output']['minimumAmount'] = '2000'
        self.assertEqual(self.preview(data, slippage_bps=0)['quote']['policyMinimumOutputRaw'], '2000')
        data = payload(); data['quote']['output']['minimumAmount'] = '1991'
        self.assertEqual(self.preview(data)['quote']['minimumAfterProviderFeeRaw'], '1991')

    def test_fractional_minimum_uses_floor_at_rounding_boundary(self):
        data = payload()
        data['quote']['output']['amount'] = '2001'
        data['quote']['route'][0][0]['amountOut'] = '2001'
        # 2001 * 9950 / 10000 = 1990.995: rounding would reject this valid floor.
        result = self.preview(data)
        self.assertEqual(result['quote']['policyMinimumOutputRaw'], '1990')
        self.assertEqual(result['quote']['grossMinimumOutputAmountRaw'], '1990')
        data['quote']['output']['minimumAmount'] = '1989'
        with self.assertRaisesRegex(DataError, '^uniswap_quote_minimum_output_mismatch$'):
            self.preview(data)

    def test_large_raw_amounts_and_split_routes_conserve_exactly(self):
        large = 2**200 + 199
        data = payload(); quote = data['quote']
        quote['input']['amount'] = str(large)
        quote['output'].update(amount=str(large * 2), minimumAmount=str(large*2*9950//10000))
        quote['route'] = [[hop(incoming=str(large-1), outgoing=str((large-1)*2))],
                          [hop(incoming='1', outgoing='2', fee=500, spacing=10)]]
        result = self.preview(data, amount_raw=str(large))
        self.assertEqual(result['quote']['outputAfterProviderFeeRaw'], str(large*2))
        quote['route'][1][0]['amountOut'] = '3'
        with self.assertRaisesRegex(DataError, 'route_amount_mismatch'):
            self.preview(data, amount_raw=str(large))

    def test_multihop_boundary_amounts_and_decimals(self):
        data = payload(); data['quote']['route'] = [[hop(A,C,'1000',None), hop(C,B,None,'2000')]]
        result = self.preview(data)
        self.assertIsNone(result['quote']['routes'][0][0]['amountOutRaw'])
        self.assertIsNone(result['quote']['routes'][0][1]['amountInRaw'])
        data['quote']['route'][0][1]['tokenIn']['decimals'] = '6'
        with self.assertRaisesRegex(DataError, 'decimals_mismatch'):
            self.preview(data)

    def test_explicit_intermediate_amounts_must_agree(self):
        data = payload(); data['quote']['route'] = [[hop(A,C,'1000','1900'),hop(C,B,'1899','2000')]]
        with self.assertRaisesRegex(DataError, 'route_amount_mismatch'):
            self.preview(data)

    def test_disconnected_route_fails_without_intermediate_amount_conflict(self):
        data = payload()
        data['quote']['route'] = [[hop(A, C, '1000', None), hop(A, B, None, '2000')]]
        with self.assertRaisesRegex(DataError, '^uniswap_quote_route_disconnected$'):
            self.preview(data)

    def test_currency_cycle_fails_without_pool_reuse_or_amount_conflict(self):
        data = payload()
        data['quote']['route'] = [[hop(A, C, '1000', None),
            hop(C, A, None, None, fee=500), hop(A, B, None, '2000')]]
        with self.assertRaisesRegex(DataError, '^uniswap_quote_route_disconnected$'):
            self.preview(data)

    def test_route_parameters_hash_and_token_scope(self):
        for field, value in (('hooks', OTHER), ('fee', '8388608'), ('tickSpacing', '61'),
                ('address', '0x'+'ff'*32), ('type', 'v3-pool'), ('fee', True), ('tickSpacing', 60.1)):
            data = payload(); data['quote']['route'][0][0][field] = value
            with self.subTest(field=field), self.assertRaises(DataError):
                self.preview(data)
        data = payload(); data['quote']['route'][0][0]['tokenIn']['sellFeeBps'] = '1'
        with self.assertRaisesRegex(DataError, 'transfer_tax_unsupported'):
            self.preview(data)
        data = payload(); data['quote']['route'][0][0]['tokenIn']['symbol'] = KEY
        data['quote']['route'][0][0]['tokenIn'].pop('decimals')
        self.assertIsNone(self.preview(data)['quote']['routes'][0][0]['tokenIn']['decimals'])

    def test_route_size_reuse_and_discontinuity(self):
        for routes in ([], [[hop()]]*(MAX_PATHS+1), [[hop()]*(MAX_HOPS+1)],
                       [[hop()],[hop()]], [[hop(A,C),hop(A,B)]]):
            data = payload(); data['quote']['route'] = routes
            with self.subTest(routes=len(routes)), self.assertRaises(DataError):
                self.preview(data)

    def test_native_currency_is_exact_identity(self):
        data = payload(); data['quote']['input']['token'] = ZERO
        data['quote']['route'] = [[hop(ZERO,B)]]
        self.assertEqual(self.preview(data,token_in=ZERO)['request']['tokenIn'], ZERO)
        data['routing'] = 'WRAP'
        with self.assertRaisesRegex(DataError, 'route_unsupported'):
            self.preview(data,token_in=ZERO)

    def test_fee_missing_zero_nonzero_and_fractional_basis_points(self):
        data = payload(); quote = data['quote']
        quote.pop('portionBips'); quote.pop('portionAmount')
        result = self.preview(data)
        self.assertEqual(result['providerOutputFee']['status'], 'unknown')
        self.assertIsNone(result['quote']['outputAfterProviderFeeRaw'])
        quote.update(portionBips=Decimal('87.5'), portionAmount='17', portionRecipient=OTHER)
        result = self.preview(data)
        self.assertEqual(result['providerOutputFee']['bps'],'87.5')
        self.assertEqual(result['providerOutputFee']['status'],'unsupported_nonzero')
        self.assertEqual(result['quote']['grossOutputAmountRaw'],'2000')
        self.assertIsNone(result['quote']['outputAfterProviderFeeRaw'])
        quote['portionBips'] = 0
        with self.assertRaisesRegex(DataError, 'invalid_uniswap_quote_fee'):
            self.preview(data)

    def test_aggregated_outputs_reconcile_legacy_fee_fields(self):
        data = payload(); quote=data['quote']
        quote.update(portionBips=100,portionAmount='20',portionRecipient=OTHER)
        quote['aggregatedOutputs'] = [
            {'token':B,'recipient':OWNER,'amount':'1980','minAmount':'1970','bps':9900},
            {'token':B,'recipient':OTHER,'amount':'20','minAmount':'20','bps':100}]
        self.assertEqual(self.preview(data)['providerOutputFee']['status'],'unsupported_nonzero')
        for side, field, value in ((0,'token',C),(1,'recipient',C),(1,'amount','19'),
                                  (1,'bps',101),(0,'fee','INTEGRATOR')):
            bad=copy.deepcopy(data); bad['quote']['aggregatedOutputs'][side][field]=value
            with self.subTest(field=field), self.assertRaises(DataError):
                self.preview(bad)

    def test_complete_owner_output_proves_zero_without_inventing_legacy_fields(self):
        data=payload(); quote=data['quote']
        quote.pop('portionBips'); quote.pop('portionAmount')
        quote['aggregatedOutputs']=[{'token':B,'recipient':OWNER,'amount':'2000','minAmount':'1990','bps':10000}]
        result=self.preview(data)
        self.assertEqual(result['providerOutputFee']['status'],'reported_zero')
        self.assertEqual(result['providerOutputFee']['zeroEvidence'],'aggregated_outputs')
        self.assertIsNone(result['providerOutputFee']['bps'])
        self.assertIsNone(result['providerOutputFee']['amountRaw'])
        self.assertEqual(result['quote']['outputAfterProviderFeeRaw'],'2000')
        quote['aggregatedOutputs'][0].pop('bps')
        self.assertEqual(self.preview(data)['providerOutputFee']['status'],'unknown')
        quote['aggregatedOutputs'][0]['bps']=10000
        quote['portionBips']=1
        with self.assertRaises(DataError):self.preview(data)

    def test_price_impact_gate_unknown_and_signed_improvement(self):
        for value, reason in ((None,'price_impact_unknown'), (Decimal('1.01'),'price_impact_exceeded')):
            data=payload();data['quote']['priceImpact']=value
            self.assertIn(reason,self.preview(data)['previewChecks']['reasons'])
        data=payload();data['quote']['priceImpact']=Decimal('-0.01')
        self.assertEqual(self.preview(data)['quote']['priceImpactPercent'],'-0.01')
        for value in (True, float('nan'), 'Infinity', '-101', '1e100000', 'invalid'):
            data['quote']['priceImpact']=value
            with self.subTest(value=value),self.assertRaises(DataError):self.preview(data)

    def test_simulation_gas_unknown_and_zero_are_not_success_or_paid_costs(self):
        data=payload();quote=data['quote'];quote.pop('txFailureReasons')
        for key in ('gasFee','gasUseEstimate','gasFeeUSD'):quote.pop(key)
        data.pop('isTokenApprovalApplicable')
        result=self.preview(data)
        self.assertEqual(result['simulation']['status'],'unknown')
        self.assertIsNone(result['gas']['feeWei'])
        self.assertIsNone(result['approvalApplicable'])
        quote.update(gasFee='0',gasUseEstimate='0',gasFeeUSD='0',txFailureReasons=['TRANSFER_FROM_FAILED'])
        result=self.preview(data)
        self.assertEqual(result['gas']['feeWei'],'0')
        self.assertIn('provider_simulation_failed',result['previewChecks']['reasons'])
        quote['txFailureReasons']=[KEY]
        with self.assertRaises(DataError) as caught:self.preview(data)
        self.assertNotIn(KEY,str(caught.exception))

    def test_expired_backwards_clock_and_invalid_start(self):
        for ticks in ([1000.5,1030.0],[1000,999],[1000,1030]):
            times=iter(ticks)
            with self.subTest(ticks=ticks),self.assertRaisesRegex(DataError,'expired'):
                self.preview(clock=lambda:next(times))
        for tick in (float('inf'),float('nan'),-1,True):
            transport=Transport()
            with self.subTest(tick=tick),self.assertRaises(DataError):
                self.preview(clock=lambda:tick,transport=transport)
            self.assertFalse(transport.calls)

    def test_absolute_deadline_is_enforced_for_custom_transport(self):
        now=[0]
        def transport(*args,**kwargs):now[0]=13;return payload()
        with patch('read_deadline.time.monotonic',lambda:now[0]),self.assertRaisesRegex(DataError,'deadline'):
            self.preview(transport=transport)

    def test_fixed_errors_and_one_attempt(self):
        for error,expected in ((DataError('http_429'),'uniswap_quote_rate_limited'),
            (DataError('http_404'),'uniswap_quote_no_route'),
            (DataError('http_401'),'uniswap_quote_credentials_rejected'),
            (RuntimeError(KEY),'uniswap_quote_unavailable'),(DataError(KEY),'uniswap_quote_unavailable')):
            transport=Transport(error=error)
            with self.subTest(error=type(error).__name__),self.assertRaises(DataError) as caught:
                self.preview(transport=transport)
            self.assertEqual(str(caught.exception),expected)
            self.assertEqual(len(transport.calls),1)

    def test_fingerprint_binds_review_inputs(self):
        original=self.preview()['requestFingerprint']
        changed=self.preview(max_price_impact_bps=200)['requestFingerprint']
        self.assertNotEqual(original,changed)
        self.assertEqual(len(original),64)

    def test_transport_fixed_headers_only_on_fixed_quote_endpoint(self):
        calls=[]
        def opener(request,**kwargs):calls.append(request);return io.BytesIO(b'{}')
        json_http(ENDPOINT,{},headers={'x-api-key':KEY,**TRADING_QUOTE_HEADERS},opener=opener)
        self.assertEqual(calls[0].get_header('X-universal-router-version'),'2.1.1')
        for url,headers in ((ENDPOINT+'/',TRADING_QUOTE_HEADERS),
                           ('https://example.test',TRADING_QUOTE_HEADERS),
                           (ENDPOINT,{'x-universal-router-version':'2.0'}),
                           (ENDPOINT,{'x-agent-info':KEY}), (ENDPOINT,{'Authorization':KEY})):
            with self.subTest(url=url,headers=list(headers)),self.assertRaisesRegex(DataError,'invalid_private_api_header'):
                json_http(url,{},headers=headers,opener=opener)
        self.assertEqual(len(calls),1)


if __name__=='__main__':unittest.main()
