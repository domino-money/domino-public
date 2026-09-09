#!/usr/bin/env python3
"""Check staged/tracked source paths and obvious credential patterns, never print values.

This bounded hygiene check is not a complete secret scanner or a security audit.
"""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
entries = subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=ROOT).split(b'\0')
forbidden = {'runtime', 'node_modules', '.venv', '__pycache__', '.git', '.codex', '.wrangler', 'dist', '.vinext'}
patterns = [
    re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}'),
    re.compile(rb'github_pat_[A-Za-z0-9_]{30,}'),
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'https://[^\s"<>]+\.g\.alchemy\.com/v2/[A-Za-z0-9_-]{20,}'),
    re.compile(rb'https://[^\s/@:]+:[^\s/@]+@'),
]
errors = []
count = 0
for entry in entries:
    if not entry:
        continue
    metadata, raw_name = entry.split(b'\t', 1)
    mode, digest, stage = metadata.decode().split()
    name = raw_name.decode()
    path = Path(name)
    count += 1
    if mode in {'160000', '120000'} or stage != '0':
        errors.append((name, 'embedded repository, symlink or unmerged entry'))
        continue
    if (forbidden.intersection(path.parts) or path.name.startswith('.env') and path.name != '.env.example'
            or path.suffix in {'.pem', '.key', '.p12', '.keystore', '.db', '.sqlite', '.dump', '.log'}
            or name.startswith('reports/private-site-release')):
        errors.append((name, 'private/generated path'))
    # Read Git objects, so checking staged files cannot overlook older staged content.
    data = subprocess.check_output(['git', 'cat-file', 'blob', digest], cwd=ROOT)
    if name == 'backend/tests/test_inventory.py':
        # This exact synthetic URL tests rejection of HTTP Basic credentials.
        fixture = b'https://' + b'user:password@robinhood-mainnet.g.alchemy.com/v2/key'
        data = data.replace(fixture, b'SYNTHETIC_REJECTED_URL')
    if len(data) > 5_000_000:
        errors.append((name, 'unexpected large source artifact'))
    if any(pattern.search(data) for pattern in patterns):
        errors.append((name, 'possible credential'))
if not count:
    errors.append(('(index)', 'no tracked source files'))
for name, reason in errors:
    print(f'{name}: {reason}')
print(f'Repository hygiene: {count} files checked; {len(errors)} findings.')
sys.exit(bool(errors))
