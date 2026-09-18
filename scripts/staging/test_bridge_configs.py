"""Deployment-boundary regressions; no network or Cloudflare account access."""
import copy
import contextlib
import io
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch
import check_bridge_configs
from check_bridge_configs import ROOT, SERVICES, KNOWN_CONFIGS, inventory_errors, validate


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

    def test_the_read_worker_keeps_its_record_and_nothing_more(self):
        """Authorized 2026-09-18: the read Worker's hop line is retained; no other Worker's is."""
        record_only = {"enabled": True, "head_sampling_rate": 1, "logs": {"invocation_logs": False}}
        self.assertEqual(self.configs["read"]["observability"], record_only)
        refused = [
            {"enabled": False},                                   # the record would be dropped again
            {"enabled": True},
            {"enabled": True, "head_sampling_rate": 1},           # invocation logs would be kept
            {"enabled": True, "head_sampling_rate": 0.5, "logs": {"invocation_logs": False}},
            {"enabled": True, "head_sampling_rate": 1.0, "logs": {"invocation_logs": False}},
            {"enabled": True, "head_sampling_rate": 1, "logs": {"invocation_logs": True}},
            {"enabled": True, "head_sampling_rate": 1, "logs": {"invocation_logs": False, "extra": 1}},
            {"enabled": True, "head_sampling_rate": 1, "logs": {"invocation_logs": False}, "persist": False},
        ]
        for value in refused:
            with self.subTest(observability=value):
                config = copy.deepcopy(self.configs["read"])
                config["observability"] = value
                self.assertTrue(validate("read", config))
        for key, value in (("logpush", True), ("tail_consumers", [{"service": "logs"}])):
            with self.subTest(key=key):
                config = copy.deepcopy(self.configs["read"])
                config[key] = value
                self.assertTrue(validate("read", config))
        for service, original in self.configs.items():
            if service == "read":
                continue
            with self.subTest(service=service):
                config = copy.deepcopy(original)
                config["observability"] = copy.deepcopy(record_only)
                self.assertTrue(validate(service, config))

    def test_refuses_enabled_flags_secrets_and_cross_service_origins(self):
        for service, original in self.configs.items():
            variants = [
                {f"{service.upper()}_BRIDGE_ENABLED": "true"},
                {f"{service.upper()}_BRIDGE_ENABLED": False},
                {"ACCESS_CLIENT_SECRET": "synthetic-test-value"},
                {"SETUP_WALLET_ENABLED": "true"},
                {"SEQUENCE_WALLET_ENABLED": "true"},
                {"APP_ORIGIN": "https://alternate.invalid"},
                {SERVICES[service][1] or "SETUP_DEPLOYMENT_JSON": "https://other-service.invalid"},
                {"ENABLED_READS": "token"},
                {"READ_V2_BRIDGE_ENABLED": "true"},
                {"READ_V2_BRIDGE_ENABLED": False},
                {"ENABLED_V2_READS": "pool-market"},
            ]
            for update in variants:
                with self.subTest(service=service, update=update):
                    config = copy.deepcopy(original)
                    config["vars"].update(update)
                    self.assertTrue(validate(service, config))

    def test_requires_explicit_disabled_public_entry_points(self):
        for service, original in self.configs.items():
            for key in ("workers_dev", "preview_urls", "routes"):
                with self.subTest(service=service, missing=key):
                    config = copy.deepcopy(original)
                    del config[key]
                    self.assertTrue(validate(service, config))

    def test_inventory_rejects_alternate_configs_without_reading_them(self):
        self.assertEqual(inventory_errors(ROOT / "bridge"), [])
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in KNOWN_CONFIGS | {"README.md", "wrangler.toml.backup"}:
                (directory / name).touch()
            self.assertEqual(inventory_errors(directory), [])
            for name in ("wrangler.toml", "wrangler.json", "wrangler.jsonc",
                         "wrangler.production.toml", "wranglerread.toml",
                         "Wrangler.TOML", "WRANGLER.TOML", "wrangler.JSON", "Wrangler.jsonc",
                         "wrangler.production.jsonc", "wrangler.read.json"):
                with self.subTest(name=name):
                    path = directory / name
                    path.mkdir()  # Naming alone rejects even an unreadable/non-file candidate.
                    self.assertEqual(inventory_errors(directory),
                                     [f"{name}: unreviewed Worker configuration"])
                    path.rmdir()
            self.assertTrue(inventory_errors(directory / "absent"))

    def test_cli_fails_for_alternate_config_even_when_all_candidates_are_valid(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "bridge"
            directory.mkdir()
            for service in SERVICES:
                name = f"wrangler.{service}.toml"
                (directory / name).write_bytes((ROOT / "bridge" / name).read_bytes())
            for relative in ("bridge/wrangler.json", "bridge/Wrangler.TOML",
                             "bridge/wrangler.production.jsonc", "bridge/wrangler.read.json",
                             "wrangler.toml", "WRANGLER.JSONC", "wrangler.read.toml",
                             "bridge/.wrangler/deploy/config.json", ".wrangler/deploy/config.json"):
                with self.subTest(relative=relative):
                    alternate = root / relative
                    alternate.parent.mkdir(parents=True, exist_ok=True)
                    alternate.write_text('{}')
                    errors = io.StringIO()
                    with patch.object(check_bridge_configs, 'ROOT', root), \
                            contextlib.redirect_stderr(errors), contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(check_bridge_configs.main(), 1)
                        self.assertIn('unreviewed Worker configuration', errors.getvalue())
                        alternate.unlink()
                        self.assertEqual(check_bridge_configs.main(), 0)


if __name__ == "__main__":
    unittest.main()
