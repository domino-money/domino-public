// Public, fixed deployment identities for owner-created V4 sequences. This
// document does not admit an owner to a signer or grant operator permission.
export function sequenceRelease(request, env) {
  const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, no-transform','X-Domino-Setup-Contract':'1.0.0-rc.1','X-Content-Type-Options':'nosniff'};
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  const url=new URL(request.url),origin=request.headers.get('Origin');
  if ((origin!==null && origin!=='https://domino.money') || request.headers.get('Sec-Fetch-Site')!=='same-origin' || !['cors','same-origin'].includes(request.headers.get('Sec-Fetch-Mode')) || request.headers.get('Sec-Fetch-Dest')!=='empty' || request.headers.has('Sec-Fetch-User')) return reply({error:'origin_not_allowed'},403);
  if(url.origin!=='https://domino.money' || url.pathname!=='/api/setup/v1/sequence-release' || url.search || request.method!=='GET')return reply({error:'route_not_available'},404);
  if(env.SEQUENCE_WALLET_ENABLED!=='true')return reply({contractVersion:'1.0.0-rc.1',chainId:4663,available:false,deployment:null});
  try {
    if(typeof env.SEQUENCE_DEPLOYMENT_JSON!=='string' || env.SEQUENCE_DEPLOYMENT_JSON.length>8192)throw new Error();
    const d=JSON.parse(env.SEQUENCE_DEPLOYMENT_JSON);
    const contracts=['factory','implementation','poolManager','positionManager','stateView','readHelper','engine','routing','priceGuard'];
    const addresses=[...contracts,'serviceFeeRecipient','operator','pricePublisher'];
    if(!d || Object.keys(d).sort().join()!==[...addresses,'serviceFeeBps','expiresAt','codeHashes'].sort().join())throw new Error();
    if(!addresses.every(k=>typeof d[k]==='string' && /^0x[0-9a-f]{40}$/.test(d[k]) && !/^0x0+$/.test(d[k])))throw new Error();
    if(new Set(contracts.map(k=>d[k])).size!==contracts.length || d.operator===d.pricePublisher || [...contracts,'serviceFeeRecipient'].some(k=>d[k]===d.operator || d[k]===d.pricePublisher))throw new Error();
    if(!d.codeHashes || Object.keys(d.codeHashes).sort().join()!==['vault',...contracts].sort().join() || !Object.values(d.codeHashes).every(v=>typeof v==='string' && /^0x[0-9a-f]{64}$/.test(v) && !/^0x0+$/.test(v)))throw new Error();
    if(d.serviceFeeBps!==200 || !Number.isSafeInteger(d.expiresAt) || d.expiresAt<=Date.now()/1000)throw new Error();
    return reply({contractVersion:'1.0.0-rc.1',chainId:4663,available:true,deployment:d});
  } catch{return reply({error:'setup_configuration_unavailable'},503);}
}
