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
  - every V2 suite;
  - `export-abi.mjs --check` (the interface freeze, F0);
  - `position-fixtures.mjs check`;
  - the gas baseline.

## Changing a frozen file

A change to a V2 source or a release input is deliberate:
- The PR that makes it regenerates the manifest with `--write`.
- Its description says what changed and why.
- After the audit tag, the change is a new candidate. Never describe it as the audited release.

## Tags

- **`v2-audit-YYYY-MM-DD`:** an annotated tag on a `main` commit whose full CI run passed. `reports/v2-audit-YYYY-MM-DD/freeze.json` records:
  - the commit, tree and tag object;
  - the CI run;
  - the SHA-256 of the manifest.
- **`v2-release-YYYY-MM-DD`:** an annotated tag on the commit a deployment is prepared from. It is that deployment's `--release-tag`.

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
