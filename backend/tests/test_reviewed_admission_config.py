"""Reviewed candidates become private files without implicit activation."""
from contextlib import redirect_stdout
from io import StringIO
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_models import DepositError
from reviewed_admission_config import load_candidate, load_candidate_with_digest, main, write_private

ROOT = Path(__file__).resolve().parents[2]
PROFILE = ROOT/'reports/robinhood-reviewed-token-profiles-2026-09-10.json'


class ReviewedConfigTests(unittest.TestCase):
    def test_actual_reviewed_candidates_validate_without_network_or_runtime_flags(self):
        source = json.loads(PROFILE.read_text())
        manifest = load_candidate(PROFILE, now=source['reviewedAt'] + 1)
        self.assertEqual(manifest['schemaVersion'], 2)
        self.assertEqual(len(manifest['tokens']), 2)
        self.assertEqual([p['kind'] for p in manifest['tokens']], ['erc1967_transparent','erc1967_uups'])
        self.assertEqual(manifest['expiresAt'], source['reviewedAt'] + 30*86400)
        self.assertNotIn('enabled', manifest)

    def test_old_reviews_cannot_be_renewed_just_by_rerunning_the_command(self):
        source = json.loads(PROFILE.read_text())
        with self.assertRaises(DepositError):
            load_candidate(PROFILE, now=source['reviewedAt'] + 30*86400)

    def test_evidence_digest_binds_exact_validated_bytes_and_oversized_input_is_rejected(self):
        raw = PROFILE.read_bytes()
        source = json.loads(raw)
        _, evidence_digest = load_candidate_with_digest(PROFILE, now=source['reviewedAt'] + 1)
        self.assertEqual(evidence_digest, hashlib.sha256(raw).hexdigest())
        with tempfile.TemporaryDirectory() as path:
            target = Path(path)/'oversized.json'
            target.write_bytes(raw + b' ' * 32768)
            with self.assertRaises(DepositError):
                load_candidate_with_digest(target, now=source['reviewedAt'] + 1)

    def test_changed_profile_or_incoherent_source_fails_closed(self):
        for corrupt in ('profile', 'source', 'extra'):
            source = json.loads(PROFILE.read_text())
            if corrupt == 'profile': source['profiles'][0]['admin'] = '0x'+'aa'*20
            elif corrupt == 'source': source['sourceBlock']['timestamp'] = source['reviewedAt'] + 1
            else: source['enabled'] = True
            with tempfile.TemporaryDirectory() as path:
                target = Path(path)/'source.json'; target.write_text(json.dumps(source))
                with self.assertRaises(DepositError): load_candidate(target, now=source['reviewedAt'] + 1)

    def test_writer_creates_owned_private_regular_file_and_never_overwrites(self):
        source = json.loads(PROFILE.read_text())
        manifest = load_candidate(PROFILE, now=source['reviewedAt']+1)
        with tempfile.TemporaryDirectory() as path:
            target = Path(path)/'private'/'admission.json'
            write_private(target, manifest)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError): write_private(target, manifest)
            self.assertEqual(json.loads(target.read_text()), manifest)
            linked = target.parent/'linked.json'; linked.symlink_to(target)
            with self.assertRaises(FileExistsError): write_private(linked, manifest)
            self.assertEqual(json.loads(target.read_text()), manifest)

    def test_cli_errors_do_not_echo_paths_or_values(self):
        output = StringIO()
        with redirect_stdout(output):
            status = main(['--unknown-option', 'PRIVATE_CONFIG_CANARY'])
        self.assertEqual(status, 2)
        self.assertNotIn('PRIVATE_CONFIG_CANARY', output.getvalue())


if __name__ == '__main__':
    unittest.main()
