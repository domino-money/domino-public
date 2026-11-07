# `v2-audit-2026-10-04.2`: the remediation candidate and its re-audit

This folder holds two things:
- [`freeze.json`](freeze.json): the record of the annotated tag `v2-audit-2026-10-04.2`;
- the auditors' re-audit of that commit: reports, findings and receipt retain their delivered bytes from 4 Oct 2026; its evidence ZIP is a public sanitized derivative, identified below.

**The tag.** `v2-audit-2026-10-04.2` (object `d0c72d80de8037c502401ac9c002c485b8ca89bf`) is on commit `559c509ff71d71e49ac720bd6acd8a9783531ebb`, tree `e5ed5db6404ae9d5464028690f788ea3a217ebbd`. That commit is #323's merge, the remediation of [`v2-audit-2026-10-04`](../v2-audit-2026-10-04/README.md). The release manifest's SHA-256 is `2975c377c6f3690a702fddeecfe4ffb2c4ccab6e52c8739f4877ce458f66ed5c`.

**When it was cut.** After main's own run on this commit, [37223288312](https://github.com/domino-money/domino/actions/runs/37223288312), passed every job on its first attempt. The audited tag `v2-audit-2026-10-04` is unchanged.

## The re-audit

**Verdict: REQUEST_CHANGES.** The contract remediation was accepted in the reviewed scope, and no new blocking contract defect was confirmed. The one item left open is documentary.

| Finding | Re-audit | Basis |
|---|---|---|
| DV2-01 (medium) | Closed, fixed | The delta reviewed; the route, zap, vault and auto-exit regressions passed; the manifest rebuilt and matched |
| DV2-02 (release blocker) | Closed, fixed | The deploy tool's 54 tests passed; main's run passed on the exact commit, attempt 1 |
| DV2-03 (low) | Closed, fixed | The bootstrap ran on a fresh clone, then `AutoExitInvariants` passed 10/10 |
| DV2-04 (low) | Partially fixed; historical provenance open | Details below |
| DV2-05 (informational) | Closed, fixed | The bounded reply and the correlated envelope reviewed; the transport tests passed |

**DV2-04 as the re-audit found it:**
- **Accepted:** the current batches and reports check out, the stale vault entries are rewritten and apply, and the runner's tests passed.
- **Not proven:** the 3 Oct runs carry no source hash taken at the time. The re-audit asked for one of two things: the contemporaneous evidence, if any exists, or an explicit withdrawal of the retrospective claim, with the candidate's evidence as its replacement from here on.

**Disposition.** The 3 Oct campaigns are withdrawn as evidence, with no retroactive claim. [The audit package](../V2_AUDIT_PACKAGE.md) §5 and §6 say so. `../v2-audit-2026-10-04/remediation/mutation-history.json` keeps their results as history only. The files that exist from those runs were handed to the auditors as found: the three scripts and what they printed or wrote. They bind to no source hash, so they change nothing here. The evidence from here on is the candidate's reruns in `../v2-audit-2026-10-04/remediation/mutations/`. Those are the author's runs; anyone can repeat them with the committed batches and runner.

**Non-blocking notes from the re-audit,** kept as follow-ups:
- the long-path regression does not give its last intermediate a token of its own;
- no DV2-01 regression runs a v3 leg hosted by ZapV4 (the executor and its inheritance are the same);
- the JSON-RPC `error` object could be checked more strictly (a malformed one already fails closed);
- the RPC budget counts admissions, not a hard wall-clock or HTTP ceiling.

## Historical delivery and public derivative

### Public sanitization

The ZIP above is a **sanitized derivative**, not the original delivery, an unchanged audit freeze, or a new independent audit. Identified checkout prefixes became `[WORKSPACE]`; other user home directories became `[USER_HOME]`. ZIP timestamps, permissions, creator metadata, comments and extra fields were normalized. All original member names remain present, and unmodified member contents are byte-identical. No contracts, bytecode, verdicts or test outcomes were regenerated.

[`PUBLIC_SANITIZATION_MANIFEST.json`](PUBLIC_SANITIZATION_MANIFEST.json) records the original and public archive SHA-256, the affected members and the validation results. Inside the ZIP, a separate manifest records original and public hashes for every original member. The archive's original `MANIFEST.json` remains historical evidence: its hashes authenticate the original payload and must not be used as current checksums for redacted members.

`DELIVERY_RECEIPT.json`, freeze records, original source hashes, commit IDs and tag names retain their historical meaning. They describe the privately preserved original delivery; they do not certify the rewritten public history or the derivative ZIP as the same original freeze. The original archive hash is retained above solely for provenance.


| File | SHA-256 | What |
|---|---|---|
| [`REAUDITORIA_DOMINO_V2.md`](REAUDITORIA_DOMINO_V2.md) | `9bb40965be860ba7483ef4c622c3a0d349650c07881c661db1e5b1e7082fd355` | The re-audit report (Portuguese) |
| [`FINDINGS.json`](FINDINGS.json) | `86b0a30c06014f30830f9958dfa1c39acfc64a3aec6563758f63451a829c56a4` | The findings, machine-readable (also inside the archive) |
| `DOMINO_V2_REAUDIT_EVIDENCE.zip` (private original) | `6946b9a5b33d35585bd7fe1c36a8fffee5257421d40319a875c50c1de5209352` | Original delivered evidence: 332,566 bytes, 68 members. Preserved in the private backup; this original ZIP is omitted from the public checkout. |
| [`DOMINO_V2_REAUDIT_EVIDENCE_PUBLIC_SANITIZED.zip`](DOMINO_V2_REAUDIT_EVIDENCE_PUBLIC_SANITIZED.zip) | `078a0287cad7d84391c991610a11ed7ad63b7ffe5344679cb9cbbd0f8a4dfce5` | Public sanitized derivative: 335,841 bytes, 70 members. 8 original members contain path redactions; two added members explain and verify the derivative. |
| [`DELIVERY_RECEIPT.json`](DELIVERY_RECEIPT.json) | `18a6fdbc074e4ca63017c6d7d13a6d192b3e926f0af2d0931696c3ac9e73ab51` | The receipt with the three hashes above |

```bash
cd reports/v2-audit-2026-10-04.2 && shasum -a 256 REAUDITORIA_DOMINO_V2.md FINDINGS.json DOMINO_V2_REAUDIT_EVIDENCE_PUBLIC_SANITIZED.zip DELIVERY_RECEIPT.json
```

**Neither audit authorized a deployment.** The tag and a deployment are separate decisions (docs/v2/FREEZE.md, `v2-release-YYYY-MM-DD`).
