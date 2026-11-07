# `v2-audit-2026-10-04`: the independent audit

This folder holds the independent audit of the tag `v2-audit-2026-10-04` (commit `5e63d2db`). The reports, findings, receipt and freeze record retain their delivered bytes from 4 Oct 2026. The evidence ZIP is now a public sanitized derivative, identified below. The remediation that followed sits beside them, in `remediation/`.

**Verdict: REQUEST_CHANGES, release not recommended.**
- Contract findings: none critical, none high, one medium (DV2-01).
- Other findings: a release blocker (DV2-02), two low (DV2-03, DV2-04) and one informational (DV2-05).
- Slither: 352 results triaged, none confirmed.

## Historical delivery and public derivative

### Public sanitization

The ZIP above is a **sanitized derivative**, not the original delivery, an unchanged audit freeze, or a new independent audit. Identified checkout prefixes became `[WORKSPACE]`; other user home directories became `[USER_HOME]`. ZIP timestamps, permissions, creator metadata, comments and extra fields were normalized. All original member names remain present, and unmodified member contents are byte-identical. No contracts, bytecode, verdicts or test outcomes were regenerated.

[`PUBLIC_SANITIZATION_MANIFEST.json`](PUBLIC_SANITIZATION_MANIFEST.json) records the original and public archive SHA-256, the affected members and the validation results. Inside the ZIP, a separate manifest records original and public hashes for every original member. The archive's original `MANIFEST.json` remains historical evidence: its hashes authenticate the original payload and must not be used as current checksums for redacted members.

`DELIVERY_RECEIPT.json`, freeze records, original source hashes, commit IDs and tag names retain their historical meaning. They describe the privately preserved original delivery; they do not certify the rewritten public history or the derivative ZIP as the same original freeze. The original archive hash is retained above solely for provenance.


| File | SHA-256 | What |
|---|---|---|
| [`AUDITORIA_DOMINO_V2.md`](AUDITORIA_DOMINO_V2.md) | `d778ced0da068d1ed7cef7ecf19a798d2b858213dd333eb68e6d6847d00fb0e3` | The report (Portuguese) |
| [`FINDINGS.json`](FINDINGS.json) | `7a1b3e05574063b733c97eab86d6d49b0a1aca7839cec5698a68c1612624de91` | The findings and the run's totals, machine-readable |
| `DOMINO_V2_AUDIT_EVIDENCE.zip` (private original) | `db3a30d7b6cdb8ab8734f160ff1a8a5db5aeab6ed186c577f7ef7ff93976650e` | Original delivered evidence: 996,367 bytes, 131 members. Preserved in the private backup; this original ZIP is omitted from the public checkout. |
| [`DOMINO_V2_AUDIT_EVIDENCE_PUBLIC_SANITIZED.zip`](DOMINO_V2_AUDIT_EVIDENCE_PUBLIC_SANITIZED.zip) | `72a25218245bd05beef6d0b218d1c00945c80176d66461eb6c3b8f90e93fe732` | Public sanitized derivative: 1,005,888 bytes, 133 members. 12 original members contain path redactions; two added members explain and verify the derivative. |
| [`DELIVERY_RECEIPT.json`](DELIVERY_RECEIPT.json) | `18870b313ca8e50ff4c19801eab4a1d3742d536c0aeefb01f213e7f956cb7fb6` | The archive's and the report's hashes, and the check the auditors ran on the archive |
| [`freeze.json`](freeze.json) | `1f014415be5f4d864b40445d914e900b3cb9c34348ae1bedb139067cde0114d9` | The freeze record of the audited tag, as the auditors received it |

To check them:

```bash
cd reports/v2-audit-2026-10-04 && shasum -a 256 AUDITORIA_DOMINO_V2.md FINDINGS.json DOMINO_V2_AUDIT_EVIDENCE_PUBLIC_SANITIZED.zip DELIVERY_RECEIPT.json freeze.json
```

## Remediation

[The audit package](../V2_AUDIT_PACKAGE.md) §5 maps each finding to its fix. The remediation is a new candidate, never the audited release. It gets its own tag after main's run on its merge commit passes ([docs/v2/FREEZE.md](../../docs/v2/FREEZE.md)).

| Finding | Fix | Evidence |
|---|---|---|
| DV2-01 (medium) | `contracts/src/v2/route/DominoSwapExecutor.sol`: a v3 path's intermediate tokens are tracked, so a leg that moves them reverts | Regressions on the route, the zap, the vault and the auto-exit (package §5); mutants in `remediation/mutations/v2-audit-2026-10-04.json` |
| DV2-02 (release blocker) | `scripts/v2/deploy-preflight.test.mjs`: no transaction a test leaves pending reaches the next test | `remediation/main-ci.json` records the audited commit's run as it happened. The candidate's own main run gates its tag |
| DV2-03 (low) | `scripts/v2/audit-bootstrap.sh` | A run on a fresh checkout of the candidate (package §1) |
| DV2-04 (low) | The three hand-run campaigns are committed batches; eight stale vault mutants are rewritten; `scripts/mutate-contracts.mjs` rebuilds what a suite loads by artifact and reports source hashes. After the re-audit, the 3 Oct runs are withdrawn as evidence (no source hash binds them); the candidate's reruns replace them | `remediation/mutations/`; `remediation/mutation-history.json` as history only |
| DV2-05 (informational) | `scripts/v2/deploy.mjs`: RPC replies bounded to 8 MiB and checked against their request | `scripts/v2/deploy.test.mjs` (the transport test) |
| Limits to state plainly | Double-entry (B) reaches the auto-exit's credits; the v3 rearm's slack; the per-position path when `exitAll` does not fit; 8,040 lines at the tag | Package §2, §5, §7; `docs/v2/F3_VAULT.md`; `docs/v2/F4_AUTO_EXIT.md` |

`remediation/` holds three things:
- **`main-ci.json`:** main's run on the audited commit. Attempt 1 failed (DV2-02); attempt 2, a rerun of the failed job after the audit, passed. Neither replaces the candidate's own gate.
- **`mutation-history.json`:** the hand-run campaigns behind the package's "29 of 29", "18 of 18" and "5 of 5", with their results as recorded on 3 Oct.
- **`mutations/*.json`:** the reruns on the remediation candidate (`scripts/mutate-contracts.mjs --report`). Each names its batch and every source and suite it ran by SHA-256. A source's hash can be compared with `contracts/release-artifacts-v2.json`.

The remediation did not alter the original audit delivery. The later public sanitization changes only personal paths in evidence and archive metadata; it is documented separately above. It is tagged `v2-audit-2026-10-04.2`; the auditors' re-audit of it is in [`../v2-audit-2026-10-04.2/`](../v2-audit-2026-10-04.2/README.md).
