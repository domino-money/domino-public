#!/usr/bin/env python3
"""Export local OpenAPI without loading credentials or contacting a provider."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from read_api import create_app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    # Schema generation inspects route models only; no service operation is called.
    schema = create_app(service=object()).openapi()
    content = json.dumps(schema, indent=2, sort_keys=True) + '\n'
    path = ROOT / 'backend/openapi-read.json'
    if args.check:
        if not path.exists() or path.read_text() != content:
            print('Read OpenAPI drift; run scripts/export-read-openapi.py.')
            return 1
        print('Read OpenAPI matches producer routes and models.')
        return 0
    path.write_text(content)
    print('Generated backend/openapi-read.json.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
