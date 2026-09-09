import json
from pathlib import Path
import random
import sys
import unittest
from decimal import Decimal
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from domain import compound_preview, money_units, money_string, position_preview

class DomainTests(unittest.TestCase):
    def test_shared_cases(self):
        cases=json.loads((Path(__file__).resolve().parents[2]/'web/tests/fixtures/compound-cases.json').read_text())
        for case in cases:
            with self.subTest(case=case['name']):
                result=compound_preview(case['input'])
                for key,value in case['expected'].items():self.assertEqual(result[key],value)

    def test_conservation_randomized(self):
        rng=random.Random(9)
        for _ in range(600):
            available=rng.randrange(1_000_000*1_000_000)
            result=compound_preview(dict(availableFeesUsd=money_string(available),positionValueUsd='1000',gasUsd='0.25'))
            net,cut,reserve=[money_units(result[key]) for key in ('reinvestedUsd','serviceFeeUsd','reserveUsd')]
            self.assertEqual(net+cut+reserve,available)
            if result['decision']=='eligible':self.assertEqual(reserve,0)
            self.assertNotIn('maxNetAdditionUsd',result)
            if result['decision']=='wait':self.assertEqual(net+cut,0)

    def test_price_outcomes(self):
        inputs=dict(amount='1000',lower='.7',upper='1.5',starting_price='1')
        start=position_preview(**inputs,scenario_price='1')
        self.assertLess(abs(Decimal(start['value'])-1000),Decimal('1e-45'))
        above=position_preview(**inputs,scenario_price='2')
        below=position_preview(**inputs,scenario_price='.5')
        self.assertEqual(Decimal(above['token']),0)
        self.assertEqual(Decimal(below['stable']),0)
        self.assertLess(Decimal(above['value']),Decimal(above['holdValue']))

    def test_reject_invalid_money(self):
        for value in [None,True,1,'NaN','-1','1e3','1.1234567','1000000000',{},' 1']:
            with self.subTest(value=value),self.assertRaises(ValueError):money_units(value)

    def test_principal_and_unknown_fields_are_not_fee_input(self):
        with self.assertRaises(ValueError):compound_preview(dict(availableFeesUsd='20',positionValueUsd='1000',gasUsd='.25',owner='wallet'))

if __name__=='__main__':unittest.main()
