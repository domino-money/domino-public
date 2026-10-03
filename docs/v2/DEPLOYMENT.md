# Domino V2 deterministic deployment

The V2 tooling prepares **unsigned** deployment transactions, checks the chain before the owner signs, and
verifies the result afterwards. It never loads a private key, never signs and never broadcasts to a public chain;
every call it makes to a public RPC is a read. Its only senders are Anvil instances that it starts itself or
validates as a loopback Anvil (`deploy-anvil.mjs`, `deploy-local.mjs`, `deploy-fork.mjs`).

| File | Role |
| --- | --- |
| `scripts/v2/deploy.mjs` | Compile, prepare, preflight, resume, check signed transactions, verify, explorer input (CLI and library) |
| `scripts/v2/deploy-anvil.mjs` | Private Anvil instances, the offline gas simulation, rehearsal test accounts |
| `scripts/v2/deploy-local.mjs` | Local deployments: an Anvil fork of a real chain, or an offline Anvil |
| `scripts/v2/deploy-fork.mjs` | The three-chain fork rehearsal |
| `scripts/v2/deploy-schema.mjs`, `deploy-manifest.schema.json` | The manifest: JSON Schema plus semantic rules |

## Components and addresses

The deploy set is the F0 set: Registry, PriceAnchor, AutoExit, VaultSwap, the v3 and v4 vault implementations,
the v3 and v4 factories, ZapV3, ZapV4Steps and ZapV4. Each implementation creates its executor at its own CREATE
nonce 1. A deployment is therefore **11 CREATE3 transactions and 13 Domino runtimes**.

CreateX is `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`; its runtime Keccak-256 must be
`0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f`. For each F0 component name, dots included:

```text
rawSalt     = deployer[20 bytes] || 0x00 || first11(keccak256("domino.v2." + component))
guardedSalt = keccak256(abi.encode(deployer, rawSalt))
proxy       = CREATE2(CreateX, guardedSalt, keccak256(0x67363d3d37363d34f03d5260086018f3))
component   = CREATE(proxy, nonce = 1)
executor.vN = CREATE(vault.vN, nonce = 1)
```

The zero chain byte disables CreateX's chain protection, so a deployer gets the same 13 addresses on 4663, 8453
and 42161; constructor values and runtime hashes still differ per chain. A foreign caller does not make CreateX
revert: it deploys under its own namespace, elsewhere. The offline tests run this against the canonical CreateX
runtime.

For the owner's deployer `0x706627E3E75b0603c4B6f9a1eBBfc635dA712747` (a test pins these):

| Component | Address | Component | Address |
| --- | --- | --- | --- |
| registry | `0x25d4f013ecff3790e384e16ca9951bba6cd715fa` | vaultFactory.v4 | `0xc71a561853514efc2271f1d10c13ec95834792ba` |
| priceAnchor | `0x8c1edc4280d9533f6336f760380ba329e1f81f43` | zap.v4.steps | `0x355b0997d5e04392862a8e8d21d911851b2eefbe` |
| autoExit | `0x6109fc514a88a8e85e6e5c863238ddba9a98be36` | zap.v3 | `0xe30d7e07a67198c45d4c7b67d8423cbb6c7ea5a0` |
| vaultSwap | `0xbf22a36bbb419846e073cf0c6c729f669d7f348a` | zap.v4 | `0x376b92929bbe778c6dd64e8d73f8688686288e8a` |
| vault.v3 | `0xd55c0f5ff8ad1ded828edb36be77e0f3677ad4a4` | vaultExecutor.v3 | `0xd8d3bf832b234855fee2ac36ac4803aa7f9adca9` |
| vault.v4 | `0xa3ff8d74e4ec4a19f35d92b7eec852ba6f7e2bbb` | vaultExecutor.v4 | `0xf3f68d8461c2071e2b8d88a60ce64f527f1d6639` |
| vaultFactory.v3 | `0xa7dfb61a6597d09742cb7f9a8780c9c74ebc34f4` | | |

`node scripts/v2/deploy.mjs addresses --deployer <address> --out <file>` prints them for any deployer.

**The deployer key is a high-value key.** With chain protection off, it can claim these addresses on any chain
that has CreateX, permanently. An identical address on a new chain proves nothing about what is deployed there:
always verify the code.

## Constructor arguments and order

Per-chain addresses and charge currencies come from the enabled profile in `api-contracts/v2/chains/`. Every
dependency must have exactly one verified code hash there, and Universal Router must be 2.1.2 or newer.

| Order | Component | Constructor arguments |
| ---: | --- | --- |
| 1 | `registry` | governance, guardian, 86400-second timelock, fee recipient, [operator], [publisher], [Universal Router], charge currencies and ranks |
| 2 | `priceAnchor` | Registry, v3 factory, v3 init-code hash, v4 StateView, minimum TWAP 60 s |
| 3 | `autoExit` | RouteConfig, PriceAnchor, observation age 300 s, minimum TWAP 600 s |
| 4 | `vaultSwap` | RouteConfig |
| 5 | `vault.v3` | Deployment: v3 factory, Registry, PriceAnchor, v3 PositionManager, VaultSwap, AutoExit; creates its executor |
| 6 | `vault.v4` | The same with the v4 factory and PositionManager |
| 7, 8 | `vaultFactory.v3`, `.v4` | Its implementation |
| 9 | `zap.v4.steps` | None |
| 10 | `zap.v3` | RouteConfig, v3 PositionManager |
| 11 | `zap.v4` | RouteConfig, v4 PositionManager, ZapV4Steps |

RouteConfig is `(registry, permit2, v3Factory, v3PoolInitCodeHash, v4PoolManager)`. The implementation stores its
future factory's precomputed address; the factory, deployed after it, checks the implementation's wiring.
`governance` is the owner's Safe from the registry's constructor on: the deployer never holds governance, and
there is no post-deployment transaction. The tariffs recorded as policies are checked against the compiled
constants (`DominoV2Types` fees, `MIN_UNIVERSAL_ROUTER_VERSION`) and the profile's bridge fee.

## The owner's procedure

Prepare and verify from a clean checkout of the reviewed commit. Public preparation refuses uncommitted changes
under `contracts/src/v2`, `scripts/v2`, `api-contracts/v2` and `scripts/solc-compile.cjs`, a chain profile that is
not the committed one at that commit, and any RPC that is a development EVM (Anvil, Hardhat, Ganache, Tenderly).

**Inputs.** `roles.json` has exactly six EIP-55 checksummed addresses. A lower-case or mistyped address is
refused, as are zero, placeholder-looking addresses (below 2^16 or one digit repeated), operator = publisher, a
role that is a component or CreateX, and, for a public deployment, any of the ten public test-mnemonic keys
(the same list `backend/v2_manifest.py` refuses).

```json
{ "deployer": "0x706627E3E75b0603c4B6f9a1eBBfc635dA712747", "governance": "0x2B1d4098EC880058886B95A0E75069a7099C5a9d",
  "guardian": "0x5e57FDEd90C4635648Eb7b3ba29705Ff0769D103", "feeRecipient": "0x1488C84dAFc03F7f4c4fB986F83bA99Fd530c6f4",
  "operator": "0x64b72517D8b0d72BE25F814b4e03985Cf15e098A", "publisher": "0x07C7E7f92e2C76c9cb8D7F2aE44caa6877fc7DF3" }
```

These are the owner's addresses of 2 Oct 2026; governance is the owner's Safe (1.5.0, 2-of-3, the same address on
the three chains). Keep the RPC URL in a private file (mode 0600, one URL) and pass it with `--rpc-file`, so a key
in the URL never reaches the command line or shell history; `--rpc` is for URLs without secrets. The file rules are
V1's (`prepare-financial-release.mjs verificationRpcEndpoint`). No command overwrites an output file.

1. **Prepare.** It reads the chain at a pinned block and writes the package and its preflight report
   (`<out>.preflight.json`), or nothing:

   ```sh
   node scripts/v2/deploy.mjs prepare --chain-profile api-contracts/v2/chains/base-8453.json \
     --roles ~/private/v2-roles.json --release-tag v2-2026-10-03 --rpc-file ~/private/rpc-base \
     --out ~/private/v2-base.json
   ```

   Options: `--max-fee-per-gas`, `--priority-fee-per-gas` (wei) and `--valid-hours` (1-168, default 24). The
   package expires: a preflight, a resume or a signed-transaction check refuses it afterwards.
2. **Review** the package and the report: addresses, constructor arguments, gas limits, fees, worst-case cost
   and the warnings. A warning never blocks; today the owner's Safe gives two (its owners include the deployer
   and the guardian, as the owner chose).
3. **Preflight again right before signing:** `deploy.mjs preflight --package <file> --rpc-file <file> --out <report>`.
4. **Sign offline and check before broadcasting.** Sign each step's transaction (EIP-1559, the package's exact
   fields) and put the raw signed transactions in a file, one per line, then
   `deploy.mjs check-signed --package <file> --signed <file>`. It refuses a transaction that another key signed
   (CreateX would deploy it elsewhere), or that differs from its step in any field.
5. **Broadcast one transaction at a time.** Wait for each receipt before the next; stop at the first failure or
   ambiguity. Never resend a transaction whose outcome is unknown, never shift nonces by hand.
6. **After an interruption, resume.** `deploy.mjs resume --package <the last package> --rpc-file <file> --out <new>`
   proves every deployed component by its exact runtime hash (and CreateX's spent proxy), refuses any other code at
   a target address, refuses while the deployer has a pending transaction, and prepares only the remaining steps,
   from the deployer's current nonce, with fresh gas and fees. The new package names its predecessor (`resumeOf`)
   and passes the same preflight. Then continue from step 2.
7. **Verify** once final: `deploy.mjs verify --package <any package of this deployment> --receipts <hashes.json>
   --rpc-file <file> --out docs/deployments/v2-<slug>-<chainId>-<date>/deployment.json`, where `hashes.json` maps
   each of the eleven component names to its transaction hash, then `deploy.mjs validate --manifest <file>`.
   Verification reads at `finalized` by default; a deployment newer than that block is reported as
   `deployment_not_final_at_finalized`, not as wrong code.
8. **Block explorers:** `deploy.mjs explorer-input --package <file> --out <file>` writes the exact standard-JSON
   compiler input and each component's fully qualified name, address and ABI-encoded constructor arguments
   (executors take their vault's `Deployment`).

## Preflight

The preflight pins one block, re-reads it at the end (`preflight_anchor_reorg`) and refuses unless:

| Check | Refusal |
| --- | --- |
| The package was rebuilt from its parameters and the current compile, and has not expired | `unsigned_package_changed`, `package_expired` |
| The RPC is not a development EVM (public packages) | `development_chain_refused_for_public_preparation` |
| Chain id, CreateX, Uniswap v3/v4, Permit2, Universal Router and charge currencies have the profile's code hashes | `chain_id_mismatch`, `dependency_codehash_mismatch: <name>`, `charge_currency_*` |
| The dependencies point at each other: NPM `factory()`/`WETH9()`, QuoterV2 and SwapRouter02 `factory()`, v4 PositionManager `poolManager()`/`permit2()`, StateView and V4Quoter `poolManager()` | `v3_manager_factory_mismatch`, `v4_state_view_pool_mismatch`, ... |
| Governance is a Safe: a canonical proxy (1.3.0, 1.4.1, 1.5.0), a canonical singleton (L1 or L2) with its code hash and `VERSION()`, threshold >= 2, owners >= threshold, no module, no guard | `governance_has_no_code`, `governance_not_a_safe_proxy`, `governance_singleton_*`, `governance_threshold_below_two`, `governance_owners_invalid`, `governance_has_modules`, `governance_has_guard` |
| The deployer's nonce is the package's first, and nothing of it is pending | `deployer_nonce_mismatch`, `deployer_has_pending_transactions` |
| Each target and its CREATE3 proxy is empty; on resume, each component outside the package holds exactly its runtime | `component_already_deployed`, `resume_prerequisite_missing`, `component_address_conflict` |
| Each gas limit covers the simulated execution plus the live L1 component | `gas_limit_below_requirement: <component>` |
| The max fee covers the pinned block's base fee | `max_fee_below_base_fee` |
| The balance covers the worst case: Σ gas limit × max fee, plus each OP L1 fee with 25% headroom | `deployer_balance_insufficient` |

A governance owner that holds another Domino role is reported as a warning (`governance_owner_holds_role:
<role>`). Local packages (`fork-rehearsal`, `local-test`) check the Safe only on request, and record an L1
estimate the local EVM cannot give as `unavailable`.

## Gas, fees and funding

Each step's gas limit is `ceil((simulated execution + live L1 gas) × 125%)`, capped at EIP-7825's 16,777,216.
The execution is measured by running the package's exact calldata, all eleven steps in order, on a private offline
Anvil at the chain's id, with canonical CreateX and constructor stubs at the dependency addresses: on the forks it
came within 0.02% of the real dependencies' gas. The L1 component is read live:

- Robinhood and Arbitrum (Nitro) charge it as L2 gas inside the limit: `NodeInterface.gasEstimateL1Component`.
- Base (OP Stack) charges an L1 fee in wei on top: `GasPriceOracle.getL1Fee` of the unsigned serialized transaction.

Default fees: no tip on Nitro (it is ignored there), the node's suggestion on Base; max fee = 3 × the pinned base
fee + tip. The report's `maxFeeCeilingWei` is the highest max fee the balance would cover: about 0.26 gwei on Base
with 0.0127 ETH, so the default (about 0.016 gwei on 2 Oct) is far below it. Measured on forks on 2 Oct, with
the owner's real balances, the whole deployment costs about 0.0012 ETH on Robinhood, 0.00023 ETH on Base and
0.00078 ETH on Arbitrum ([report](../deployments/v2-rehearsal-2026-10-02/README.md)).

## Verification

`verify` checks, at one block: every receipt successful, canonical and at or before that block; each transaction
from the deployer to CreateX with exactly its step's input (any nonce, gas and fees, so resumed steps verify too),
no value, the chain id, and CreateX's `Create3ProxyContractCreation(proxy, guardedSalt)` and
`ContractCreation(component)` events; the dependencies as in the preflight; all 13 exact runtimes, immutables
included (precomputed from the compiler's immutable references, never read back from the chain); and the wiring:
governance (and no pending transfer), guardian, fee recipient, timelock, `MIN_UNIVERSAL_ROUTER_VERSION`, halt off,
operator and publisher admitted and separate, router admitted at 212, charge ranks, anchor and auto-exit windows
and domain separator, vault and factory wiring, executors, zap managers and the hook refusal.

## Manifest schema and backend interface

Public manifests live at `docs/deployments/v2-<slug>-<chainId>-<date>/deployment.json`. `validateManifest`
(`scripts/v2/deploy-schema.mjs`) checks the document against `deploy-manifest.schema.json` itself, refusing any
schema keyword it does not implement, then the semantic rules: guarded CREATE3 predictions and salts, the fixed
contract names and policies, roles, dependencies and code hashes, the build's compiler profile and source-tree
hash, complete distinct receipts after the genesis with one hash per block, and a verification at or after every
receipt with an RFC 3339 time checked field by field. `backend/v2_manifest.py` applies the same rules;
`backend/tests/test_v2_manifest.py` runs both over the same file texts and requires the same verdict for each.

| Field | Contract |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `domino-v2-deployment` |
| `status`, `environment` | `prepared` or `verified`; `public-chain-preparation`, `fork-rehearsal` or `local-test` |
| `chain` | `name`, numeric `chainId`, `nativeCurrency` |
| `sourceCommit`, `releaseTag`, `build` | Git commit, release name; compiler profile, each V2 source's SHA-256, the source-tree SHA-256, `workingTreeSourceChanges`, the profile's SHA-256 |
| `contractNames`, `contracts` | The 13 components; dotted keys are literal JSON keys |
| `dependencies`, `runtimeCodeHashes` | Uniswap, Permit2, wrapped native; the exact expected Keccak-256 of every component and dependency |
| `roles`, `policies`, `chargeCurrencies` | The six roles; fixed tariffs, windows and hook refusal; per-chain charge ranks |
| `createx` | Canonical address and code hash; raw and guarded salts of the 11 components |
| `deploymentReceipts`, `verification` | Per component: transaction, block, gas, price; the anchored verification record |

The backend admits a manifest for production only if it is a verified `public-chain-preparation` built from
committed sources, verified at `finalized`, with no public test key among its roles; the fork and local labels
never pass. The unsigned package (`schemaVersion` 2, `domino-v2-unsigned-deployment`) is the owner's working
file, not a backend input.

## Local modes

```sh
anvil --fork-url <chain RPC> &                       # keeps the real chain id
node scripts/v2/deploy-local.mjs --rpc http://127.0.0.1:8545 --out /tmp/v2/deployment.json
```

- **fork** (default): an Anvil fork of Robinhood, Base or Arbitrum that keeps the real chain id, so EIP-712 domains
  are production's. The committed profile's real Uniswap, Permit2 and CreateX are checked by code hash. The
  manifest says `environment: fork-rehearsal`.
- **offline** (`--mode offline`): a plain Anvil; canonical CreateX's runtime and constructor stubs
  (`DependencyFixture.sol`) at the dependency addresses. No Uniswap, Permit2 or journeys. The manifest says
  `environment: local-test`.

Neither mode can write a `public-chain-preparation` manifest; a fork mode run on a plain Anvil, or an offline run
on a fork, is refused. Both run the owner's sequence (plan, preflight, one transaction at a time, verify), fund the
impersonated deployer synthetically when needed (recorded in `<out>.preflight.json`), and resume a run that was
interrupted: deployed components are proven by code hash and their creations found in CreateX's logs.

Roles default to the rehearsal test accounts, `privateKey = keccak256("domino.v2.rehearsal.<role>")`: public,
for disposable EVMs only (`--roles <file>` replaces them). The public test mnemonic cannot serve on forks: its
accounts carry EIP-7702 sweeper delegations on all three chains. `--production-deployer` impersonates the owner's
deployer, so every address, and on a fork every domain, equals production's. The command writes the manifest,
`.unsigned.json`, `.receipts.json` and `.preflight.json`.

`scripts/v2/deploy-fixtures/deployment.fixture.json` is a verified `local-test` manifest of the offline mode. To
regenerate it after a V2 source change (the backend keeps a copy, `backend/tests/fixtures/v2-deployment-local-fixture.json`):

```sh
anvil --port 8545 &
node scripts/v2/deploy-local.mjs --rpc http://127.0.0.1:8545 --mode offline --out /tmp/v2-fixture/deployment.json
cp /tmp/v2-fixture/deployment.json scripts/v2/deploy-fixtures/deployment.fixture.json
```

## Tests and CI

```sh
node --test scripts/v2/deploy.test.mjs scripts/v2/deploy-preflight.test.mjs scripts/v2/deploy-schema.test.mjs scripts/v2/deploy-fork.test.mjs
```

They run offline in the Backend job. They cover the production addresses, salts and the foreign-caller
namespace on canonical CreateX; role input; every preparation bound; the preflight's checks one by one against a
real Safe (the canonical SafeL2 1.4.1 runtime, `deploy-fixtures/safe-runtime.json`, LGPL-3.0 in `Safe.LICENSE`) on
a disposable EVM, each refused one unit short and passed at its bound; resume after an interruption; verification
refusals; signed-transaction checks; explorer input; provenance; the local modes; and the fork harness's guards.
The tests reuse their compile for an identical standard-JSON input (`DOMINO_V2_COMPILE_CACHE`, cached by CI under
the V2 sources and compiler); production commands always compile.

The vendored CreateX runtime was read without a transaction from Robinhood and matches its published hash; its
AGPL-3.0-only license is in `CreateX.LICENSE`. Reference: [CreateX](https://github.com/pcaversaccio/createx).

## Fork rehearsal

`deploy-fork.mjs` deploys the owner's package on Anvil forks of Robinhood (only through the own node's tunnel),
Base and Arbitrum, with the owner's roles, Safe and real deployer balance, and runs the owner-role exercise, pool
creation and the journeys. It runs outside CI because it needs the networks; the results are in
[`docs/deployments/v2-rehearsal-2026-10-02/`](../deployments/v2-rehearsal-2026-10-02/README.md).
