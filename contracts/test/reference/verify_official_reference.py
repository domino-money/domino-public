#!/usr/bin/env python3
"""Verify the exact offline reference inventory and its pinned source digests."""
from pathlib import Path
import hashlib
import json
import sys


root = Path(__file__).resolve().parent / 'official-v4'
manifest = json.loads((root / 'provenance.json').read_text())
expected = manifest['sha256']
actual = {str(path.relative_to(root)): path for path in root.rglob('*')
          if path.is_file() and path.name != 'provenance.json'}
errors = []
if actual.keys() != expected.keys():
    errors.append('reference inventory differs from provenance manifest')
for name, digest in expected.items():
    if name not in actual or hashlib.sha256(actual[name].read_bytes()).hexdigest() != digest:
        errors.append(f'reference digest mismatch: {name}')
for message in errors:
    print(message)
print(f'Official v4 reference: {len(expected)} files verified; {len(errors)} findings.')
sys.exit(bool(errors))
