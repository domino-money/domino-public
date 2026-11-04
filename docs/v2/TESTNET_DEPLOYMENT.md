# Domino V2 on a public testnet

Launch round P3, item 7 (4 Nov 2026): testing with tokens of no value. This page covers deploying the frozen V2
release to **Base Sepolia (84532)** and **Arbitrum Sepolia (421614)**: what the freeze allows, the tool, and the
steps that need a person, keys or funds.

## Where it stands

| Ready in the repository | Needs a person |
| --- | --- |
| `scripts/v2/deploy-testnet.mjs` and its offline tests (a full deployment at chain id 84532 on Anvil) | Fresh testnet keys, a testnet Safe, faucet funds |
| The rule that no public or production key can hold a testnet role | Each chain's profile: addresses from the official sources, code hashes read from the chain |
| This runbook | Signing and broadcasting the eleven transactions per chain |

Nothing here changes `contracts/src/v2`, a release input or `contracts/release-artifacts-v2.json`.

## What the freeze allows

`scripts/v2/deploy.mjs` is a frozen release input ([FREEZE.md](FREEZE.md)). Its command cannot prepare a testnet
package, and changing it would make a new V2 candidate:
- `prepare` always builds a `public-chain-preparation` package, and that environment admits only
  `ENABLED_CHAINS` (4663, 8453, 42161): any other chain id is `unsupported_chain_profile`.
- A public package needs its profile committed in `api-contracts/v2/chains/`. Every enabled profile there is a
  production chain for the backend's registry (`backend/v2_chains.py`) and could not stay a testnet.
- `deploy-local.mjs` sends only to a loopback Anvil, and its fork mode takes only the three production chains.

`scripts/v2/deploy-testnet.mjs` therefore changes nothing frozen. It drives deploy.mjs's own functions
(compile, plan, preflight, check-signed, verify, explorer input), unchanged, with the one environment they take
for another chain id: `local-test`. It puts back what a public package proves:
- the chain is Base Sepolia or Arbitrum Sepolia, never a production chain;
- the profile is the one committed under `api-contracts/v2/testnets/` at the compiled commit, a directory no
  registry, service or app reads;
- the checkout is clean, and its compile is the reviewed release manifest's (`checkReleaseManifest`): the bytecode
  is the frozen release's;
- the roles pass deploy.mjs's public rules (six checksummed addresses, no placeholder, operator ≠ publisher, not
  the mnemonic's first ten), and none is a key others hold or a production role: the public mnemonic's first 100
  accounts (`api-contracts/v2/public-test-accounts.json`), the rehearsal accounts and rehearsal Safe owners, and every
  role of the committed production deployments (`docs/deployments/*/deployment.json`: V1's mainnet deployment and
  V2's public-chain preparations, the owner's deployer, Safe, guardian, fee recipient, operators and publishers);
- governance is a Safe (1.3.0, 1.4.1 or 1.5.0 canonical, threshold at least 2), as the preflight requires on
  production, and none of its owners is one of those addresses either (review L4, 4 Nov 2026), at `prepare` and
  again at `preflight`.

Like deploy.mjs, it never loads a key, signs or broadcasts. Its manifests say `environment: local-test`: the
backend's production admission (`backend/v2_manifest.py`) and the app's production build never take one, so a
testnet deployment can never be taken for Domino's.

## Steps

1. **Owner decisions** (end of this page), before anything else.
2. **Keys and funds** (the owner, on each chain; never on this machine):
   - fresh keys for the deployer, guardian, fee recipient, operator and publisher, used nowhere else; never a
     production key (the tool refuses every committed production role) and never a public one (it refuses the
     known ones, but cannot know every public key);
   - a Safe as governance, at least 2 of n, created with Safe's canonical factory on that testnet, its owners fresh
     testnet keys too (the tool checks them; it cannot see the production Safe's owners, which no file records:
     never reuse them);
   - testnet ETH from a faucet for the deployer. The preflight prints the worst case; on mainnet forks the whole
     deployment cost 0.0002 to 0.0012 ETH ([rehearsal](../deployments/v2-rehearsal-2026-10-02/README.md)).
   - `roles.json`: the six checksummed addresses, as for production ([DEPLOYMENT.md](DEPLOYMENT.md)).
3. **Profiles** (anyone, read-only; no key): `api-contracts/v2/testnets/base-sepolia-84532.json` and
   `api-contracts/v2/testnets/arbitrum-sepolia-421614.json`, in the schema of
   `api-contracts/v2/chains/base-8453.json`, with `chainId`, `slug` (`base-sepolia`, `arbitrum-sepolia`),
   `stack` (`op-stack`, `arbitrum-nitro`) and `enabled: true`.
   - **Addresses** from the official sources only, each cited under `sources`: Uniswap's deployment lists (v3
     factory, NonfungiblePositionManager, QuoterV2, SwapRouter02, pool init code hash; v4 PoolManager,
     PositionManager, StateView, V4Quoter; Universal Router and its version; Permit2), CreateX's deployment list,
     Multicall3's, Safe's, the chain's own docs for its wrapped ETH, and Circle's for testnet USDC.
   - **Code hashes** of every one, read at one finalized block (`eth_getCode`, then Keccak-256; or
     `cast codehash <address> --block <n>`), into `verification` with that block and the date.
   - **The tool's own checks** then hold them: CreateX at its canonical address with its canonical code hash,
     Universal Router at version 2.1.2 or newer, the bridge fee of 35 bps, one verified code hash per dependency;
     the preflight also checks the dependencies point at each other (NPM `factory()`, PositionManager
     `poolManager()`, ...).
   - **Known open questions**, to settle before signing: whether Universal Router 2.1.2 or newer is deployed on
     each testnet (the V2 registry admits its router at 212: with only an older router, the frozen V2 cannot run
     there faithfully); whether CreateX and a canonical Safe are deployed there.
   - Commit the profiles in a reviewed pull request (data only).
4. **Prepare** from a clean checkout of that commit, with the RPC URL in a private file (mode 0600, one URL):

   ```sh
   node scripts/v2/deploy-testnet.mjs prepare --chain-profile api-contracts/v2/testnets/base-sepolia-84532.json \
     --roles ~/private/v2-testnet-roles.json --release-tag v2-testnet-YYYY-MM-DD --rpc-file ~/private/rpc-base-sepolia \
     --out ~/private/v2-base-sepolia.json
   ```

   It writes the unsigned package and its preflight report (`<out>.preflight.json`), or nothing. Options as
   deploy.mjs's: `--max-fee-per-gas`, `--priority-fee-per-gas`, `--valid-hours` (1 to 168, default 24).
5. **Review** the package and the report, then **preflight again** right before signing:
   `deploy-testnet.mjs preflight --package <file> --rpc-file <file> --out <report>`.
6. **Sign offline** each step's transaction with the testnet deployer's key (EIP-1559, the package's exact fields),
   one raw transaction per line in a file, and check them:
   `deploy-testnet.mjs check-signed --package <file> --signed <file>`.
7. **Broadcast one at a time**, each after the previous receipt; stop at the first failure or ambiguity. After an
   interruption: `deploy-testnet.mjs resume --package <the last package> --rpc-file <file> --out <new>`, then step 5.
8. **Verify** once final: `deploy-testnet.mjs verify --package <file> --receipts <hashes.json> --rpc-file <file>
   --out docs/deployments/v2-testnet-<slug>-<chainId>-<date>/deployment.json` (`finalized` by default); then
   `deploy-testnet.mjs explorer-input --package <file> --out <file>` for the explorer's source verification.
9. Repeat for Arbitrum Sepolia.

A testnet deployment gets its own addresses: a fresh deployer, a fresh CREATE3 namespace. Nothing of it reaches
production; abandoning it is enough to undo it.

## What it does not switch on

The deployment alone does not let anyone test the product with tokens of no value. The app pins the three
production chains (`app/src/v2/chains.ts`) and admits only production manifests in its deployable build; the
listeners, indexers and automation read the production registry (`api-contracts/v2/chains`). Using a testnet
deployment needs, each a piece of work of its own (0xdecimal for the app, rugged97 for the VM):
- the app: a test build or environment that lists the testnet chains and takes their `local-test` manifests;
- the backend: services started on a registry of the testnet profiles, their own database, tunnel and Access
  identities, never production's;
- providers: whether the Uniswap Trading API, Relay and Across serve these testnets at all (the plan and the
  bridge quotes depend on them).

## Owner decisions

1. **The label.** Testnet manifests say `local-test`, the frozen tool's only environment for these chain ids. A
   `public-testnet` environment would change deploy.mjs and its schema: a new V2 candidate, never the audited
   release (FREEZE.md).
2. **Keys and funds.** Who holds the testnet deployer key and the testnet Safe's keys, and who funds them.
3. **A testnet without Universal Router 2.1.2 or newer, CreateX or a canonical Safe**: leave that testnet out, or
   accept a new candidate.
4. **A testnet environment for the app and the backend**, as above: whether and when.
