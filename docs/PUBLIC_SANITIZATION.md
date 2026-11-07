# Public sanitized derivative

This repository, `domino-money/domino-public`, is a separate sanitized publication
derived from the private repository snapshot at
`f6aa00bbcaf0e23a5d2c81a86b95420be6edb1ed`. The original repository remains private.
The initial publication includes the sanitized `main` history and six
`sanitized/` tags. Other development branches, pull request refs, discussions,
Actions logs, release attachments and private repository settings were not
imported. Git history in this repository has no ancestry link to the original
unsanitized commit objects.

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

In this repository, tags are prefixed with `sanitized/`. For example,
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

The original self-hosted CI broker requires the original private repository.
Its workflows are guarded against execution here. The separate public workflow
uses hosted runners with read-only repository access and no deployment steps;
see [PUBLIC_CI.md](PUBLIC_CI.md) for its scope. Do not add operational credentials
or enable untrusted public contributions on a privileged private runner.

The initial public preparation also supplies the full upstream font license
notices. It does not assign a new repository-wide software license.
The current [source availability and review terms](../LICENSE.md) document
publication for transparency and local review, while preserving existing
file-level licenses and permissions granted for earlier versions.

Keep the original private backup and replacement maps outside the public
repository. Clone this repository directly when contributing to the public
source. Do not merge branches from the original private repository: doing so
would restore the unsanitized history. Future imports require the same review
of source, history, archives and metadata before they reach this repository.
