# V2 freeze

This page covers the V2 freeze for the adversarial audit:
- what is frozen;
- how CI holds the freeze;
- how a frozen file changes;
- which tags mark it;
- how the deployment tool is bound to it.

The owner decided the freeze on 3 Oct 2026 (items 9–11): V1-style conventions, and the audit scope below, before the Robinhood opening.

## Scope

**In scope:**
- **Every source under `contracts/src/v2`.** There are 52 files, including the 10 Uniswap math files vendored in `positions/uniswap`. `position-fixtures.mjs check` holds those 10 to their reference copies (F1_POSITIONS.md).
- **The deployment tool:**
  - `scripts/v2/deploy.mjs`, `deploy-schema.mjs`, `deploy-manifest.schema.json` and `release-manifest.mjs`;
  - the two shared files they run, `scripts/solc-compile.cjs` and `scripts/prepare-financial-release.mjs`.

**Out of scope:**
- The Elysium-v3 drafts (#258–#277).
- The V1 contracts, which have their own freeze (`v4-audit-2026-09-21`, `v1-release-2026-09-21`).
- The backend and the app.

## The manifest

`contracts/release-artifacts-v2.json` is written by `node scripts/v2/release-manifest.mjs --write`. It records:
- **The compiler profile:** solc-js `0.8.26+commit.8a97fa7a`, via-IR, 200 runs, `cancun`, `bytecodeHash: none`.
- **The components:** the 13 components and their contract names.
- **The sources:** the SHA-256 of each source, and `sourceTreeSha256` over them. This is the same value a deployment manifest records as `build.sourceTreeSha256`.
- **The release inputs:** the SHA-256 of each tool file listed under [Scope](#scope).
- **For each of the 12 contracts:**
  - its source;
  - the SHA-256 and size of its creation and runtime bytecode, as compiled (immutable slots zero);
  - the offsets of its immutable slots;
  - the SHA-256 of its ABI (top-level order normalized).

The compile is `deploy.mjs`'s `compileV2`: every V2 source in one standard-JSON input, through the pinned solc-js. It is the same compile a deployment uses.

## What CI holds

- **Backend:** `release-manifest.mjs --check --forge-out contracts/out` does two things:
  - it recompiles every V2 source and fails when the committed manifest differs, naming each changed source, input or contract field;
  - it requires the Foundry artifacts the EVM tests deploy to be the same contracts, byte for byte.

  The compile is the one the deployment-tool tests cached in the step before, which is reused only for an identical input.
- **Contracts (v2):**
  - every V2 suite outside `adversarial/` and `invariant/`;
  - `export-abi.mjs --check` (the interface freeze, F0);
  - `position-fixtures.mjs check`;
  - the gas baseline of those suites.
- **Contracts (v2-audit):** the audit suites, `contracts/test/v2/adversarial` and `invariant` ([reports/V2_AUDIT_PACKAGE.md](../../reports/V2_AUDIT_PACKAGE.md) §6), and their gas baseline.

## Changing a frozen file

A change to a V2 source or a release input is deliberate:
- The PR that makes it regenerates the manifest with `--write`.
- Its description says what changed and why.
- After the audit tag, the change is a new candidate. Never describe it as the audited release.

## Rebuilding from a clean checkout

`sh scripts/v2/audit-bootstrap.sh` installs the locked dependencies, builds what every V2 suite needs and checks the manifest. That covers the V1 contracts the runner's size gate reads and the integration artifacts the wired suites load by name. Then run one suite at a time (`node scripts/test-contracts.mjs --match-path <suite>`). [The audit package](../../reports/V2_AUDIT_PACKAGE.md) §1 lists the steps.

## Tags

- **`v2-audit-YYYY-MM-DD`:** an annotated tag on a `main` commit, cut only after main's own full CI run on that commit passed. A pull request's run on the same tree does not count. `reports/v2-audit-YYYY-MM-DD/freeze.json` records:
  - the commit, tree and tag object;
  - the CI run;
  - the SHA-256 of the manifest.

  A tag is never moved and a freeze record never edited: what happens later (a rerun, an audit's report, a remediation) is recorded beside it. A second candidate on a date that already has a tag takes the suffix `.2`.
- **`v2-release-YYYY-MM-DD`:** an annotated tag on the commit a deployment is prepared from. It is that deployment's `--release-tag`.

## Audits

`reports/v2-audit-YYYY-MM-DD/` keeps an audit of that tag as delivered: the report, the findings, the evidence archive and its receipt, with their SHA-256 in the folder's README. A remediation adds a `remediation/` folder beside them and becomes the next candidate. `v2-audit-2026-10-04` was audited on 4 Oct 2026 (REQUEST_CHANGES); [its folder](../../reports/v2-audit-2026-10-04/README.md) maps each finding to its fix.

## The deployment binding

`deploy.mjs` prepares a public package (environment `public-chain-preparation`) only when all three hold:
- **`release_manifest_not_committed`:** the manifest is committed at the compiled commit;
- **`release_manifest_changed`:** it is unchanged in the checkout;
- **`release_manifest_mismatch`:** it is equal to the tool's own compile, including the release inputs.

These come on top of the existing rules:
- a clean checkout;
- the tool's own checkout;
- the committed chain profile.

Every deployment manifest records `build.sourceTreeSha256`, so that one hash matches a deployment to the frozen manifest.
