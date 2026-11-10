"""Offline boundary check for the disabled read and financial Worker candidates.

Reads repository TOML only; does not inspect or change Cloudflare resources.

One exception to "disabled", authorized on 2026-09-18 (docs/READ_PATH_RECORDS.md):
the read Worker keeps its own hop record in Workers Logs, and nothing more.
Its observability block is pinned to exactly that shape — enabled, every
request, invocation logs off — because the invocation log carries the raw
method and URL the hop record exists not to record. Every other Worker stays
without logging until its family is switched on.

Added 2026-10-02 (review of rugged97's RPC rules, finding 2): the site-wide
gate of wide log scans (wrangler.wide-gate.toml), a Durable Object the Pages
Functions reach through their binding. It has no variables and no ingress,
and exactly one Durable Object class and its one migration.

Added 2026-10-02 (Domino V2, spec F7 §2.4 and §6.2): the position-plan Worker
(wrangler.position-plan.toml, POSITION_PLAN_* variables, its own
vm-position-plan gateway) and the read Worker's read-v6 pair, both off.

Added 2026-10-02 (Domino V2, spec F7 §3.2, S2): the crosschain Worker
(wrangler.crosschain.toml, CROSSCHAIN_* variables, its own vm-crosschain
gateway), off.

Added 2026-11-04 (launch round P3, item 7: testing without real money): each
private family's Worker (session and the authenticated transport) carries
PREVIEW_ORIGINS, the exact Pages preview origins it admits besides
APP_ORIGIN. Committed empty. Changed on purpose the same day (review L2): a
reviewed value may be that or the one preview alias the Pages forwarder routes
(PREVIEW_ALIAS, app/functions/_lib/bridge.ts PREVIEW_ORIGIN), nothing else,
so no reviewed configuration names a host the forwarder never sends, however
well formed (another Pages project, a branch host, any other site).

Added 2026-11-07 (season 1 points, docs/points/POINTS.md part 3): the points
Worker (wrangler.points.toml, POINTS_* variables, its own example gateway),
off, a private family with PREVIEW_ORIGINS committed empty.
"""
from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[2]
SERVICES = {
    "read": ("worker", "GATEWAY_ORIGIN", "2026-09-09"),
    "session": ("session-worker", "SESSION_GATEWAY_ORIGIN", "2026-09-10"),
    "onboarding": ("onboarding-worker", "ONBOARDING_GATEWAY_ORIGIN", "2026-09-10"),
    "deposit": ("deposit-worker", "DEPOSIT_GATEWAY_ORIGIN", "2026-09-10"),
    "performance": ("performance-worker", "PERFORMANCE_GATEWAY_ORIGIN", "2026-09-10"),
    "execution": ("execution-worker", "EXECUTION_GATEWAY_ORIGIN", "2026-09-10"),
    "setup": ("setup-release", None, "2026-09-10"),
    "position-plan": ("position-plan-worker", "POSITION_PLAN_GATEWAY_ORIGIN", "2026-10-02"),
    "crosschain": ("crosschain-worker", "CROSSCHAIN_GATEWAY_ORIGIN", "2026-10-02"),
    "points": ("points-worker", "POINTS_GATEWAY_ORIGIN", "2026-11-07"),
}
# The one retained record per request, and nothing else: no invocation log.
RECORD_ONLY = {"enabled": True, "head_sampling_rate": 1, "logs": {"invocation_logs": False}}
OBSERVABILITY = {"read": RECORD_ONLY}
GATE_CONFIG = "wrangler.wide-gate.toml"
GATE_EXPECTED = {
    "name": "domino-wide-gate",
    "main": "src/wide-gate-worker.mjs",
    "compatibility_date": "2026-10-02",
    "workers_dev": False,
    "preview_urls": False,
    "routes": [],
    "logpush": False,
    "observability": {"enabled": False},
    "durable_objects": {"bindings": [{"name": "WIDE_GATE", "class_name": "WideGate"}]},
    "migrations": [{"tag": "v1", "new_sqlite_classes": ["WideGate"]}],
}
# The families whose Worker admits a listed preview origin: every private one (session and the authenticated
# transport), never the read Worker or the setup release, which the preview reaches translated (functions/_lib/bridge.ts).
PREVIEW_SERVICES = frozenset({"session", "onboarding", "deposit", "performance", "execution", "position-plan", "crosschain",
                              "points"})
PREVIEW_ALIAS = "https://preview.domino-app-e65.pages.dev"
KNOWN_CONFIGS = {
    "wrangler.example.toml", "wrangler.session.example.toml",
    "wrangler.onboarding.example.toml", "wrangler.deposit.example.toml",
    GATE_CONFIG,
    *(f"wrangler.{service}.toml" for service in SERVICES),
}


def same_value(actual, expected):
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(same_value(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(same_value(a, b) for a, b in zip(actual, expected))
    return actual == expected


def flag_prefix(service):
    """A service's variable prefix: its name in upper case, a hyphen as an underscore (position-plan: POSITION_PLAN)."""
    return service.upper().replace("-", "_")


def preview_origin_errors(value):
    """Policy errors of a PREVIEW_ORIGINS value: "" (none) or exactly the forwarder's one preview alias."""
    if value in ("", PREVIEW_ALIAS):
        return []
    return [f"PREVIEW_ORIGINS is neither empty nor the preview alias {PREVIEW_ALIAS}"]


def validate(service, config):
    """Return policy errors; extra fields cannot silently add a second ingress."""
    entry, origin_key, compatibility_date = SERVICES[service]
    expected = {
        "name": f"domino-{service}-bridge",
        "main": f"src/{entry}.mjs",
        "compatibility_date": compatibility_date,
        "workers_dev": False,
        "preview_urls": False,
        "routes": [],
        "logpush": False,
        "observability": OBSERVABILITY.get(service, {"enabled": False}),
        "vars": {
            f"{flag_prefix(service)}_BRIDGE_ENABLED": "false",
            "APP_ORIGIN": "https://domino.money",
            origin_key: ("https://points-gateway.example.invalid" if service == "points"
                         else f"https://vm-{service}.domino.money"),
            **({"ENABLED_READS": "", "READ_V2_BRIDGE_ENABLED": "false",
                "ENABLED_V2_READS": "", "READ_V3_BRIDGE_ENABLED": "false",
                "ENABLED_V3_READS": "", "READ_V4_BRIDGE_ENABLED": "false",
                "ENABLED_V4_READS": "", "READ_V5_BRIDGE_ENABLED": "false",
                "ENABLED_V5_READS": "", "READ_V6_BRIDGE_ENABLED": "false",
                "ENABLED_V6_READS": ""} if service == "read" else {}),
        },
    }
    if service == "setup":
        expected["vars"] = {"SETUP_WALLET_ENABLED": "false", "SEQUENCE_WALLET_ENABLED": "false"}
    errors = []
    if service in PREVIEW_SERVICES:
        # Committed empty; a reviewed list passes when its every origin does, and is then compared as itself.
        listed = config.get("vars", {}).get("PREVIEW_ORIGINS") if isinstance(config.get("vars"), dict) else None
        errors.extend(preview_origin_errors(listed))
        expected["vars"]["PREVIEW_ORIGINS"] = listed
    if set(config) != set(expected):
        errors.append("unexpected or missing configuration fields")
    for key, value in expected.items():
        if not same_value(config.get(key), value):
            errors.append(f"{key} differs from disabled reviewed policy")
    return errors


def validate_gate(config):
    """Return policy errors of the wide-scan gate's configuration: exactly its reviewed shape."""
    errors = []
    if set(config) != set(GATE_EXPECTED):
        errors.append("unexpected or missing configuration fields")
    for key, value in GATE_EXPECTED.items():
        if not same_value(config.get(key), value):
            errors.append(f"{key} differs from the reviewed gate policy")
    return errors


def inventory_errors(directory, *, allowed_names=KNOWN_CONFIGS):
    """Reject alternate config entry points; do not inspect their contents."""
    try:
        names = {path.name for path in directory.iterdir()}
    except OSError:
        return ["configuration directory unreadable"]
    candidates = {name for name in names if name.casefold().startswith("wrangler")
                  and name.casefold().endswith((".toml", ".json", ".jsonc"))}
    # Only the exact reviewed names are allowed, even on case-insensitive disks.
    errors = [f"{name}: unreviewed Worker configuration" for name in sorted(candidates - allowed_names)]
    redirect = directory / ".wrangler" / "deploy" / "config.json"
    try:
        redirect.lstat()
    except FileNotFoundError:
        pass
    except OSError:
        errors.append(".wrangler/deploy/config.json: redirect inventory unreadable")
    else:
        errors.append(".wrangler/deploy/config.json: unreviewed Worker configuration redirect")
    return errors


def main():
    failures = inventory_errors(ROOT / "bridge")
    failures.extend(f"repository root/{error}" for error in inventory_errors(ROOT, allowed_names=frozenset()))
    for service in SERVICES:
        path = ROOT / "bridge" / f"wrangler.{service}.toml"
        try:
            with path.open("rb") as stream:
                config = tomllib.load(stream)
            failures.extend(f"{path.name}: {error}" for error in validate(service, config))
        except (OSError, ValueError):
            failures.append(f"{path.name}: unreadable or invalid TOML")
    path = ROOT / "bridge" / GATE_CONFIG
    try:
        with path.open("rb") as stream:
            failures.extend(f"{path.name}: {error}" for error in validate_gate(tomllib.load(stream)))
    except (OSError, ValueError):
        failures.append(f"{path.name}: unreadable or invalid TOML")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"{len(SERVICES)} disabled Worker configurations and the wide-scan gate satisfy the repository policy; remote state unchecked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
