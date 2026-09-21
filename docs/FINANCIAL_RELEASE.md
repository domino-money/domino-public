# Unsigned Setup and Sequence V4 release

`scripts/prepare-financial-release.mjs` prepares public deployment transactions
and verifies completed deployments. It never reads a key, signs, submits a
transaction, creates a user vault or authorizes an operator. Chain **4663 is
Robinhood Chain mainnet**. Deployment requires the selected deployer's real
native-token funding; this is not a faucet/testnet flow.

## Approved first-release pricing

The owner selected **0.65% (65 bps)** for assisted swaps during funding or
supported manual management: use `setupFeeBps: 65` and `tariffVersion: "1"`
in the first release's public preparation inputs. The basis is consumed selected
gross input, including the fee; direct deposits without a swap have no Setup
percentage charge. This selection is approved for preparation, not evidence of
a deployed contract or active collection. The prepared constructors and verified
Setup profile must record the selected rate and version before publication.

Automation remains **2% simple / 4% Domino**, with internal swaps included in
the mode fee and no additional swap surcharge. The earlier alternate Setup
rates remain historical studies; the existing 65-bps contract ceiling is unchanged.

## Public inputs

Supply a JSON file containing exactly these fields. Addresses use lowercase
hex; integer strings are canonical unsigned decimal strings.

| Field | Meaning |
| --- | --- |
| chainId | `4663` |
| sourceCommit | Full SHA of the checkout whose artifacts were built |
| deployer | Wallet that will sign all eight transactions |
| nonce | First transaction nonce of that wallet, explicitly checked before signing |
| feeRecipient | Explicit service-fee recipient; never inferred from admitted users |
| operator | Intended execution principal for the public Sequence profile |
| pricePublisher | Independent price publisher; must differ from operator |
| priceGuardDeviationBps | Band, in basis points of the square-root price, inside which a published price must sit against the pool's live reading; integer 1–9999 |
| priceGuardGuardian | Cold key that can propose the next price publisher (the proposed key must accept) and revoke an observation; must differ from operator and pricePublisher |
| setupFeeBps | `65` for the approved first release (0.65%); tooling/contract range remains integer 0–65 |
| tariffVersion | `"1"` for the approved first release; nonzero uint64 decimal string |
| expiresAt | Absolute Unix-second expiry for the resulting public profiles |
| gas | Object with decimal limits for factory, readHelper, routing, priceGuard, engine, implementation, setup, finalize |
| maxFeePerGas | Explicit maximum type-2 fee per gas, decimal wei |
| maxPriorityFeePerGas | Priority fee cap, decimal wei |
| maxTotalCostWei | Aggregate gas-cost cap for all eight operations |
| reserveWei | Additional deployer balance reserved outside the gas-cost cap |
| dependencyCodeHashes | Object containing independently qualified runtime keccak256 pins for `poolManager`, `positionManager` and `stateView`; each is a nonzero 32-byte lowercase hex hash |

The three existing wallet admissions do not determine any of these roles.
An operator/price-publisher address identifies a role; generating a project key
does not establish funding, price qualification or user delegation. The command
accepts no key field or arbitrary transaction/data/target field.

PoolManager, PositionManager and StateView addresses are fixed to the reviewed
4663 addresses in `backend/discovery.py`. The runtime hashes of those existing
dependencies must match the explicit `dependencyCodeHashes` inputs at the
verified finalized block; recording whatever code the RPC returns is insufficient.
Their PositionManager/StateView links to PoolManager are also checked. The deployer,
operator, price publisher and guardian must have no runtime code at that block;
the fee recipient may be a contract wallet. The generator requires operator,
publisher and guardian to differ from each other and the fee recipient. Distinct
addresses do not prove independent custody of their keys.

## Build and prepare

Build the pinned Solidity 0.8.26 contracts in the final clean checkout using the
existing offline contract launcher. The generator reads Foundry artifacts;
`--artifacts /absolute/out` optionally selects a separately built output folder.
It checks compiler identity, compilation targets and every referenced source
hash before encoding constructors. Old artifacts fail this check even when
their filenames remain the same. Linked libraries are not accepted.

```sh
node scripts/prepare-financial-release.mjs prepare \
  --repo /absolute/final-checkout \
  --parameters /absolute/operator/public-deployment.json \
  --out /absolute/operator/unsigned-release.json
```

The output is created exclusively, never overwritten. It contains the eight
unsigned type-2 requests, artifact/creation/initcode hashes, predicted CREATE
addresses, clone runtime/hash, size checks, maximum aggregate execution gas
cost and required balance including the explicit reserve. There are no
available deployment profiles in this file: `available:false`,
`deployment:null`.

Order and nonce offsets are fixed:

1. Factory V4 (manager/positions/state/fee recipient).
2. Read helper (positions/state).
3. Routing helper V4.
4. Price guard V4 (independent publisher).
5. Execution engine V4 (factory/read helper/routing/guard).
6. Vault implementation V4 (factory/managers/recipient/read helper/engine).
7. DominoSetup (managers/recipient/Setup tariff/version).
8. `factory.finalizeImplementation(implementation)`, called by that factory's deployer.

Each deployment uses CREATE at its explicit nonce; the finalization is a call.
The existing EIP-1167 clone target is the immutable implementation address.
User vault creation and individual NFT approvals remain separate owner-wallet
actions in the Sequence SDK. This package does not grant a global approval.

The generator enforces the 24,576-byte runtime and 49,152-byte complete-initcode
limits, including constructor arguments. These are the limits specified by
[EIP-170](https://eips.ethereum.org/EIPS/eip-170) and
[EIP-3860](https://eips.ethereum.org/EIPS/eip-3860). Its minimum deployment-gas
check includes intrinsic calldata/initcode and runtime code deposit; constructor
execution still requires additional gas. The supplied limits are caps, not a
claim that an estimate succeeded on mainnet. Extra L2 fee components remain
explicitly unqualified in the manifest.

## Rotating the price publisher after deployment

The price guard's publisher is the one role that can change after the eight
transactions, because every execution depends on its liveness and a key does
not stay clean forever. Rotation is a two-call handshake and needs no
redeployment: the `priceGuardGuardian` calls `proposePublisher(next)` on the
deployed `DominoPriceGuardV4`, and `next` calls `acceptPublisher()`. Until it
accepts, nothing changes; a proposal to a mistyped address hands the role to
nobody. The guardian can also `revoke(id)` any observation without the
publisher key - the emergency brake against a key that is publishing inside
the band but should not be publishing at all. Observations the old key
published stay readable until they expire (at most 255 L2 blocks).

Rotation does not admit the new key anywhere else. The sequence profiles name
`pricePublisher`, and the signer refuses to sign while `publisher()` on the
guard differs from the admitted address (`execution_v4.py`). After the proposed
publisher accepts, use `verify --price-publisher <new-public-address>` to request
explicit re-admission. Keep the original unsigned package and its eight deployment
hashes unchanged. The verifier checks those original transactions and immutable
bindings, then checks that the explicitly named EOA is the current publisher at
the canonical finalized block. It rejects conflicting operator, guardian,
fee-recipient and component addresses. It does not discover or accept an unknown
publisher automatically.

The output profile names the admitted publisher; `publisherAdmission` records
both original and current addresses, guard, guardian, block and unchanged expiry.
This works only within the original profile validity window and does not renew
it. Without this option, verification still requires the original publisher.
No rotation transaction is signed or sent by the tool, and funding/price-source
qualification remains separate. The guardian must differ from the operator and from
the publisher in the initial release inputs. On chain, it can propose itself or
another address it controls and then accept as that address, gaining publisher
powers. The handshake prevents accidental assignment to an unaccepted address;
it does not enforce independent key holders. Keep the guardian outside automated
services. It cannot widen the immutable band or directly control a vault.

Use the current verifier with `--repo` pointing to the original clean deployment
checkout named by the manifest's source commit, and add `--price-publisher` to
the verification command below. Write a new output file; do not edit the original
manifest or replace historical verification evidence.

## Wallet execution and partial recovery

The authorized deployer reviews and signs these requests in order with its
wallet. These are direct creation transactions from that account; Safe or other
contract-wallet wrappers are not interchangeable with this CREATE/nonce package.
Confirm the wallet's chain/account, current nonce, available balance and
gas estimates immediately before each signature. Waiting for a successful
receipt before the next step keeps failures concrete. A failed creation still
consumes its nonce; do not shift later transactions or resend a fresh batch
while presenting the original predicted addresses as valid.

If an intermediate transaction fails, the verification command refuses the
release. Keep successful addresses/receipts and investigate that exact step.
The tool deliberately has no automatic retry, replacement or partial-adoption
path. It never resends a transaction after an ambiguous wallet/RPC result.
Checking the existing hash and deployer nonce is a read-only recovery action.

## Verify before publishing profiles

Save the eight transaction hashes in order as a JSON array. Run verification
against the same pinned source checkout/artifacts and an explicit HTTPS RPC
URL. For the self-hosted Domino RPC, keep the complete authenticated URL in a
private file outside the checkout and use `--rpc-file`; the token never needs
to enter the command line, shell history, output or public release profiles.
The file must belong to the current Unix user, have no group/other permissions
(mode `0600` or `0400`), be a regular file without symlinks or hard links, and
contain one URL, optionally followed by a newline. Do not commit this file.
Credential-bearing query strings, URL user information and redirects are
rejected. Loopback HTTP exists only for local qualification.

```sh
node scripts/prepare-financial-release.mjs verify \
  --repo /absolute/final-checkout \
  --package /absolute/operator/unsigned-release.json \
  --transactions /absolute/operator/deployment-hashes.json \
  --rpc-file /absolute/private/domino-rpc-url \
  --out /absolute/operator/verified-release.json
```

Use exactly one of `--rpc-file` and `--rpc`. The existing public endpoint form,
`--rpc https://rpc.mainnet.chain.robinhood.com`, remains supported for URLs
without secrets. Verification does not silently switch providers: choose an
archive-capable endpoint if the deployment's historical state has been pruned
by the self-hosted node.

Verification reconstructs the package, checks all eight canonical successful
finalized receipts and block membership, and compares the sender, nonce,
chain/type, exact initcode/calldata, targets, values, gas and fees to the unsigned
requests. It matches each new runtime to the compiled artifact outside its
immutable slots, then checks every immutable address/hash/tariff getter and the
one-time factory binding. Constructors are bound by the exact creation
transactions. Existing dependency code hashes must equal the package's explicit
pins under a canonical block-hash reference. A final canonicality/expiry check
precedes output.

Only this successful result includes `setup` and `sequence` profiles with
`available:true`, in the existing application release schemas. It also retains
source/package provenance and receipt/block evidence. Do not publish the
unverified unsigned manifest as application configuration.

`executionAvailable:false`, `operatorFundingQualified:false` and
`priceObservationQualified:false` remain explicit in the verification report.
A deployed factory/Setup contract enables owner configuration; it does not
prove signer funds, a user-created/admitted vault, current route prices or
financial execution eligibility. The public profiles expire at the original
absolute timestamp, without renewal by verification.

The operator pays automated execution gas from its own native ETH balance; the
publisher separately funds observation transactions. Neither the contracts nor
the signer automatically sells user assets or service-fee revenue to refill those
balances. The signer refuses execution when its gas budget and balance do not
qualify. Local fork qualification prefunds test accounts with synthetic ETH;
this is not operator-funding evidence. See [V4 execution](../contracts/V4_EXECUTION.md).

## Local qualification

```sh
node --test scripts/prepare-financial-release-rpc.test.mjs
DOMINO_TEST_EVM=1 node --test scripts/prepare-financial-release.test.mjs
```

The RPC input suite checks exclusive source selection, private file permissions,
ownership and links, bounded input, secret-safe failures and read-only transport.

Five tests cover exact unsigned order/constructors/CREATE addresses, missing or
invalid public inputs, tariff/nonce/gas/size limits, inability of the RPC adapter
to send, package tampering, and an actual eight-transaction Anvil deployment.
The fixture deploys the pinned official v4 dependencies and places their code
at the fixed 4663 addresses only inside its isolated chain. It verifies all
created contracts, rejects reordered receipts and changed runtime code, and
loads the resulting profiles with the actual Setup/Sequence SDK parsers. This
local evidence is not a mainnet deployment or provider qualification.


## Mode fee profile (21 September 2026)

The verified sequence profile publishes both exact rates: `serviceFeeBps: 200`
for simple Auto-compound and `dominoServiceFeeBps: 400` for Domino-compound.
Both fields are required; the previous single-rate profile is refused for new
admission. Deployment/source hashes must come from the mode-aware V4 build, not
from the earlier 200-bps-only freeze. Regenerate and verify every pin; components
whose bytecode is unchanged may retain the same hash.

The wallet's reviewed automation mode sets the corresponding Policy rate. The
existing Policy tuple is unchanged; its exact rate is the canonical mode signal.
Simple mode has one root and no successor authority. A change is an owner-signed
policy update, not a backend tariff override. Setup retains its independent
65-bps maximum. The owner confirmed no additional fee on internal automation
swaps; the earlier 200-bps swap study does not authorize a release tariff.
