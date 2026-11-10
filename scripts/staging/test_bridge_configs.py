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
from check_bridge_configs import (ROOT, SERVICES, KNOWN_CONFIGS, GATE_CONFIG, PREVIEW_ALIAS, PREVIEW_SERVICES,
                                  flag_prefix, inventory_errors, validate, validate_gate)


class DisabledBridgeConfigs(unittest.TestCase):
    def setUp(self):
        self.configs = {}
        for service in SERVICES:
            with (ROOT / "bridge" / f"wrangler.{service}.toml").open("rb") as stream:
                self.configs[service] = tomllib.load(stream)

    def test_the_wide_scan_gate_is_its_reviewed_shape_and_nothing_more(self):
        """2026-10-02: a Durable Object the Pages Functions bind; no ingress, no variable, one class."""
        with (ROOT / "bridge" / GATE_CONFIG).open("rb") as stream:
            gate = tomllib.load(stream)
        self.assertEqual(validate_gate(gate), [])
        mutations = [
            ("workers_dev", True), ("preview_urls", True),
            ("routes", [{"pattern": "domino.money/api/*"}]),
            ("vars", {"X": "1"}),
            ("services", [{"binding": "UNREVIEWED", "service": "other"}]),
            ("triggers", {"crons": ["* * * * *"]}),
            ("observability", {"enabled": True}), ("logpush", True),
            ("durable_objects", {"bindings": [{"name": "WIDE_GATE", "class_name": "Other"}]}),
            ("durable_objects", {"bindings": [{"name": "WIDE_GATE", "class_name": "WideGate", "script_name": "other"}]}),
            ("migrations", [{"tag": "v1", "new_sqlite_classes": ["WideGate"]}, {"tag": "v2", "deleted_classes": ["WideGate"]}]),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                config = copy.deepcopy(gate)
                config[key] = value
                self.assertTrue(validate_gate(config))
        for key in list(gate):
            with self.subTest(missing=key):
                config = copy.deepcopy(gate)
                del config[key]
                self.assertTrue(validate_gate(config))

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
                {f"{flag_prefix(service)}_BRIDGE_ENABLED": "true"},
                {f"{flag_prefix(service)}_BRIDGE_ENABLED": False},
                {"ACCESS_CLIENT_SECRET": "synthetic-test-value"},
                {"SETUP_WALLET_ENABLED": "true"},
                {"SEQUENCE_WALLET_ENABLED": "true"},
                {"APP_ORIGIN": "https://alternate.invalid"},
                {SERVICES[service][1] or "SETUP_DEPLOYMENT_JSON": "https://other-service.invalid"},
                {"ENABLED_READS": "token"},
                {"READ_V2_BRIDGE_ENABLED": "true"},
                {"READ_V2_BRIDGE_ENABLED": False},
                {"ENABLED_V2_READS": "pool-market"},
                {"READ_V3_BRIDGE_ENABLED": "true"},
                {"READ_V3_BRIDGE_ENABLED": False},
                {"ENABLED_V3_READS": "overview,history,search"},
                {"READ_V4_BRIDGE_ENABLED": "true"},
                {"READ_V4_BRIDGE_ENABLED": False},
                {"ENABLED_V4_READS": "sequence-snapshot"},
                {"READ_V5_BRIDGE_ENABLED": "true"},
                {"READ_V5_BRIDGE_ENABLED": False},
                {"ENABLED_V5_READS": "featured-pools"},
                {"READ_V6_BRIDGE_ENABLED": "true"},
                {"READ_V6_BRIDGE_ENABLED": False},
                {"ENABLED_V6_READS": "portfolio,activity"},
                {"POSITION_PLAN_ACCESS_CLIENT_SECRET": "synthetic-test-value"},
            ]
            for update in variants:
                with self.subTest(service=service, update=update):
                    config = copy.deepcopy(original)
                    config["vars"].update(update)
                    self.assertTrue(validate(service, config))

    def test_requires_explicit_disabled_read_versions_and_empty_route_lists(self):
        for key in ("READ_BRIDGE_ENABLED", "READ_V2_BRIDGE_ENABLED", "READ_V3_BRIDGE_ENABLED", "READ_V4_BRIDGE_ENABLED",
                    "READ_V5_BRIDGE_ENABLED", "READ_V6_BRIDGE_ENABLED", "ENABLED_READS", "ENABLED_V2_READS", "ENABLED_V3_READS",
                    "ENABLED_V4_READS", "ENABLED_V5_READS", "ENABLED_V6_READS"):
            with self.subTest(missing=key):
                config = copy.deepcopy(self.configs["read"])
                del config["vars"][key]
                self.assertTrue(validate("read", config))

    def test_the_position_plan_worker_is_its_own_disabled_family(self):
        """2026-10-02 (spec F7 §2.4): its own name, entry, flag, gateway and no logging; never the onboarding Worker's."""
        config = self.configs["position-plan"]
        self.assertEqual(flag_prefix("position-plan"), "POSITION_PLAN")
        self.assertEqual(config["name"], "domino-position-plan-bridge")
        self.assertEqual(config["main"], "src/position-plan-worker.mjs")
        # Changed on purpose 2026-11-04 (launch round P3): PREVIEW_ORIGINS, committed empty, as every private family's.
        self.assertEqual(config["vars"], {"POSITION_PLAN_BRIDGE_ENABLED": "false", "APP_ORIGIN": "https://domino.money",
                                          "POSITION_PLAN_GATEWAY_ORIGIN": "https://vm-position-plan.domino.money",
                                          "PREVIEW_ORIGINS": ""})
        self.assertEqual(config["observability"], {"enabled": False})
        for update in ({"POSITION_PLAN_GATEWAY_ORIGIN": "https://vm-onboarding.domino.money"},
                       {"ONBOARDING_BRIDGE_ENABLED": "false"}, {"POSITION-PLAN_BRIDGE_ENABLED": "false"}):
            with self.subTest(update=update):
                changed = copy.deepcopy(config)
                changed["vars"].update(update)
                self.assertTrue(validate("position-plan", changed))

    def test_the_points_worker_is_its_own_disabled_family(self):
        """2026-11-07 (season 1 points, part 3): its own name, entry, flag, gateway and no logging."""
        config = self.configs["points"]
        self.assertEqual(config["name"], "domino-points-bridge")
        self.assertEqual(config["main"], "src/points-worker.mjs")
        self.assertEqual(config["vars"], {"POINTS_BRIDGE_ENABLED": "false", "APP_ORIGIN": "https://domino.money",
                                          "POINTS_GATEWAY_ORIGIN": "https://points-gateway.example.invalid",
                                          "PREVIEW_ORIGINS": ""})
        self.assertEqual(config["observability"], {"enabled": False})
        self.assertIn("points", PREVIEW_SERVICES)
        for update in ({"POINTS_GATEWAY_ORIGIN": "https://vm-position-plan.domino.money"},
                       {"POINTS_BRIDGE_ENABLED": "true"}, {"POSITION_PLAN_BRIDGE_ENABLED": "false"}):
            with self.subTest(update=update):
                changed = copy.deepcopy(config)
                changed["vars"].update(update)
                self.assertTrue(validate("points", changed))

    def test_private_families_carry_preview_origins_committed_empty_and_only_the_alias_passes(self):
        """2026-11-04 (launch round P3, item 7): PREVIEW_ORIGINS on every private family's Worker, never on the read
        Worker or the setup release; "" as committed. Changed on purpose the same day (review L2): a reviewed value is
        "" or the forwarder's one preview alias; any other origin, however well formed, fails."""
        self.assertEqual(PREVIEW_SERVICES, set(SERVICES) - {"read", "setup"})
        # The alias is the one the Pages forwarder routes, letter for letter.
        forwarder = (ROOT / "app/functions/_lib/bridge.ts").read_text()
        self.assertIn(f"export const PREVIEW_ORIGIN = '{PREVIEW_ALIAS}'\n", forwarder)
        for service in SERVICES:
            with self.subTest(service=service):
                self.assertEqual(self.configs[service]["vars"].get("PREVIEW_ORIGINS"),
                                 "" if service in PREVIEW_SERVICES else None)
        for service in PREVIEW_SERVICES:
            for value in ("", PREVIEW_ALIAS):
                with self.subTest(service=service, admitted=value):
                    config = copy.deepcopy(self.configs[service])
                    config["vars"]["PREVIEW_ORIGINS"] = value
                    self.assertEqual(validate(service, config), [])
            refused = ["https://domino-app.pages.dev", "https://attacker.example.com",
                       "https://p3-testing.domino-app-e65.pages.dev", "https://domino-app-e65.pages.dev",
                       PREVIEW_ALIAS + ",https://p3-testing.domino-app-e65.pages.dev", PREVIEW_ALIAS + "," + PREVIEW_ALIAS,
                       "https://*.domino-app-e65.pages.dev", "*.pages.dev", "http://preview.domino-app-e65.pages.dev",
                       PREVIEW_ALIAS + "/", PREVIEW_ALIAS + ":443", "https://Preview.domino-app-e65.pages.dev",
                       " " + PREVIEW_ALIAS, PREVIEW_ALIAS + " ", "https://domino.money", f"https://vm-{service}.domino.money", " "]
            for value in (*refused, None, 1, [PREVIEW_ALIAS]):
                with self.subTest(service=service, refused=value):
                    config = copy.deepcopy(self.configs[service])
                    config["vars"]["PREVIEW_ORIGINS"] = value
                    self.assertTrue(validate(service, config))
            with self.subTest(service=service, missing="PREVIEW_ORIGINS"):
                config = copy.deepcopy(self.configs[service])
                del config["vars"]["PREVIEW_ORIGINS"]
                self.assertTrue(validate(service, config))
        for service in set(SERVICES) - PREVIEW_SERVICES:
            with self.subTest(service=service, unexpected="PREVIEW_ORIGINS"):
                config = copy.deepcopy(self.configs[service])
                config["vars"]["PREVIEW_ORIGINS"] = ""
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
            for name in [f"wrangler.{service}.toml" for service in SERVICES] + [GATE_CONFIG]:
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
