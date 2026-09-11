"""Offline boundary check for the four disabled #45 Worker candidates.

Reads repository TOML only; does not inspect or change Cloudflare resources.
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
}
KNOWN_CONFIGS = {
    "wrangler.example.toml", "wrangler.session.example.toml",
    "wrangler.onboarding.example.toml", "wrangler.deposit.example.toml",
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
        "observability": {"enabled": False},
        "vars": {
            f"{service.upper()}_BRIDGE_ENABLED": "false",
            "APP_ORIGIN": "https://domino.money",
            origin_key: f"https://vm-{service}.domino.money",
            **({"ENABLED_READS": ""} if service == "read" else {}),
        },
    }
    errors = []
    if set(config) != set(expected):
        errors.append("unexpected or missing configuration fields")
    for key, value in expected.items():
        if not same_value(config.get(key), value):
            errors.append(f"{key} differs from disabled reviewed policy")
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
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("Four disabled Worker configurations satisfy the repository policy; remote state unchecked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
