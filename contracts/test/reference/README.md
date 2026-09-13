# Official v4 external-unlock fixture

`OfficialV4Compound.t.sol` deploys the actual upstream `PoolManager` and
`PositionManager` implementations locally, then creates a hookless, fixed-fee
pool and an owner-held NFT. It gives the controller individual NFT approval and
a PositionManager subscription. Actual swaps in both directions accrue the fees;
no synthetic fee storage or `donate` operation supplies the collection.

The test-only controller proves this sequence for ERC20/ERC20 and native/ERC20:

1. The controller calls `PoolManager.unlock` and receives its callback.
2. The controller calls `PositionManager.modifyLiquiditiesWithoutUnlock` with
   `DECREASE_LIQUIDITY` of zero and `TAKE_PAIR` to the controller. Root liquidity
   stays unchanged, both PositionManager deltas return to zero, and delivered
   currencies equal the positive subscriber fee amounts.
3. A second `modifyLiquiditiesWithoutUnlock` call adds explicit liquidity with
   input maxima bounded by the newly collected fees. The callback confirms that
   exact increase and zero additional accrual.
4. The controller reads the PositionManager's negative currency deltas through
   `TransientStateLibrary`/`exttload`, synchronizes each currency and settles
   those debts with `settleFor(PositionManager)`. ERC20 settlement transfers the
   exact amount to core after `sync`; native settlement supplies the exact value
   after resetting the synced currency.
5. All PositionManager/controller deltas and core's nonzero-delta count are zero.
   Core relocks. The NFT holder, individual approval, subscription and owner
   wallet balances remain unchanged. Unconsumed fees remain with the controller.

The two PositionManager calls have independent transient lock scopes. The
subscriber's deliberate nested PositionManager call fails inside either scope.
The fixture also proves that a missing outer core unlock fails, omitted
settlement rolls the entire action back, and insufficient collected fees cannot
consume the owner's retained setup principal. A valid retry follows each failed
compound without duplicate collection or liquidity.

The controller contains test funding, callback probes and deliberate failure
entry points. It is **not a Domino executor**, charge policy, economic admission
gate or release-ready implementation. Permit2, descriptor and wrapped-native
constructor addresses are inert synthetic addresses: this demonstrated path
does not use Permit2, token allowances, NFT metadata, wrapping or wallet pulls.
The exact-transfer ERC20s are synthetic and do not qualify any real token.

## Pins, licenses and reproduction

`official-v4/provenance.json` records repository revisions and SHA-256 hashes of
every vendored file. Sources are byte-for-byte copies, limited to the transitive
imports of PoolManager, PositionManager, StateView and the transient-state reader.
StateView is retained for the ensuing vault integration fixture. Original SPDX
headers, source attribution and complete root license texts are preserved; core's
MIT and BUSL license texts live in its upstream `licenses/` directory.

| Repository | Revision |
| --- | --- |
| Uniswap/v4-periphery | `dce236d4e2057422d0791d9a973a58765eb46f65` |
| Uniswap/v4-core | `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` |
| Uniswap/permit2 | `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219` |
| transmissions11/solmate | `4b47a19038b798b4a33d9749d25e570443520647` |
| OpenZeppelin/openzeppelin-contracts | `dbb6104ce834628e473d2173bbc9d47f81a9eec3` |

The periphery pin follows the existing E2 source review; its Git submodules pin
core/Permit2, and core's submodules pin Solmate/OpenZeppelin. This periphery
revision differs from the deployment-tooling source revision recorded in
`reports/DEPOSIT_DEPLOYMENT_REVIEW.md`. The fixture does not claim to reproduce
Robinhood's deployed runtime or production optimizer settings. It uses the
repository's pinned solc 0.8.26, via-IR, Cancun and optimizer settings. It makes no
RPC calls, reads no runtime configuration and needs no wallet or credentials.

From the repository root:

```sh
npm ci
python3 contracts/test/reference/verify_official_reference.py
npm run test:contracts -- --match-contract OfficialV4CompoundTest
```

`contracts/foundry.toml` adds only local reference import remappings. No compiler,
optimizer, filesystem, FFI or bytecode-limit setting is relaxed.

Validation on 12 September 2026: all five fixture cases passed; the complete
`npm run test:contracts` command passed 134 Solidity tests, 14 launcher/size
checks and the existing production bytecode gates. The reference checker passed
all 98 source/license files, and a separate comparison against the pinned
upstream worktrees confirmed byte-for-byte equality. Repository hygiene passed
1,200 tracked/staged files. Two upstream MIT copyright lines retain their
original trailing space so license files remain byte-for-byte intact; authored
files pass the whitespace check. Backend PostgreSQL tests were not run for this
isolated fixture; combined E4 validation remains the integrating task's work.

Protocol fee realization is not itself proof of trading income: the upstream
subscriber interface warns that donations can inflate fee growth. This fixture
uses real swaps, but future managed-performance attribution must independently
exclude pool donations and preserve opening-fee origins. Service-fee collection,
replay protection, policy checks and production vault callbacks require the E4
implementation's own combined tests.
