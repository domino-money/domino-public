#!/usr/bin/env python3
"""Bounded loopback read API benchmark; run on the Domino VM.

Eighteen read-only API calls, three samples per case, starts >=1.2 seconds
apart. Emits JSONL with public pool metadata and durations, never credentials.
No service/configuration/database mutation; an admitted read may refresh its
normal caches. This measures the reader, excluding browser/Worker/gateway hops.
"""
import json,time,urllib.request,urllib.error,statistics,uuid,sys
POOLS=['0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6','0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7','0x94c62eebf6454231b2fcd0259ede448ae3c6ad8617718cd88dab20b30cfae48a','0xf399bd1544377680d48c62fd85c2105b869e55906c4189cc5ab3b4e83446928c','0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e','0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a']
CASES=[('snapshot','markets-snapshot',{'poolIds':POOLS}),('token','token',{'token':'0x0bd7d308f8e1639fab988df18a8011f41eacad73'}),('market','pool-market',{'poolId':POOLS[0],'includePriceHistory':False}),('chart','pool-market',{'poolId':POOLS[0],'includePriceHistory':True}),('metrics','pool-metrics',{'poolId':POOLS[0]}),('pools','pools',{'token':'0x0bd7d308f8e1639fab988df18a8011f41eacad73','poolIds':[POOLS[0]],'maxPools':1})]
rows=[]
for iteration in range(3):
 for name,route,body in CASES:
  start=time.monotonic();request_id=uuid.uuid4().hex
  req=urllib.request.Request('http://127.0.0.1:8876/v1/read/'+route,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','X-Domino-Request-Id':request_id})
  try:
   try:res=urllib.request.urlopen(req,timeout=22)
   except urllib.error.HTTPError as e:res=e
   with res:
    data=json.loads(res.read(1048577));duration=time.monotonic()-start
    row={'iteration':iteration,'case':name,'route':route,'requestId':request_id,'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'durationMs':round(duration*1000,2),'status':res.status,'retryAfter':res.headers.get('Retry-After'),'error':data.get('error'),'snapshot':data.get('snapshot'),'freshness':data.get('freshness')}
    if route=='markets-snapshot':row['entries']=[{'poolId':x.get('poolId'),'observedAt':x.get('observedAt'),'ageSeconds':round(time.time()-x['observedAt'],1) if isinstance(x.get('observedAt'),int) else None,'marketStatus':(x.get('market') or {}).get('status')} for x in data.get('pools',[])]
    if route=='pool-market':row.update(marketStatus=data.get('market',{}).get('status'),marketCache=data.get('market',{}).get('cache'),chartStatus=data.get('priceHistory',{}).get('status'))
  except Exception as e:row={'case':name,'iteration':iteration,'errorClass':type(e).__name__,'durationMs':round((time.monotonic()-start)*1000,2)}
  rows.append(row);print(json.dumps(row),flush=True);time.sleep(max(0,1.2-(time.monotonic()-start)))
summary={}
for name,_,_ in CASES:
 good=[x['durationMs'] for x in rows if x['case']==name and x.get('status')==200]
 summary[name]={'count':len(good),'medianMs':statistics.median(good) if good else None,'maxMs':max(good) if good else None,'statuses':[x.get('status',x.get('errorClass')) for x in rows if x['case']==name]}
print(json.dumps({'summary':summary}),flush=True)
