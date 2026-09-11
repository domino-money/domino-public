"""Build a private admission file from an explicitly reviewed public candidate.

No network, listener, wallet, signing or activation. Existing files are never
overwritten. Profile validity comes from the dated review, not this command.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import time

from bridge_state import strict_json
from deposit_models import DepositError, SourceBlock
from deposit_prepare import validate_admission_manifest
from discovery import CHAIN_ID
from token_admission import POLICY, digest


def load_candidate(path, *, now=None):
    return load_candidate_with_digest(path, now=now)[0]


def load_candidate_with_digest(path, *, now=None):
    """Bind the evidence digest to the same bounded bytes that were validated."""
    now = int(time.time()) if now is None else now
    try:
        with Path(path).open('rb') as stream:
            raw = stream.read(32769)
        if len(raw) > 32768:
            raise ValueError()
        reviewed = strict_json(raw)
        if (type(reviewed) is not dict or set(reviewed) != {'schemaVersion','chainId','reviewedAt','sourceBlock','profiles','deployments'}
                or type(reviewed['schemaVersion']) is not int or reviewed['schemaVersion'] != 1
                or type(reviewed['chainId']) is not int or reviewed['chainId'] != CHAIN_ID
                or type(reviewed['reviewedAt']) is not int):
            raise ValueError()
        source = SourceBlock.model_validate(reviewed['sourceBlock'])
        if source.timestamp > reviewed['reviewedAt']:
            raise ValueError()
        manifest = {'schemaVersion': 2, 'policyVersion': POLICY,
            'reviewedAt': reviewed['reviewedAt'], 'expiresAt': reviewed['reviewedAt'] + 30*86400,
            'reviewReference': 'reports/UPGRADEABLE_TOKEN_REVIEW.md', 'nativeEnabled': True,
            'deployments': reviewed['deployments'], 'tokens': reviewed['profiles']}
        manifest['manifestId'] = digest(manifest, 'manifestId')
        return validate_admission_manifest(manifest, now=now), hashlib.sha256(raw).hexdigest()
    except Exception:
        raise DepositError('deposit_admission_required') from None


def write_private(path, manifest):
    path = Path(path)
    parent = path.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('private_admission_directory_required')
    raw = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    if len(raw) > 32768:
        raise ValueError('admission_file_too_large')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('invalid_admission_arguments')


def main(argv=None):
    parser = _Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--profiles', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    try:
        args = parser.parse_args(argv)
        manifest = load_candidate(args.profiles)
        write_private(args.output, manifest)
    except Exception:
        print('Admission file not created; check the reviewed input and a private, unused destination.')
        return 2
    print('Reviewed admission file created. No service or financial capability was activated.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
