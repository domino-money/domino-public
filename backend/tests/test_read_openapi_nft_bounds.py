"""NFT IDs have the same scalar bounds in OpenAPI and the request boundary."""
import copy
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from read_api import NftPositionsRequest, ReadGate, create_app
from read_contract import CONTRACT_VERSION

ROOT = Path(__file__).resolve().parents[2]
UINT256_MAX = 2**256 - 1
BOUNDARIES = [(str(value), 0 <= value <= UINT256_MAX) for value in (
    0, 1, 2**255, UINT256_MAX - 1, UINT256_MAX, UINT256_MAX + 1, 10**78 - 1, 10**78)]
BOUNDARIES += [(value, False) for value in (
    '', '00', '01', '-1', '+1', '1.0', '1e1', ' 1', '1 ', '1\n', '0\n',
    '1\r\n', '1\r', '1\u2028', '1\u2029', '１', 1, True, None)]


class NftOpenApiBoundsTests(unittest.TestCase):
    def test_openapi_pattern_search_matches_python_uint256_boundaries(self):
        schema = create_app(service=object()).openapi()['components']['schemas']['NftPositionsRequest']
        item = schema['properties']['tokenIds']['items']
        # JSON Schema pattern uses a search, not fullmatch: a trailing newline
        # must be rejected by the exported pattern itself in either case.
        self.assertEqual(item['type'], 'string')
        for value, expected in BOUNDARIES:
            with self.subTest(value=value):
                schema_valid = (isinstance(value, str)
                                and len(value) <= item.get('maxLength', float('inf'))
                                and re.search(item['pattern'], value) is not None)
                self.assertEqual(schema_valid, expected)
                try:
                    NftPositionsRequest.model_validate({'tokenIds': [value]})
                except ValueError:
                    model_valid = False
                else:
                    model_valid = True
                self.assertEqual(model_valid, expected)

    def test_checked_in_openapi_preserves_generated_nft_item_bounds(self):
        generated = create_app(service=object()).openapi()
        checked_in = json.loads((ROOT/'backend/openapi-read.json').read_text())
        self.assertEqual(checked_in['components']['schemas']['NftPositionsRequest'],
                         generated['components']['schemas']['NftPositionsRequest'])

    def test_http_accepts_zero_and_max_without_changing_the_service_input(self):
        fixture = json.loads((ROOT/'api-contracts/read-v1/fixtures/producer/nft-positions.empty.json').read_text())
        calls = []

        class Service:
            def nft_positions(self, token_ids, block_number):
                calls.append((token_ids, block_number))
                response = copy.deepcopy(fixture)
                response['items'] = [dict(fixture['items'][0], tokenId=value) for value in token_ids]
                return response

        with TestClient(create_app(service=Service(), gate=ReadGate(interval=0)),
                        base_url='http://127.0.0.1:8876') as client:
            ids = ['0', str(UINT256_MAX)]
            response = client.post('/v1/read/nft-positions', json={'tokenIds': ids, 'blockNumber': 700})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(calls, [(ids, 700)])
            self.assertEqual([item['tokenId'] for item in response.json()['items']], ids)
            self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            for value, valid in BOUNDARIES:
                if valid:
                    continue
                with self.subTest(value=value):
                    response = client.post('/v1/read/nft-positions', json={'tokenIds': [value]})
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(response.json(), {'error': 'invalid_request'})
                    self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
                    self.assertEqual(response.headers['cache-control'], 'no-store')
                    self.assertEqual(calls, [(ids, 700)])
