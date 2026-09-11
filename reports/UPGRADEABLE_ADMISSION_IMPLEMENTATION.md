# Reviewed-token admission implementation — issue #44

10 September 2026. Stacked on #43 at
`82e088a5b59d1c78f3f0c109f335b98ec2ee166a`.

The disabled direct-deposit backend now supports explicitly reviewed immutable
tokens and ERC-1967 transparent/UUPS proxies. Initial WETH/USDG profiles were
reviewed against Robinhood deployments and exercised through actual local-fork
approval/mint/receipt paths. This replaces the immutable-only blocker for these
finite candidate profiles; it does not enable public deposits or admit arbitrary
proxies, taxed/rebasing assets or every USDG account.

## Implementation and review

- `token_admission.py` validates complete, versioned profiles and checks proxy,
  implementation, administrator, dependent code, fixed storage/getters and
  operative predicates. Review IDs bind the entire record. Browser/provider
  input cannot create profiles or relax these checks.
- Preparation checks the source and a fresh post-composition block. Every
  service delivery of an executable step, including persisted re-delivery,
  revalidates token state, current review/manifest, owner, deployments, nonce,
  canonicality and expiry. Failure keeps issued evidence and nonce reservations.
- Receipt reconciliation resolves the issued review from active or archived
  profiles and checks the receipt block and canonical parent. Identity changes
  or missing evidence cannot yield trusted token amounts. NFT/transaction/gas
  evidence remains visible. Legacy history is projected conservatively without
  rewriting the stored raw evidence.
- A private configuration helper and `--reviewed-profiles` qualification option
  use the same bounded candidate loader. The report digest binds the exact bytes
  validated. Files are not overwritten; expiry is tied to the review date.
- Selection complexity is bounded before RPC work: 36 identity and 48 operative
  reads per endpoint. The actual WETH/USDG pair uses 36 and 44. Adapters and
  reconciliation cap calls at 160 under the existing deadline. An independent
  review caught an earlier budget that could deny valid complex receipts; the
  corrected worst-shaped scan/hint regression completes in 144 actual reads,
  and an overrun regression stops at 160 without reporting success.

The [source review](UPGRADEABLE_TOKEN_REVIEW.md) records independently recompiled
WETH/USDG implementations, compiler layouts and USDG admin facet, plus incomplete
governance-source/member evidence. The source snapshot is block **59,702,441**,
hash `0x7e18a93cf71e6bb1f094f4a5552475590034e763e7154c1cac16a35cba8108a7`.
The review, implementation and adversarial tests received separate agent review;
this is internal engineering review, not an external security audit.

## Fork evidence

The [five-case matrix](upgradeable-deposit-fork-2026-09-10.json) starts at block
**59,708,295**, hash
`0x5cf6cea92a1c13706d01b82793da99989de61db1f024013121e652b69ca17f1f`.
The [separate native-input run](upgradeable-deposit-native-2026-09-10.json) starts
at block **59,711,880**, hash
`0xfc008b26cce5014ae77921577e3b4a1693b515c9de284e38f04a28474908ad02`.
Both rechecked source canonicality at the end and closed their read-only upstream
gateway. Their reviewed manifest ID is
`6db1094dad2d264cfce4a53effe9286aa0a3613a973bf70de510d6b4c47cb87f`.

| Selection | Five-case matrix | Supplement | Observed result |
| --- | --- | --- | --- |
| WETH as input, WETH/USDG | Passed, 5 wallet steps | — | Both approvals and Permit2 authorizations, mint, NFT and token receipt |
| USDG as input, WETH/USDG | Passed, 5 steps | — | Same path with dependent WETH composition |
| ETH as input, ETH/USDG | Read unavailable before any step | Passed, 3 steps | USDG approvals and native-funded mint; native public net amount remains null |
| ETH only, above current price | Preparation rejected, 0 steps | — | Provider nominal amount exceeds its encoded maximum |
| USDG only, below current price | Passed, 3 steps | — | USDG approvals and one-sided mint; WETH observed amount is known zero |

Thus **four paths have observed successful reviewed-profile mints across the two
runs**, not five successful paths or one clean full-matrix run. Every case has
`testAdmissionOverride: false`; passing cases identify
`reviewed_candidate_not_activated`. No token code/storage was replaced. WETH was
wrapped locally; USDG was transferred from a public protocol address impersonated
only in the isolated child. Test ETH funding changes local balances. The owner
is the synthetic `0x000000000000000000000000000000000000dead`, not a user wallet.

Successful cases verify exact encoded budgets, canonical transaction/NFT
identity, reviewed proxy transfer-event quantities against controlled local
single-transaction wallet deltas, expired-mint reverts and orphaned receipts after
local snapshot restore. The native input run observed a local refund of
`26573494144338` wei; this is experiment-only evidence, not a public receipt field.
Its public native amount is null with `native_net_unavailable`.

The matrix's `deposit_token_check_unavailable` remains recorded. A subsequent
native-input success does not identify or repair the earlier missing read. The
matrix gateway recorded one upstream RPC error, but that alone does not prove
the exact failing predicate. No wallet step was issued in that failed case.

The native-only composition reported nominal `1000000000000000` wei while its
encoded `amount0MaxRaw` and native value were `999999999998973` wei. The existing
contradiction check rejected it. Do not weaken the check or qualify that path from
the other successes. Earlier provider findings in #42 remain applicable.

The gateway made 336 upstream reads for the matrix and 107 for the supplement.
Its deliberate forbidden-method/malformed-request negative controls are recorded
as rejected requests. `eth_sendTransaction` and Anvil mutations occurred only
inside the isolated fork. **Mainnet transactions: 0; production admission changes:
false.** No listener, Worker, frontend hook or personal bot was changed or enabled.
Anvil gas/finality observations do not qualify Nitro net fee/refund accounting or
production finality. The [RPC report](DEPOSIT_RPC_QUALIFICATION.md) remains separate.

## Verification

- **850 backend tests passed**, PostgreSQL and EVM enabled, zero skips.
- **518 bridge/contract-consumer tests passed**, zero skips.
- Strict deposit TypeScript consumer check passed.
- All four shared-contract exports and read OpenAPI matched their producers.
- New adversarial tests cover upgrade-to-tax behavior on an actual local EVM,
  same-code implementation address changes, admin/beacon/delegate changes,
  pause/freeze, account predicates, archive/legacy evidence, redelivery without
  changing the issued step, historical evidence failures and resource limits.

Reproduction uses the pinned development environment and isolated test database:

```sh
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -v
npm run check:read-bridge
backend/.venv/bin/python scripts/export-deposit-contract.py --check
backend/.venv/bin/python backend/dev_postgres.py stop
```

The explicit network qualification command from the [fork runbook](DEPOSIT_FORK_QUALIFICATION.md)
also accepts `--reviewed-profiles reports/robinhood-reviewed-token-profiles-2026-09-10.json`.
It requires locally configured read-only RPC/Uniswap access and is not part of CI.
Expired or changed profiles require new review; rerunning the helper does not
renew them. Preserve failed runs as well as successful observations.

## Consumer migration and remaining activation gates

This is a coordinated pre-release migration of undeployed, unacknowledged
`deposit-v1` **1.0.0**. New v2 admission references, required receipt amount-basis
fields and three finite errors are specified in the [shared package](../api-contracts/deposit-v1/README.md)
and [runbook](../docs/REVIEWED_TOKEN_ADMISSION.md). The issue contains the early
change notice; final exact-package acknowledgment by OxDecimal is required before
frontend integration. No read/session/onboarding payload or frontend file changed.

Issuer upgrades, pauses, freezes and the check-to-inclusion window remain real
risks. Matching historical endpoints cannot exclude a same-block upgrade and
restoration. Proxy receipt quantities are reviewed transfer-event observations,
not an independently proven transaction balance trace. USDG owner and PoolManager
must be in payout group zero; enrolled accounts are outside this initial profile.
Governance code/getter pins do not establish a guaranteed upgrade delay.

Public activation still depends on peer review, unresolved #41 nonce/capacity
findings, frontend contract acknowledgment/integration, HTTPS/Cloudflare staging
and release qualification. Unsupported provider compositions remain blocked.
Rollback keeps execution disabled, preserves operation/reservation history and
review archives, and restores matching producer/consumer packages together.
