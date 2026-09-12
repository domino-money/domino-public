import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preview_metrics
from read_deadline import current_read_deadline


POOL = '0x' + 'a' * 64


class MetricsPreviewTests(unittest.TestCase):
    def invoke(self, args):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = preview_metrics.main(args)
        return code, output.getvalue(), errors.getvalue()

    def test_live_read_has_budget_and_never_requests_chart_or_wallet(self):
        service = Mock(spec=['pool_market'])
        def read(pool_id, **kwargs):
            self.assertIsNotNone(current_read_deadline())
            self.assertLessEqual(current_read_deadline().remaining(), 30)
            return {'synthetic': 'market'}
        service.pool_market.side_effect = read
        with patch.object(preview_metrics, 'load_config', return_value={}), \
                patch.object(preview_metrics, 'ReadService', return_value=service), \
                patch.object(preview_metrics, 'estimate_pool_apr', return_value={'status': 'estimate'}) as calculate:
            code, output, errors = self.invoke(['pool', '--pool-id', POOL])
        self.assertEqual((code, errors), (0, ''))
        self.assertEqual(json.loads(output), {'status': 'estimate'})
        service.pool_market.assert_called_once_with(POOL, include_price_history=False)
        self.assertEqual(calculate.call_args.args, ({'synthetic': 'market'},))
        self.assertIsNone(current_read_deadline())

    def test_offline_reproduction_never_loads_config_or_calls_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            path.write_text('{"example": "synthetic"}')
            with patch.object(preview_metrics, 'load_config') as load, \
                    patch.object(preview_metrics, 'ReadService') as service, \
                    patch.object(preview_metrics, 'calculate_performance', return_value={'status': 'measuring'}) as calculate:
                code, output, errors = self.invoke(['managed', '--input', str(path), '--now', '100'])
            self.assertEqual((code, errors), (0, ''))
            self.assertEqual(json.loads(output)['status'], 'measuring')
            calculate.assert_called_once_with({'example': 'synthetic'}, now=100)
            load.assert_not_called()
            service.assert_not_called()

    def test_invalid_live_modes_stop_before_network(self):
        for args in (['managed', '--pool-id', POOL], ['pool', '--pool-id', POOL, '--now', '100'],
                     ['pool', '--pool-id', 'private-malformed-value'],
                     ['pool', '--pool-id', POOL, '--api-key', 'private-malformed-value']):
            with self.subTest(args=args), patch.object(preview_metrics, 'load_config') as load:
                code, output, errors = self.invoke(args)
                self.assertEqual((code, output), (2, ''))
                self.assertEqual(json.loads(errors), {'status': 'unavailable', 'reason': 'metrics_preview_failed'})
                self.assertNotIn('private-malformed-value', errors)
                load.assert_not_called()

    def test_provider_error_is_sanitized_and_budget_context_removed(self):
        service = Mock(spec=['pool_market'])
        service.pool_market.side_effect = ValueError('private-provider-response')
        with patch.object(preview_metrics, 'load_config', return_value={}), \
                patch.object(preview_metrics, 'ReadService', return_value=service):
            code, output, errors = self.invoke(['pool', '--pool-id', POOL])
        self.assertEqual((code, output), (2, ''))
        self.assertNotIn('private-provider-response', errors)
        self.assertIsNone(current_read_deadline())

    def test_json_rejects_ambiguous_numbers_duplicates_and_oversize(self):
        payloads = ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":1.2}',
                    '{"a":1e3}', '[]', ' ' * (preview_metrics.MAX_INPUT_BYTES + 1))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            for payload in payloads:
                with self.subTest(prefix=payload[:30]):
                    path.write_text(payload)
                    with self.assertRaises(ValueError):
                        preview_metrics.read_evidence(path)


if __name__ == '__main__':
    unittest.main()
