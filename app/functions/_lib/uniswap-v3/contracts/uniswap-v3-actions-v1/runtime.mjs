import { createContractValidators } from '../shared/closed-schema.mjs';
import { SCHEMAS, ERRORS } from './schema-data.mjs';
export const CONTRACT_VERSION = '1.0.0-rc.2';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze(ERRORS);
const maximum128 = 1n << 128n;
const sameIdentity = (a,b) => ['chainId','protocol','deploymentId','positionManager'].every(key=>a[key]===b[key]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
function semantic(name,value) {
  if (name==='OpenAction') return value.tickLower<value.tickUpper && (BigInt(value.amount0Raw)>0n || BigInt(value.amount1Raw)>0n)
    && BigInt(value.amount0Raw)<maximum128 && BigInt(value.amount1Raw)<maximum128;
  if (name==='Policy') return !(value.serviceFeeBps===200 && (value.maxPositions!==1 || value.allowSuccessor))
    && (!value.allowSuccessor || value.successorTickLower<value.successorTickUpper);
  if (name==='ReduceAction') return BigInt(value.liquidityRaw)>0n && BigInt(value.liquidityRaw)<maximum128;
  if (name==='WithdrawFeesAction') return (BigInt(value.originalRaw)>0n || BigInt(value.chargedRaw)>0n)
    && BigInt(value.originalRaw)<maximum128 && BigInt(value.chargedRaw)<maximum128;
  if (name==='PoolData') return value.token0.address<value.token1.address && BigInt(value.liquidityRaw)<maximum128
    && BigInt(value.sqrtPriceX96Raw)>=4295128739n && BigInt(value.sqrtPriceX96Raw)<1461446703485210103287273052203988822378723970342n;
  if (name==='OwnerTransaction') return BigInt(value.gasLimitRaw)>0n && BigInt(value.gasLimitRaw)<=30000000n
    && BigInt(value.maxPriorityFeePerGasWeiRaw)>0n && BigInt(value.maxPriorityFeePerGasWeiRaw)<=BigInt(value.maxFeePerGasWeiRaw) && value.data.length>=10;
  if (name==='Draft') return value.transaction.from===value.owner && value.readyForAction===(value.step===value.action.kind)
    && value.contractPins.some(pin=>pin.address===value.vault) && new Set(value.contractPins.map(pin=>pin.address)).size===value.contractPins.length;
  if (name==='PrepareResponse') return value.owner===value.draft.owner && value.vault===value.draft.vault && value.draft.expiresAt>value.anchor.timestamp;
  if (name==='ReceiptResponse') return (value.state==='pending' || value.anchor!==null && value.transaction!==null && value.gasUsedRaw!==null)
    && (value.transaction===null || value.transaction.from===value.owner);
  if (name==='CapabilitiesResponse') return (!value.localWalletActionsAvailable || value.deployment!==null && value.qualification==='local-fixture') && (!value.rehearsalWalletActionsAvailable || value.deployment!==null && value.qualification==='testnet-rehearsal' && !value.localWalletActionsAvailable);
  return true;
}
const validators = createContractValidators(SCHEMAS,ERRORS,semantic);
const identityKeys=['chainId','protocol','deploymentId','positionManager'];
const address=/^0x[0-9a-f]{40}$/;
const hash=/^0x[0-9a-f]{64}$/;
const notZero=value=>!/^0x0+$/.test(value);
function expectedIdentity(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === 4 && identityKeys.every(key => Object.hasOwn(value, key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value') && Object.getOwnPropertyDescriptor(value, key).enumerable) &&
    value.chainId === 99801 && value.protocol === 'uniswap-v3' && hash.test(value.deploymentId) &&
    notZero(value.deploymentId) && address.test(value.positionManager) && notZero(value.positionManager);
}
function check(kind, route, value, expected) {
  try {
    if (!validators[kind](route, value)) return false;
    if (route === 'capabilities') return expected === undefined || expectedIdentity(expected) &&
      (kind === 'validateRequest' || value.deployment !== null && sameIdentity(value.deployment, expected));
    // A correctly shaped object from another deployment is still wrong data.
    return expectedIdentity(expected) && sameIdentity(value, expected);
  } catch { return false; }
}
export const validateRequest = (route, value, expected) => check('validateRequest', route, value, expected);
export const validateResponse = (route, value, expected) => check('validateResponse', route, value, expected);
export const validateError = validators.validateError;
export async function verifyDraft(draft) {
  try {
    const {id,...body}=draft;
    const bytes=new TextEncoder().encode(JSON.stringify(canonical(body)));
    const hash=await globalThis.crypto.subtle.digest('SHA-256',bytes);
    return id==='0x'+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
  } catch { return false; }
}
