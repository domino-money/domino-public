# Public sanitized derivative

This source tree and its rewritten Git history are a public sanitization candidate
derived from the private repository snapshot at
`f6aa00bbcaf0e23a5d2c81a86b95420be6edb1ed`. Preparing this candidate does not publish
the repository or establish that GitHub-hosted discussions, artifacts and logs
have been cleared for publication.

Private network addresses, personal filesystem paths and personal Git author
email addresses have been replaced with documentation values or stable aliases.
Author names remain attributed. Infrastructure documentation uses illustrative
values. Historical measurements, contract source, bytecode and release manifests
retain their original meaning; sanitization is not a new audit or deployment.

## Historical evidence and tags

The original repository snapshot, audit archives, commit identifiers and signed
objects are preserved privately. Original commit and checksum references in
reports describe that original evidence. They do not authenticate rewritten
commits or modified public archive members.

In the rewritten candidate, tags are prefixed with `sanitized/`. For example,
`sanitized/v4-audit-2026-09-21` identifies a derivative of the original frozen
tag, not the original tag object or its signature. A historical statement that
an original tag is frozen continues to refer to the privately preserved original.
Rewriting invalidates original Git signatures; this candidate does not claim
those signatures remain valid.

The V2 evidence archives are named `*_PUBLIC_SANITIZED.zip`. Each contains an
additional notice and a manifest recording original and public member hashes.
An external `PUBLIC_SANITIZATION_MANIFEST.json` supplies the derivative archive
checksum. Historical manifests inside the archives remain source evidence;
use the public sanitization manifest to verify modified members.

## Scope and operation

Sanitization does not change contract logic, compilation inputs, application
behavior or wallet authorization. Documentation addresses and path markers are
not live configuration. Supply operational endpoints through private local
configuration when following a runbook.

The existing self-hosted CI broker requires a private repository. A public CI
design and review of GitHub issues, pull requests, releases, Actions artifacts,
logs and repository settings remain separate publication work. Do not enable
untrusted public contributions on a privileged private runner.

Keep the original private backup and replacement maps outside the public
repository. Existing clones must be replaced or carefully migrated after any
remote history replacement; merging old history would restore removed data.
