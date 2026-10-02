export const CONTRACT_VERSION = '1.0.0-rc.1';
export const ERROR_STATUS_BY_CODE = Object.freeze({route_not_available:404,origin_not_allowed:403,setup_configuration_unavailable:503});

// Public deployment identities only. The wallet verifies runtime hashes and
// every immutable address before preparing an owner-funded transaction.
export function setupRelease(request, env) {
  if (new URL(request.url).pathname === '/api/setup/v1/sequence-release') return sequenceRelease(request, env);
  const headers = { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store, no-transform', 'X-Domino-Setup-Contract':'1.0.0-rc.1' };
  const reply = (value,status=200) => new Response(JSON.stringify(value),{status,headers});
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  // Fetch Metadata only where the browser sends it (sequence-release.mjs fetchedByPage, 2026-10-01).
  if ((origin !== null && origin !== 'https://domino.money') || !fetchedByPage(request)) return reply({error:'origin_not_allowed'},403);
  if (url.origin !== 'https://domino.money' || url.pathname !== '/api/setup/v1/release' || url.search || request.method !== 'GET') return reply({error:'route_not_available'},404);
  if (env.SETUP_WALLET_ENABLED !== 'true') return reply({contractVersion:'1.0.0-rc.1',chainId:4663,available:false,deployment:null});
  try {
    if (typeof env.SETUP_DEPLOYMENT_JSON !== 'string' || env.SETUP_DEPLOYMENT_JSON.length>8192) throw new Error();
    const d=JSON.parse(env.SETUP_DEPLOYMENT_JSON);
    if (!d || Object.keys(d).sort().join(',') !== ['setup','setupCodeHash','poolManager','positionManager','stateView','poolManagerCodeHash','positionManagerCodeHash','stateViewCodeHash','feeRecipient','feeBps','tariffVersion','expiresAt'].sort().join(',')) throw new Error();
    for (const name of ['setup','poolManager','positionManager','stateView','feeRecipient']) if (!/^0x[0-9a-f]{40}$/.test(d[name]) || /^0x0+$/.test(d[name])) throw new Error();
    for (const name of ['setupCodeHash','poolManagerCodeHash','positionManagerCodeHash','stateViewCodeHash']) if (!/^0x[0-9a-f]{64}$/.test(d[name]) || /^0x0+$/.test(d[name])) throw new Error();
    if (!Number.isSafeInteger(d.feeBps) || d.feeBps<0 || d.feeBps>65
      || !/^[1-9][0-9]{0,19}$/.test(d.tariffVersion) || BigInt(d.tariffVersion)>=2n**64n || !Number.isSafeInteger(d.expiresAt) || d.expiresAt <= Date.now()/1000) throw new Error();
    return reply({contractVersion:'1.0.0-rc.1',chainId:4663,available:true,deployment:d});
  } catch { return reply({error:'setup_configuration_unavailable'},503); }
}

export default { fetch: setupRelease };
import { fetchedByPage, sequenceRelease } from './sequence-release.mjs';
