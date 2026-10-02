/**
 * DominoVaultFactoryV1.isVault on a test's fake node (2026-10-02, review of rugged97's rules, finding 16): the record route
 * (functions/_lib/vaultRecord.ts) reads a vault's logs only once the factory says it made it, in one Multicall3 aggregate3
 * at the head. `factoryCall(call, made)` answers such an eth_call: each isVault sub-call by `made(address)`, any other
 * sub-call as failed. Not a suite of its own.
 */
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';

const require = createRequire(import.meta.url);
const automation = require('../../.test-build/app/functions/_lib/automation.js');

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);
const IS_VAULT = `0x${automation.AUTOMATION_SELECTOR.isVault}`;

/** Whether a JSON-RPC call is the factory's isVault asked through Multicall3 (eth_call). */
export const isFactoryCall = (call) => call.method === 'eth_call';

/** The JSON-RPC answer ({ result }) to an eth_call of aggregate3 over the factory's isVault: `made(address)` for each. */
export function factoryCall(call, made = () => true) {
  const { args } = decodeFunctionData({ abi: multicallAbi, data: call.params[0].data });
  const results = args[0].map((sub) => {
    if (sub.target.toLowerCase() !== automation.SEQUENCE_FACTORY || !sub.callData.startsWith(IS_VAULT)) return { success: false, returnData: '0x' };
    const address = `0x${sub.callData.slice(-40)}`.toLowerCase();
    return { success: true, returnData: `0x${(made(address) ? 1n : 0n).toString(16).padStart(64, '0')}` };
  });
  return { result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results }) };
}
