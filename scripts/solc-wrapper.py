#!/usr/bin/env python3
"""Foundry -> pinned local solc-js; no compiler download or remote execution."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
if "--version" in sys.argv:
    result = subprocess.run(["node", str(root / "scripts/solc-compile.cjs"), "--version"], check=True)
    raise SystemExit(result.returncode)
if "--standard-json" not in sys.argv:
    raise SystemExit("Only --version and --standard-json are supported")
payload = sys.stdin.buffer.read()
# Foundry provides source contents in standard JSON; imports must stay local.
json.loads(payload)
result = subprocess.run(["node", str(root / "scripts/solc-compile.cjs")], input=payload,
                        stdout=subprocess.PIPE, check=True)
sys.stdout.buffer.write(result.stdout)
