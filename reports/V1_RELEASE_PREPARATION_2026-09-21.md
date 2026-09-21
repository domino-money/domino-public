# Domino V1 public release preparation

Owner decisions on 21 September 2026: use **V1 public contract names** while
retaining **technical implementation version 4**, and perform **no further
independent audits**. Complete the internal build, tests, CI and local deployment
rehearsal. These checks are release validation, not a new independent audit.

## Public names and compatibility

The selected deployment/verification targets are `DominoVaultFactoryV1`,
`DominoVaultReadHelperV1`, `DominoRoutingHelperV1`, `DominoPriceGuardV1`,
`DominoExecutionEngineV1`, `DominoVaultV1` and `DominoSetupV1`.

Each is a thin inherited entrypoint over its existing V4 or unversioned base,
with the same forwarded constructor. No storage, function, override or
administrative capability was added. The vault getter remains
`implementationVersion() == 4`. Execution/signature domains, backend/SDK
admission, consumer schemas, Uniswap V4 and tariff version 1 are unchanged.
Explorer source verification must select `src/<PublicName>.sol:<PublicName>`;
EVM bytecode does not itself encode a human-readable contract name.

The build proves exact equality of creation bytecode, runtime templates, full
canonical ABI and immutable byte ranges for all seven alias/base pairs. No
executable byte is normalized away. Both sets retain their existing size limits
and custody/engine reserves. The independently reproduced artifact manifest
selects only the public V1 targets and authenticates all inherited inputs.

## Internal validation already performed

- Naming implementation: `6f5d531dbec05a922a8406d27ef9421facaa4419`.
- Pinned public build: seven of seven exact identities and size gates passed.
- Independent compiler rebuild and committed-manifest check: seven of seven
  artifacts reproduced; this is a deterministic build check, not an audit.
- Sixty focused Node tests plus six disposable-EVM release tests passed, no skips.
- Manifest SHA-256:
  `d74a6816df586ccc6ee660954df31e673111a7c2b95234330aa3e195cc1c4c57`.
- The M1/M2/M3 base at `d048b4b8564a7939baff0fafdada5ba67660043e` passed
  [all five CI jobs](https://github.com/domino-money/domino/actions/runs/35664507560),
  including 278 Solidity tests in 22 suites and the gas baseline. The seven
  public artifacts retain those exact compiled identities.

Final-candidate CI and the fresh fork rehearsal are recorded separately against
the exact final commit in the operational release package. Do not describe the
base CI as a new run on a later documentation commit. A release freeze tag is
created only after the final candidate's CI passes; it is not an audit tag.

## Preserved deployment policy

Simple automation charges 200 bps and Domino charges 400 bps by mode, once on
consumed original earned fees, with no extra internal swap fee. Assisted Setup
swaps use 65 bps. PriceGuard uses the immutable 50 sqrt-price bps band. Operator
and publisher gas is funded manually. The selected public wallet roles remain
unchanged.

The unsigned proposal must be regenerated against the final commit/manifest.
Use the project's own Nitro RPC as a read-only source for a private Anvil fork;
only that disposable fork receives rehearsal transactions. No private key,
synthetic balance, mainnet transaction or application activation is part of
this preparation.

The original `v4-audit-2026-09-21` tag at
`255fc38b6eb62d630c8354a8dcec870f3c9dee39` and its reports remain historical.
M1/M2/M3 and the V1 entrypoints are later changes, not retroactive additions to
that audited baseline. No additional audit is being commissioned or required.

See the [release procedure](../docs/FINANCIAL_RELEASE.md),
[M1/M2/M3 changes](V4_M123_REMEDIATION_2026-09-21.md), and
[post-deployment automatic-cycle demand](../docs/V4_AUTOMATION_CYCLE_POST_DEPLOY.md).
The latter is future work; deploying the contracts does not activate the cycle.
