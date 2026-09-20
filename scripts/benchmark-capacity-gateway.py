#!/usr/bin/env python3
"""Isolated ASGI gateway fixture + real production loopback reader.

Run on the VM, with its reader backend path and Python dependencies. Does not
listen on any port, modify production authentication, or use a production JWT.
RS256 signatures are genuinely verified against an ephemeral fixture key.
1,000 synthetic private test clients retain the normal per-IP budgets. Measures
gateway Python gates/validation/threads and real HTTP/DB reader work, excluding
Cloudflare, Access service, public network and Uvicorn gateway overhead.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import importlib.util
import ipaddress
import json
from pathlib import Path
import sys
import time


def limit_reason(rows, considered, dropped, percentile, *, finished=False):
    """Apply the same stop rules at dispatch and after the last request drains."""
    checked = rows if finished else rows[-32:]
    if any(row['outcome'] != 'ok' for row in checked):
        return 'request_failed'
    good = [row['ms'] for row in rows[-100:] if row['outcome'] == 'ok']
    if len(good) >= 30 and percentile(good, .95) > 100:
        return 'recent_success_p95_above_100ms'
    if considered >= 50 and dropped / considered > .05:
        return 'generator_drop_ratio_above_5pct'
    if finished and not rows:
        return 'no_completed_requests'
    return None


async def measure(args):
    sys.path.insert(0, args.backend)
    import httpx
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa
    from bridge_identity import AccessVerifier
    from read_gateway import Gateway, create_gateway
    from public_data_contract import validate_request_response
    spec=importlib.util.spec_from_file_location('capacity', Path(__file__).with_name('benchmark-capacity.py'))
    capacity=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capacity)
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    jwk={**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key())), 'kid':'capacity-fixture','use':'sig','alg':'RS256'}
    issuer='https://capacity-fixture.cloudflareaccess.com'
    verifier=AccessVerifier(issuer,'a'*64,'capacity-fixture.access',loader=lambda:{'keys':[jwk]})
    now=int(time.time())
    assertion=jwt.encode({'iss':issuer,'aud':['a'*64],'iat':now-1,'exp':now+3600,'common_name':'capacity-fixture.access','sub':'','type':'app'}, private,algorithm='RS256',headers={'kid':'capacity-fixture'})
    gateway=Gateway(verifier=verifier,enabled_v3=True,enabled_v3_reads=('overview','search','history'))
    app=create_gateway(gateway)
    # Verify auth failures against this isolated fixture before measuring load.
    result={'startedAt':datetime.now(timezone.utc).isoformat(),'scope':__doc__, 'backendPath':args.backend,
            'productionConfigurationChanged':False,'syntheticClients':1000,'workerThreads':2,'storedGateCapacity':4,'stages':[]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,client=('127.0.0.1',40000)),base_url='http://127.0.0.1:18878') as client:
        bad=await client.post('/internal/read/v3/overview',json={'poolIds':capacity.POOLS},headers={'Cf-Access-Jwt-Assertion':'invalid','X-Domino-Client-Id':'198.18.0.1'})
        result['invalidAssertionStatus']=bad.status_code
        if bad.status_code not in (401,403):
            raise RuntimeError('fixture authentication preflight failed')
        sequence=0
        for rate in args.rates:
            rows=[]; pending=set(); stopped=False; dropped=0; peak=0; stop_reason=None
            start=time.monotonic();cpu_start=time.process_time()
            async def request(index):
                mode=index%10
                if mode<8: route,body='overview',{'poolIds':capacity.POOLS}
                elif mode==8: route,body='search',{'query':'CRUMBS'}
                else: route,body='history',{'poolId':capacity.POOLS[0],'currency':capacity.WETH,'windowSeconds':86400,'resolutionSeconds':3600}
                began=time.monotonic();status=None;size=0
                try:
                    response=await client.post('/internal/read/v3/'+route,json=body,headers={'Cf-Access-Jwt-Assertion':assertion,'X-Domino-Client-Id':str(ipaddress.IPv4Address(int(ipaddress.IPv4Address('198.18.0.1'))+index%1000))})
                    status=response.status_code;size=len(response.content)
                    outcome='ok' if status==200 else 'http_'+str(status)
                    if status==200:validate_request_response(route,body,response.json())
                except Exception as exc:outcome='exception_'+type(exc).__name__
                rows.append({'outcome':outcome,'status':status,'bytes':size,'ms':round((time.monotonic()-began)*1000,3),'route':route})
            count=int(rate*args.seconds)
            index=0
            while index<count:
                target=start+index/rate
                await asyncio.sleep(max(0,target-time.monotonic()))
                late=int(max(0,time.monotonic()-target)*rate)
                if late:
                    skipped=min(late,count-index);dropped+=skipped;index+=skipped;continue
                stop_reason=limit_reason(rows,index,dropped,capacity.percentile)
                if stop_reason:stopped=True;break
                pending={t for t in pending if not t.done()}
                if len(pending)>=8:dropped+=1
                else:
                    pending.add(asyncio.create_task(request(sequence)));peak=max(peak,len(pending))
                sequence+=1;index+=1
                if index>=50 and dropped/index>.05:
                    stop_reason='generator_drop_ratio_above_5pct';stopped=True;break
            if pending:await asyncio.gather(*pending)
            # The last responses and a skipped tail have no next dispatch at
            # which to check limits. They must not turn an overloaded stage
            # into permission to increase the next rate.
            stop_reason=stop_reason or limit_reason(rows,index,dropped,capacity.percentile,finished=True)
            stopped=bool(stop_reason)
            if not stopped:await asyncio.sleep(max(0,start+args.seconds-time.monotonic()))
            elapsed=time.monotonic()-start
            stage=capacity.describe(rows)
            stage.update(offeredHttpPerSecond=rate,elapsedSeconds=round(elapsed,3),plannedSeconds=args.seconds,
                         dropped=dropped,maxInflight=peak,successHttpPerSecond=round(stage['successes']/elapsed,3),
                         generatorAndGatewayCpuSeconds=round(time.process_time()-cpu_start,3),
                         plannedRequests=count,consideredSlots=index,startedRequests=len(rows),
                         sentHttpPerSecond=round(len(rows)/elapsed,3),
                         completedPlannedWindow=index>=count and elapsed>=args.seconds-.05,
                         stopReason=stop_reason,stoppedEarly=stopped,
                         byRoute={route:capacity.describe([r for r in rows if r['route']==route])
                                  for route in ('overview','search','history')})
            result['stages'].append(stage)
            args.output.write_text(json.dumps(result,indent=2)+'\n')
            print(json.dumps(stage),flush=True)
            if stage['stoppedEarly']:break
            await asyncio.sleep(args.cooldown)
    result['finishedAt']=datetime.now(timezone.utc).isoformat()
    args.output.write_text(json.dumps(result,indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend',required=True)
    parser.add_argument('--rates',type=lambda v:[float(x) for x in v.split(',')],default=[5,10,20,30,45,65,90,135,200])
    parser.add_argument('--seconds',type=int,default=60)
    parser.add_argument('--cooldown',type=int,default=15)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not 10<=args.seconds<=120 or not 0<=args.cooldown<=30 or not 1<=len(args.rates)<=10 or any(not 0<r<=250 or int(r*args.seconds)<1 for r in args.rates):parser.error('bounded parameters required')
    asyncio.run(asyncio.wait_for(measure(args),timeout=1800))
