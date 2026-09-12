# Vault v2 architecture verification

12 September 2026 · [#88](https://github.com/domino-money/domino/issues/88) prerequisite · **local candidate, independent collaborator review pending**

Base: main `710b52f13ef06b77ddc122fcbbadb19d2c29f7be`. The [architecture decision](../docs/PUBLIC_VAULT_V2_ARCHITECTURE.md) defines the extraction, identity/version change and remaining execution gates. This report does not qualify a deployed Robinhood contract or claim compound/Domino/swaps implementation.

## Result and reproducibility

Production source measured by the integrated Forge build:

| Contract | Runtime bytes | Runtime headroom | Creation bytes | Constructor args | Complete initcode |
| --- | ---: | ---: | ---: | ---: | ---: |
| DominoVault v2 | 20,440 | **4,136** | 24,853 | 160 | 25,013 |
| DominoVaultReadHelper | 3,472 | 21,104 | 3,666 | 64 | 3,730 |
| DominoVaultFactory | 2,286 | 22,290 | 27,955 | 128 | 28,083 |

Runtime headroom uses the 24,576-byte limit. Complete initcode includes the fixed ABI constructor arguments and stays below 49,152 bytes. The factory's creation code already contains nested deployment payloads. EIP-1167 clones remain exactly 45 runtime bytes, verified by the factory suite.

The vault recovers **3,673 runtime bytes** relative to 24,113. This is not the same as eliminating 3,673 bytes from the whole deployment: part of the code moved into a separately deployed helper. The helper is shared by clones of one implementation. Final source SHA-256 values (source bytes, not deployed runtime hashes):

- Vault: `5dfa5c02251f20b1547fbc00756c380dd0dcf77b8ba771a7479b11b6605ecd6d`.
- Helper: `b3e64689c0b8ee296f11c10c9bbca339ef096afd22d90f6a78da856eae0a690f`.

From a clean supported checkout:

```sh
npm ci --no-audit --no-fund
npm run test:contracts
node scripts/check-contract-size.mjs --json
npm run check:repository
```

The contract command uses the pinned native Forge 1.7.1 and solc 0.8.26 offline, via IR, optimizer 200, Cancun, metadata bytecode hash `none`. It runs launcher/gate regressions, Forge and then the artifact gate, propagating failures. Additional Forge filters still work through `npm run test:contracts -- --match-test ...`. The standalone gate reads artifacts; it does not prove source freshness on its own, so use the integrated build before it. It rejects a wrong compiler profile, missing/malformed artifacts, library links, changed constructor ABI, runtime/initcode overflow, a vault reserve below 4,000 bytes and a helper ABI with mutable/payable/fallback entry points.

## Alternatives measured before the selection

Same base source, pinned solc and Cancun, no metadata bytecode hash:

| Profile / structural experiment | Vault runtime | Headroom |
| --- | ---: | ---: |
| Existing structure, legacy compiler path, optimizer 200 | 24,113 | 463 |
| Existing structure, legacy compiler path, optimizer 1 | 23,909 | 667 |
| Existing structure, via IR, optimizer 200 | 21,521 | 3,055 |
| Existing structure, via IR, optimizer 1 | 21,606 | 2,970 |
| Read/checkpoint extraction only, via IR 200 | 21,019 | 3,557 |
| Read/checkpoint/identity extraction using getter callbacks, via IR 200 | 20,003 | 4,573 |
| **Selected v2: direct typed context, live helper pin, via IR 200** | **20,440** | **4,136** |

The intermediate experiments were compilation-only scratch candidates, not reviewed custody implementations. The selected implementation removes helper-to-vault getter callbacks despite their smaller size. No state-writing extension, linker target, arbitrary delegate dispatcher, administrator or upgrade endpoint was introduced. Future financial code must be measured again; 4,136 bytes do not prove that all of E4/E6/E7 fit.

## Executed checks

- **129 Foundry tests passed, zero failed/skipped**, including 512-run fuzz cases. The original main baseline also passed its 122 tests independently.
- **14 Node tests passed, zero failed/skipped**: 3 launcher regressions and 11 artifact gate tests.
- **1,295 backend tests passed, zero skipped**, with `DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1` and an isolated PostgreSQL/Anvil environment. The temporary PostgreSQL service was stopped afterward. This base excludes the separately pending #113/#114/#115 work; their test counts are not attributed to this branch.
- Repository hygiene and `git diff --check` passed.
- Compiled method inventory: all **52** prior vault method selectors retained; only `readHelper()` (`b6264ff9`) and `readHelperCodeHash()` (`fdca9458`) added. Existing custody error names remain; `ReadHelperUnavailable()` is additive. The version getter now returns 2.
- Independent internal source review found no concrete regression in custody/storage/callback bodies or E1 field order/width. This is supporting evidence, **not collaborator approval or a public-release audit**.

New architecture regressions cover clone isolation with a shared fixed helper; independent version-2 identity reconstruction and version-1 mismatch; direct forbidden helper calls; missing helper; changed but still callable helper code; failed factory creation rollback and same-address retry; explicit rearm after root invalidation; and native/ERC20 original/charged/untracked balances plus child/unmanaged/root NFT recovery while the helper is absent. Existing tests retain exact transfer accounting, owner-only exits, counter exhaustion, nested receipt ordering and the cold-clone 100,000-gas unsubscribe boundary.

Code removal/restoration uses Foundry `etch` as a fault-injection tool. There is no such replacement operation in the helper or vault. Artificial reserve credits use the existing test-only harness; these tests do not assert real swap-earned collection provenance.

## Local gas comparison

The original 122 tests were run on both versions with `--gas-report`; the new architecture suite was excluded from the comparison so its extra calls do not change the sample set. These are mock-EVM figures, not Robinhood transaction estimates or USD prices.

| Same local fixture | Version 1 | Version 2 | Difference |
| --- | ---: | ---: | ---: |
| Factory deployment including implementation/helper | 5,897,570 | 5,835,127 | −62,443 gas |
| Production vault rearm sample (one call) | 175,926 | 181,574 | +5,648 gas |

The helper adds read/call overhead even though the aggregate deployment sample is slightly cheaper. No compound method exists here, so no compound gas saving or optimal execution interval is claimed. Future E4 general/net measurements must use actual pinned PositionManager effects, including native/refund/fee-provenance controls and minimum-liquidity protection.

## Review and remaining work

This increment is the structural prerequisite only; it does **not** close #88. Independent review must cover the new dependency pin, version identity and compiler profile before compound relies on this structure. General compound then netting remain next; #89 recovery supports #90 Domino; #91 typed fee-funded swaps follows. Existing E1/E3 candidates and real manager qualification remain separate dependencies. No wallet, signer, personal-bot runtime, live provider, VM, DNS, contract deployment or frontend field was used or changed.
