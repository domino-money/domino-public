# Backend wallet-session implementation evidence

10 September 2026 · [Backend #31](https://github.com/domino-money/domino/issues/31)
· dependency of [frontend #14](https://github.com/domino-money/domino/issues/14)

The disabled candidate implements five session endpoints, a separate Access-authenticated
loopback listener/BFF, plain-EOA SIWE verification, and shared PostgreSQL challenges,
sessions and limits. It changes no `app/` or `web/` files and no `read-v1` payloads.
It does not deploy authentication, private settings, public vaults or financial
execution. See [runbook](../docs/WALLET_SESSIONS.md) and
[shared contract](../api-contracts/session-v1/README.md).

## Checks actually completed

| Evidence | Result and scope |
| --- | --- |
| Full Python suite with `DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1` | 464 tests passed, no skips; disposable local PostgreSQL and pinned local Anvil/Solidity tools |
| Final startup hardening | Six additional temp-directory launcher tests passed; 14 API tests rechecked after this change |
| Independent backend review | 57 focused tests passed: 20 PostgreSQL transitions, 17 SIWE/account checks, 14 listener and six launcher tests |
| Read + session Worker/shared-contract suites | 365 tests passed, including existing read behavior and 127 new session boundary/fixture cases |
| Shared TypeScript | Strict NodeNext compilation passed for the session types/runtime declarations |
| Model/fixture exports | Session export check and existing 113-file read export/OpenAPI checks passed; read contract unchanged |
| Dependencies | Isolated Python 3.14.3 environment, exact SIWE/eth-account/ABNF versions tested; `pip check` passed; prior dependency pins preserved |
| Repository checks | Staged-file hygiene and whitespace checks passed; no frontend source changes or private runtime files included |

The first full run started before task-local npm tools were ready and had two
EVM setup errors for missing solc. After installing the existing pinned root
dependencies, the full PostgreSQL/EVM run above passed. No EVM case was waived
or converted into a skip. CI also runs the final combined set including the six
launcher tests; its current result is attached to the PR, not assumed here.

The first Linux CI run exposed a test-fixture timing race: its 100ms idle-expiry
window could end during connection/setup, allowing cleanup to remove the row
before the intended touch. Both final-expiry tests now arm the real DB expiry
inside the transaction after cleanup, assert the target mutation was reached,
then verify rollback. This preserves the security assertion across differing
runner speeds without relaxing production expiry or timeout controls.

Tests use reserved hosts, synthetic keys/messages, mock provider responses and
an isolated database. PostgreSQL tests exercise real transactions and grants;
fake providers do not establish real RPC availability or wallet compatibility.
The shared fixtures are deterministic, model-validated examples; frontend
adapter rendering and HTTPS/Tunnel integration are separate evidence.

## Security scenarios and independent findings

| Accepted design case | Implemented verification |
| --- | --- |
| S01 message identity/expiry | Exact server message; scheme/domain/URI/address/chain/nonce/statement/time mutations rejected even when independently signed |
| S02 single use and races | Atomic attempt reservation and consume/create; concurrent valid verifies yield one session; lost response cannot replay; same-context logout wins before/after consume |
| S03 context binding | Wrong preauth/CSRF/challenge pairing denied; unrelated context cannot replace or revoke active login |
| S04 bounded inputs/work | UTF-8 byte/signature limits, duplicate keys, body deadlines, global admission, shared IP/address limits, fixed table capacities and bounded cleanup |
| S05 code-bearing accounts | Pinned fresh chain/block/code recheck; delegated/contract code rejected; unavailable code denies without guessing; later observed code revokes `me` |
| S06 fixation/origin | No bootstrap or verify replacement of a presented active session; exact origins; cookie/CSRF separation; named credential forwarding only |
| S07 durable lifecycle | Restart/shared-store revocation, absolute/idle expiry, fresh DB-clock guard and rollback if expiry crosses during final insert/touch |
| S08 account/chain changes | Server identity stays bound to the signed address/4663; other fields cannot choose owner. Actual wallet-switch UI remains #14 |
| S09 store isolation | Catalogue roles cannot read/change auth tables; auth role cannot read catalogue, create auth tables, assume writer role or truncate sessions. No private tenant-object API exists yet |
| S10 exposure/retention | No-store fixed error envelopes, no raw provider/database diagnostics, bearer directives stripped, aliases rejected, hashes in DB; deployment-wide redaction/retention remains a release gate |

Independent implementation review reproduced and closed these issues before
publication: dispatch from an already-aborted request; rounded fractional chain
IDs; producer credential/CSRF alias leakage; elapsed-upload acceptance before a
timer callback; stale DB-time checks; IPv6 interface-address rate resets; and
cross-context active-session replacement/logout races. Root review also required
IP limits before unknown-session lookup, strict UTF-8 content types, harmless
Tunnel metadata handling, explicit RPC configuration and private lock-file checks.
Regression tests and re-review cover the fixes. These are internal reviews, not
an external security audit.

The chosen alpha rule refuses active-session replacement with `session_exists`;
logout must finish before a new identity signs in. This is a documented
clarification of the initial rotation design, consistent with its original
bootstrap guard, and avoids adding session-family permissions. Expired/inactive
cookies and pre-login state can still rotate. `me` rotates CSRF, so stale tabs
must refresh/retry with the current token.

## Delivery boundary

Both activation switches remain off. The frontend owner still needs the pinned
contract notice, adapter/wallet/multi-tab tests and acknowledgement. Cloudflare
credentials, real HTTPS cookie/ingress tests, production private-role setup,
restore invalidation, cleanup/observability and independent external security
review are required before public exposure. None of these is represented as
completed by unit tests or a passing PR check.
