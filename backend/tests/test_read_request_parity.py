"""Limits and relational boundaries for every public read request family."""
import json
from pathlib import Path
import sys
import unittest

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from read_api import (TokenRequest, PoolsRequest, PoolMarketRequest, AssetsRequest,
                      NftPositionsRequest, CatalogueRequest, ActivityRequest)
from read_contract import ENABLED_READS
from read_request_fixtures import request_boundaries

MODELS={'token':TokenRequest,'pools':PoolsRequest,'pool-market':PoolMarketRequest,
        'wallet-assets':AssetsRequest,'nft-positions':NftPositionsRequest,'catalogue':CatalogueRequest,
        'pool-activity':ActivityRequest,'pool-positions':ActivityRequest,'pool-metrics':ActivityRequest}


class ReadRequestParityTests(unittest.TestCase):
    def test_explicit_boundary_expectations_match_all_python_request_models(self):
        cases=request_boundaries()
        self.assertEqual(set(item['route'] for item in cases),set(ENABLED_READS))
        for item in cases:
            with self.subTest(route=item['route'],name=item['name']):
                original=json.loads(item['json'])
                try: MODELS[item['route']].model_validate(original)
                except ValueError: valid=False
                else: valid=True
                self.assertEqual(valid,item['valid'])
                self.assertEqual(original,json.loads(item['json']))

    def test_exported_boundary_corpus_matches_owned_fixture_source(self):
        path=Path(__file__).resolve().parents[2]/'api-contracts/read-v1/fixtures/request-boundaries.json'
        self.assertEqual(json.loads(path.read_text()),request_boundaries())
