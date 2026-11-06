# Governance Safe on a new chain

`deploy.mjs` takes governance as a role: a canonical Safe that already exists on the chain, with threshold >= 2, no
module and no guard ([DEPLOYMENT.md](DEPLOYMENT.md), the preflight). On Robinhood, Base and Arbitrum it is the owner's
Safe 1.5.0 `0x2b1d4098ec880058886b95a0e75069a7099c5a9d`, 2 of 3, at the same address on the three.

**The owner's decision (5 Nov 2026, for Elysium):** a chain without Safe 1.5.0 gets a new Safe 1.3.0 L2 with the
same owners and threshold, instead of waiting for the same address.
- **Why not the same address.** Safe 1.4.1 and 1.5.0 reach a chain only through the Safe Singleton Factory. The Safe
  team deploys it on request, once the chain is on chainlist.org, and aims at two weeks.
- **Why 1.3.0.** Its canonical contracts go through the Arachnid proxy, which needs no one's key. Elysium's testnet
  has them all (singleton, proxy factory, fallback handler).
- **What does not change.** The 13 V2 addresses stay the same, because CREATE3 takes only the deployer and the salts.
  Deploying and starting need no Safe transaction: the registry's constructor sets governance, the guardian, the
  operator, the publisher and the router.

`scripts/v2/governance-safe.mjs` plans that Safe and checks it.
- **Read-only.** It signs nothing and sends nothing.
- **The RPC URL stays private.** It comes from an environment variable or an owner-only file, as for
  [qualify-chain.mjs](QUALIFY_CHAIN.md).
- **Not a release input** ([FREEZE.md](FREEZE.md)).

## The address

The proxy factory creates the Safe with CREATE2 over its owners, its threshold and its fallback handler. None of these
depend on the chain.
- **With the production owners, threshold 2 and salt nonce 0**, the Safe is
  `0xC43944Bd6e7f0c79909878Ab1C04241ad210ecC3` on every chain that has Safe 1.3.0's canonical contracts.
- **A chain with only the `eip155` set** gives another address. The plan names the set it used.
- **Anyone may create it, but only with those owners.** An address someone else took first is the same Safe, and
  `plan` checks it and reports it as existing.

## Day 1

1. **Confirm that the production Safe still has the owners its preflight recorded.** Check it on Robinhood, through
   the node:
   ```sh
   node scripts/v2/governance-safe.mjs check --chain-id 4663 --address 0x2b1d4098ec880058886b95a0e75069a7099c5a9d \
     --owners-from docs/deployments/v2-robinhood-4663-2026-10-04/preflight.json --rpc-env ROBINHOOD_RPC_URL
   ```
2. **Plan on the new chain**, writing outside the checkout:
   ```sh
   node scripts/v2/governance-safe.mjs plan --chain-id <id> \
     --owners-from docs/deployments/v2-robinhood-4663-2026-10-04/preflight.json \
     --rpc-env ELYSIUM_RPC_URL --out ~/elysium-day1/governance-safe-plan.json
   ```
   - It refuses a chain without a complete Safe 1.3.0. The qualification's bootstrap then says how to deploy one.
   - It requires the node's simulation to create the Safe at the predicted address.
   - It sizes the gas with 25% headroom. On Nitro the estimate includes the L1 component.
3. **Review** the address, the owners, the threshold and the transaction: `to` is the proxy factory and the value is 0.
4. **Send `transaction` from any funded account**, the deployer's wallet for instance. Creating the Safe needs no
   owner's signature.
5. **Check it at the receipt's block.** Wallet RPCs lag, so pin the block:
   ```sh
   node scripts/v2/governance-safe.mjs check --chain-id <id> --address <safe> \
     --owners-from docs/deployments/v2-robinhood-4663-2026-10-04/preflight.json --block <receipt block> --rpc-env ELYSIUM_RPC_URL
   ```
   This is the governance check `prepare` runs, plus exactly these owners and threshold.
6. **Put the address in that chain's roles file** as `governance`, with the other roles unchanged. Then prepare as in
   [DEPLOYMENT.md](DEPLOYMENT.md).

## Later: the same address

The Safe Singleton Factory may reach the chain later, and the owner may want `0x2b1d…5a9d` there too.
- **Recreating it replays its creation**, with the owners and threshold of that moment. Compare them with the
  production Safe's first.
- **Two transactions move governance.** First `registry.transferGovernance(new)` from the 1.3.0 Safe, then
  `acceptGovernance()` from the new one. Every V2 contract reads governance from the registry, and the ops monitor
  reports both events (`CRITICAL_EVENTS`).

## Tests

`governance-safe.test.mjs` runs on a plain Anvil that holds Safe 1.3.0's real runtimes. The fixture,
`deploy-fixtures/safe-1.3.0-runtime.json`, was read on Elysium's testnet at block 24,111,632 and checked against
safe-deployments' code hashes. It is LGPL-3.0 (`Safe.LICENSE`). The tests cover:
- **The address.** The one the plan predicts is the one the factory creates, and `deploy.mjs`'s check accepts that
  Safe.
- **Use.** Two owners execute a transaction through it.
- **Fallback.** The `eip155` set serves when the canonical one is absent.
- **Refusals:**
  - an incomplete Safe 1.3.0;
  - another chain;
  - bad owners;
  - a node that simulates another address;
  - a Safe at the address whose owners changed it since, and other code there.
- **Reads only**, within a call budget.

Every guard is pinned: each of 31 mutants, a guard switched off or a rule changed, fails the suite.

**Rehearsal (5 Nov 2026).** Planned on Elysium's testnet at block 24,115,591 with the production owners, then
created on an Anvil fork of that block.
- It used 305,520 gas of the plan's 390,903.
- `deploy.mjs`'s `inspectGovernance` accepted it with the same two warnings as production: the deployer and the
  guardian are owners.
