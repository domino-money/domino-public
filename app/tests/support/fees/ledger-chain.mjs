/**
 * A position's own events, as Robinhood Chain logs them, for the fees ledger's tests (2026-10-02, RPC-SPEC §11.4,
 * functions/_lib/feesLedger.ts): its mint, and each settlement as the contracts leave it.
 *
 *   mint        PositionManager Transfer(0x0 → owner, id) and the PoolManager's ModifyLiquidity(+L) in one transaction
 *   compound    an automatic compound (DominoExecutionEngineV4 _collect then _fund, GENERAL): the engine's FeesRealized
 *               (the fees), a ModifyLiquidity of 0 (the collect) and one of +L (the re-add), the engine's BudgetApplied per
 *               currency (the service fee), the vault's ExecutionCompleted, and the vault's payments to the PoolManager
 *   net         an automatic compound in one increase that settles the fees itself (NET): FeesRealized and a ModifyLiquidity
 *               of +L, BudgetApplied, ExecutionCompleted
 *   domino      Domino-compound's move to a next position: FeesRealized, a ModifyLiquidity of 0 (the collect) and the vault's
 *               ExecutionCompleted of a MINT whose destination is `step.destination`, the fees leaving with it
 *   collect     the owner's collect: a ModifyLiquidity of 0 and the PoolManager's transfers of the fees to the owner
 *   increase    the owner's add: a ModifyLiquidity of +L and the owner's transfers to the PoolManager
 *   decrease    the owner's withdrawal: a ModifyLiquidity of −L and the PoolManager's transfers to the owner
 *   swap        the owner's own swap in the pool's currencies (no ModifyLiquidity): transfers both ways, an unrelated block
 *   other       another position's ModifyLiquidity in the same transaction as the step before it (a collect of two NFTs)
 *
 * positionLogs(spec) gives the logs, the position's liquidity after them and what was settled; logsAnswer(logs) answers
 * an eth_getLogs filter over them, for browserChain's `history` (tests/support/browser-chain.mjs), which answers the
 * position's state, its pool, its vault and the headers. Not a suite of its own.
 */
import { createRequire } from 'node:module';
import { encodeAbiParameters, keccak256, numberToHex, pad, toBytes } from 'viem';

const require = createRequire(import.meta.url);
const owned = require('../../../.test-build/app/functions/_lib/owned.js');
const fees = require('../../../.test-build/app/functions/_lib/fees.js');
const ledger = require('../../../.test-build/app/functions/_lib/feesLedger.js');
const record = require('../../../.test-build/app/functions/_lib/vaultRecord.js');

export const PM = owned.POSITION_MANAGER;
export const POOL_MANAGER = fees.POOL_MANAGER;
export const ENGINE = ledger.ENGINE;
const ZERO = '0x0000000000000000000000000000000000000000';
export const word = (value) => pad(numberToHex(BigInt.asUintN(256, BigInt(value))), { size: 32 });
const topicOf = (address) => pad(address.toLowerCase());
const data = (...words) => `0x${words.map((one) => one.slice(2)).join('')}`;
/** A transaction hash of its own for each (block, n). */
export const txOf = (block, n = 0) => keccak256(toBytes(`tx:${block}:${n}`));

/**
 * The logs of one position. `spec`: { tokenId, owner, key, poolId, tickLower, tickUpper, vault?, mint: { block, liquidity },
 * steps: [{ block, kind, delta?, fees?: [a, b], service?: [a, b], to? }], setup?, mintTo?, transfers? }, steps in block order,
 * one per block (a `swap` or an `other` may share a block); `setup: false` leaves out DominoSetupV1's SetupMinted for the
 * owner, `mintTo` mints to another address, `transfers` ([{ block, to }]) sends the NFT on. Returns { logs, liquidity,
 * collected, txs }.
 */
export function positionLogs(spec) {
  const id = BigInt(spec.tokenId);
  const owner = spec.owner.toLowerCase();
  const vault = spec.vault?.toLowerCase() ?? null;
  const [c0, c1] = [spec.key.currency0.toLowerCase(), spec.key.currency1.toLowerCase()];
  const logs = [];
  const indexIn = new Map();
  const at = (block) => {
    const n = indexIn.get(block) ?? 0;
    indexIn.set(block, n + 1);
    return n;
  };
  const log = (address, topics, body, block, tx) => logs.push({ address, topics, data: body, blockNumber: numberToHex(block), logIndex: numberToHex(at(block)), transactionHash: tx, blockHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', removed: false });
  const modify = (block, tx, delta, salt = id, poolId = spec.poolId) =>
    log(POOL_MANAGER, [fees.TOPIC.ModifyLiquidity, poolId, topicOf(PM)], data(word(spec.tickLower), word(spec.tickUpper), word(delta), word(salt)), block, tx);
  const transfer = (token, from, to, amount, block, tx) => {
    if (token === ZERO || BigInt(amount) === 0n) return;
    log(token, [owned.TRANSFER_TOPIC, topicOf(from), topicOf(to)], word(amount), block, tx);
  };
  const realized = (block, tx, amounts) => log(ENGINE, [ledger.FEES_REALIZED, topicOf(vault), word(0xa11ce), word(id)], data(word(1), word(2), word(amounts[0]), word(amounts[1])), block, tx);
  const budget = (block, tx, currency, service, added) =>
    log(ENGINE, [ledger.BUDGET_APPLIED, topicOf(vault), word(0xa11ce), word(0x50c)], encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, ...Array(9).fill({ type: 'uint128' })], [currency, id, 0n, 0n, 0n, 0n, 0n, BigInt(service), BigInt(added), 0n, 0n]), block, tx);
  const execution = (block, tx, action, destination = id) => log(vault, [record.EXECUTION_COMPLETED, word(0xa11ce), word(0xb0b)], encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }], [action, id, BigInt(destination), 3n]), block, tx);

  let liquidity = BigInt(spec.mint.liquidity);
  const mintTx = spec.mint.tx ?? txOf(spec.mint.block);
  log(PM, [owned.TRANSFER_TOPIC, topicOf(ZERO), topicOf(spec.mintTo ?? owner), word(id)], '0x', spec.mint.block, mintTx);
  modify(spec.mint.block, mintTx, liquidity);
  // DominoSetupV1's own record of the mint, for the owner it minted for (2026-10-02, review of the rules, finding 1: the
  // ledger follows only addresses that are Domino's). `setup: false`: an NFT minted elsewhere (or by a vault).
  if (spec.setup !== false) log(owned.SETUP_CONTRACT, [owned.SETUP_MINTED_TOPIC, word(id * 7n + 1n), topicOf(owner), word(id)], data(word(liquidity), word(1n), word(2n)), spec.mint.block, mintTx);
  // Each later holder (`transfers`: [{ block, to }]): the NFT sent on.
  let holder = spec.mintTo ?? owner;
  for (const move of spec.transfers ?? []) {
    log(PM, [owned.TRANSFER_TOPIC, topicOf(holder), topicOf(move.to), word(id)], '0x', move.block, txOf(move.block, 7));
    holder = move.to.toLowerCase();
  }
  const collected = [0n, 0n];
  const txs = [];
  let last = null;
  for (const step of spec.steps ?? []) {
    const tx = step.tx ?? (step.kind === 'other' && last ? last : txOf(step.block, step.kind === 'swap' ? 1 : 0));
    const amounts = (step.fees ?? [0n, 0n]).map(BigInt);
    const delta = BigInt(step.delta ?? 0n);
    switch (step.kind) {
      case 'compound':
      case 'net': {
        realized(step.block, tx, amounts);
        if (step.kind === 'compound') modify(step.block, tx, 0n);
        modify(step.block, tx, delta);
        const service = (step.service ?? [0n, 0n]).map(BigInt);
        budget(step.block, tx, c0, service[0], delta);
        budget(step.block, tx, c1, service[1], delta);
        transfer(c0, vault, POOL_MANAGER, amounts[0] - service[0], step.block, tx);
        transfer(c1, vault, POOL_MANAGER, amounts[1] - service[1], step.block, tx);
        execution(step.block, tx, step.kind === 'net' ? 1 : 0);
        liquidity += delta;
        collected[0] += amounts[0];
        collected[1] += amounts[1];
        break;
      }
      case 'domino':
        realized(step.block, tx, amounts);
        modify(step.block, tx, 0n);
        execution(step.block, tx, 3, step.destination);
        collected[0] += amounts[0];
        collected[1] += amounts[1];
        break;
      case 'collect':
        modify(step.block, tx, 0n);
        transfer(c0, POOL_MANAGER, step.to ?? owner, amounts[0], step.block, tx);
        transfer(c1, POOL_MANAGER, step.to ?? owner, amounts[1], step.block, tx);
        collected[0] += amounts[0];
        collected[1] += amounts[1];
        break;
      case 'increase':
        modify(step.block, tx, delta);
        transfer(c0, owner, POOL_MANAGER, 1_000_000n, step.block, tx);
        transfer(c1, owner, POOL_MANAGER, 1_000_000n, step.block, tx);
        liquidity += delta;
        break;
      case 'decrease':
        modify(step.block, tx, -delta);
        transfer(c0, POOL_MANAGER, owner, 1_000_000n, step.block, tx);
        transfer(c1, POOL_MANAGER, owner, 1_000_000n, step.block, tx);
        liquidity -= delta;
        break;
      case 'swap':
        transfer(c0, owner, POOL_MANAGER, 5_000_000n, step.block, tx);
        transfer(c1, POOL_MANAGER, owner, 5_000_000n, step.block, tx);
        break;
      case 'other':
        modify(step.block, tx, 0n, id + 1n);
        break;
      default:
        throw new Error(`unknown step ${step.kind}`);
    }
    if (step.kind !== 'swap' && step.kind !== 'other') txs.push(tx);
    last = tx;
  }
  logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  return { logs, liquidity, collected, txs };
}

/**
 * An eth_getLogs filter's answer over `logs` (its address or addresses, its topics, null or a list in a place, its blocks);
 * null for the wallet's SetupMinted read, which browserChain answers itself. `asked`, when given, lists each filter.
 */
export function logsAnswer(logs, asked = null) {
  return (filter, from, to) => {
    const topics = filter.topics ?? [];
    if (topics[0] === owned.SETUP_MINTED_TOPIC) return null;
    asked?.push({ address: filter.address, topics, from, to });
    const addresses = [filter.address].flat().map((one) => String(one).toLowerCase());
    const match = (want, got) => want == null || (Array.isArray(want) ? want.includes(got) : want === got);
    return logs.filter((one) => {
      const block = Number(one.blockNumber);
      return addresses.includes(one.address) && block >= from && block <= to && topics.every((want, i) => match(want, one.topics[i]));
    });
  };
}

/** Header times on a steady chain: `t0` at block `b0`, ten blocks a second. */
export const steadyTimes = (b0, t0) => (block) => t0 + Math.floor((block - b0) / 10);
