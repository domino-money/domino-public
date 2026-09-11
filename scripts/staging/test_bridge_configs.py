"""Deployment-boundary regressions; no network or Cloudflare account access."""
import copy
import tomllib
import unittest
from check_bridge_configs import ROOT, SERVICES, validate


class DisabledBridgeConfigs(unittest.TestCase):
    def setUp(self):
        self.configs = {}
        for service in SERVICES:
            with (ROOT / "bridge" / f"wrangler.{service}.toml").open("rb") as stream:
                self.configs[service] = tomllib.load(stream)

    def test_committed_files_remain_disabled_without_secrets_or_public_routes(self):
        for service, config in self.configs.items():
            with self.subTest(service=service):
                self.assertEqual(validate(service, config), [])

    def test_refuses_alternate_ingress_and_logging(self):
        mutations = [
            ("workers_dev", True), ("preview_urls", True),
            ("routes", [{"pattern": "domino.money/api/*"}]),
            ("route", "domino.money/api/*"),
            ("routes", [{"pattern": "bridge.domino.money", "custom_domain": True}]),
            ("env", {"preview": {"workers_dev": True}}),
            ("services", [{"binding": "UNREVIEWED", "service": "other"}]),
            ("triggers", {"crons": ["* * * * *"]}),
            ("observability", {"enabled": True}), ("observability", {"enabled": 0}),
            ("logpush", True),
            ("tail_consumers", [{"service": "logs"}]),
        ]
        for service, original in self.configs.items():
            for key, value in mutations:
                with self.subTest(service=service, key=key, value=value):
                    config = copy.deepcopy(original)
                    config[key] = value
                    self.assertTrue(validate(service, config))

    def test_refuses_enabled_flags_secrets_and_cross_service_origins(self):
        for service, original in self.configs.items():
            variants = [
                {f"{service.upper()}_BRIDGE_ENABLED": "true"},
                {f"{service.upper()}_BRIDGE_ENABLED": False},
                {"ACCESS_CLIENT_SECRET": "synthetic-test-value"},
                {"APP_ORIGIN": "https://alternate.invalid"},
                {SERVICES[service][1]: "https://other-service.invalid"},
                {"ENABLED_READS": "token"},
            ]
            for update in variants:
                with self.subTest(service=service, update=update):
                    config = copy.deepcopy(original)
                    config["vars"].update(update)
                    self.assertTrue(validate(service, config))


if __name__ == "__main__":
    unittest.main()
