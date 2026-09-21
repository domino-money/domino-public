#!/usr/bin/env python3
"""Recompute the documented planning scenarios from committed evidence, offline.

Run from any directory. Optional source roots support the isolated audit checkout;
ordinary use needs no arguments. --out-dir permits comparison without overwriting.
No RPC, wallet, environment credential, signing or transaction access.
"""
from pathlib import Path
import argparse
from decimal import Decimal as D, getcontext
from datetime import datetime, timezone
import json, hashlib, statistics
getcontext().prec=36
repo=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence-root',type=Path,default=repo)
parser.add_argument('--production-root',type=Path,default=repo)
parser.add_argument('--out-dir',type=Path,default=Path(__file__).resolve().parent)
args=parser.parse_args()
R=args.evidence_root.resolve();P=args.production_root.resolve();OUT=args.out_dir.resolve()
OUT.mkdir(parents=True,exist_ok=True)
E=D(10)**18; price=D(52694000); fx=D('2748.79'); s=D('.02'); haircut=D('.003'); buffer=D('.15')
read=lambda n:json.loads((R/'reports/gas-funding-2026-09-21'/n).read_text())
quotes=read('nonzero-data-quotes.json'); first=read('gas-measurements.json'); complete=read('gas-measurements-complete.json'); probe=read('local-rpc-probe.json')
da={q['kind']:D(q['l1DataGasInL2Units'])*D(q['baseFeeWei'])/E for q in quotes['quotes']}
for t in first['transactions']:
 if t['kind'].startswith('treasury_'):
  q=next(q for q in t['dataQuotes'] if q['number']==68923379);da[t['kind']]=D(q['l1DataGasInL2Units'])*D(q['baseFeeWei'])/E
G={'general':1175124,'swap':1497579,'mint':1895616};low={'general':1157932,'swap':1440762,'mint':1737500};names={'general':'Direct reinvestment','swap':'Swap + reinvestment','mint':'MINT successor'}
gpub=157278

def cost(g,p=price,data=0):return D(g)*p/E+D(data)
def refill(kind='sale',p=price,nonzero=True,salegas=350000):
 if kind=='sale':return cost(salegas,p) # Assumed all-in gas-equivalent incl data; not a measured route.
 if kind=='none':return D(0)
 z=cost(21000,p,da['treasury_native_transfer'] if nonzero else 0)
 if kind=='weth':z+=cost(47873,p,da['treasury_unwrap_weth'] if nonzero else 0)
 return z

def model(k,n=10,b=100,f=D('.05'),r=D('.5'),p=price,nonzero=True,ref='sale',salegas=350000,a=D(1),h=haircut,opex=D(0)):
 ds=da['execute_'+k] if nonzero else D(0);dp=da['publish_observation'] if nonzero else D(0)
 cs=cost(G[k],p,ds);cf=cost(D(G[k])*r,p,ds);cp=cost(gpub,p,dp);cr=refill(ref,p,nonzero,salegas)
 total=cs+f/(1-f)*cf+cp/D(n)+cr/D(b)+opex
 denom=s*a*(1-h)
 return {'successETH':cs,'failureETH':cf,'failureAllocationETH':f/(1-f)*cf,'publisherAllocationETH':cp/D(n),'refillAllocationETH':cr/D(b),'operatingAllocationETH':opex,'costETH':total,'costUSD':total*fx,'cashBreakEvenConsumedFeesETH':total/denom,'bufferedConsumedFeesETH':(1+buffer)*total/denom,'bufferedConsumedFeesUSD':(1+buffer)*total/denom*fx}

def aa(k,extra=100000,markup=D('.10'),api=D(0),n=10,f=D('.05'),r=D('.5'),p=price,nonzero=True):
 x=model(k,n=n,f=f,r=r,p=p,nonzero=nonzero)
 # Increment covers account/validation/paymaster and incremental posting gas-equivalent.
 addon=cost(extra,p);network=x['successETH']+addon+f/(1-f)*(x['failureETH']+addon)+(cost(gpub,p,da['publish_observation'] if nonzero else 0)+addon)/D(n)
 apieth=api/fx*(1/(1-f)+1/D(n))
 total=(1+markup)*network+x['refillAllocationETH']+apieth
 return {'incrementalAllInGasEquivalentPerUserOp':extra,'sponsorshipRate':markup,'apiUSDPerAttemptAndPublication':api,'costETH':total,'costUSD':total*fx,'networkAndSponsorshipETH':network*(1+markup),'apiAllocationETH':apieth,'treasuryRealizationAllocationETH':x['refillAllocationETH'],'bufferedConsumedFeesETH':total*(1+buffer)/(s*(1-haircut)),'bufferedConsumedFeesUSD':total*(1+buffer)/(s*(1-haircut))*fx}

observed=[]
for k in G:
 for nz in [False,True]:
  for footprint in ['low','upper']:
   v=cost(low[k] if footprint=='low' else G[k],data=da['execute_'+k] if nz else 0)
   observed.append({'recipe':k,'dataScenario':'recorded_nonzero' if nz else 'observed_zero','footprint':footprint,'gasUsed':low[k] if footprint=='low' else G[k],'costETH':v,'costUSD':v*fx})
base={k:model(k) for k in G}
publish=[{'recipe':k,'successesPerPublication':n,**model(k,n=n)} for k in G for n in [1,10,100]]
stress=[{'recipe':k,'gasPriceGwei':gp,**model(k,p=gp*D(10)**9)} for gp in map(D,['.052694','.1','.25','.5']) for k in G]
failures=[{'minedFailureProbability':f,'failedComputeFraction':r,**model('general',f=f,r=r)} for f in map(D,['0','.01','.05','.10','.25']) for r in map(D,['.25','.5','1'])]
refills=[{'path':path,'successesPerBatch':b,'batchCostETH':refill(path),'allocatedCostETH':refill(path)/D(b),'allocatedCostUSD':refill(path)/D(b)*fx} for path in ['native','weth','sale'] for b in [1,10,100,1000]]
options=[]
for k in G:
 for opt,lo,hi in [
  ('A_manual_ETH',model(k,ref='native',nonzero=False),model(k,ref='native')),
  ('B_treasury_conversion',model(k,nonzero=False,salegas=200000),model(k,salegas=500000)),
  ('C_Pimlico_included_API',aa(k,extra=100000,nonzero=False),aa(k,extra=300000)),
  ('C_Pimlico_overquota_API',aa(k,extra=100000,nonzero=False,api=D('.0105')),aa(k,extra=300000,api=D('.0105'))),
  ('C_Alchemy_8pct_gas_only',aa(k,extra=100000,nonzero=False,markup=D('.08')),aa(k,extra=300000,markup=D('.08')))]:
  options.append({'option':opt,'recipe':k,'lower':lo,'upper':hi})
opex=[{'hypotheticalMonthlyUSD':D(50),'monthlySuccesses':m,'opexUSDPerSuccess':D(50)/m,'operatorCostETH':D(50)/m/fx,'additionalBufferedConsumedFeesUSD':D(50)/m*(1+buffer)/(s*(1-haircut)),'generalWithOpex':model('general',opex=D(50)/m/fx)} for m in [1000,10000]]
manifest=[]
for root,files in [(R,['reports/gas-funding-2026-09-21/'+n for n in ['local-rpc-probe.json','gas-measurements.json','gas-measurements-complete.json','nonzero-data-quotes.json','local-fork-narrow-20pct.json']]+['reports/fork/weth-usdg-wide-remediated-2026-09-21.json']),(P,['PRICING_POLICY.md','REINVESTMENT_POLICY.md','backend/execution_planner.py','backend/execution_signer.py'])]:
 for path in files:
  p=root/path;manifest.append({'path':path,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'basis':'evidence or reviewed production source; not executed by this calculator'})
prices=[int(x['baseFeePerGas'],16) for x in first['priceHistory']];times=[int(x['timestamp'],16) for x in first['priceHistory']]
calc={'schemaVersion':1,'generatedAtUTC':datetime.now(timezone.utc).isoformat(),'status':'planning scenarios, not live complete-transaction quotes or profitability forecasts','calculatorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'sourceManifest':manifest,'inputs':{'chainId':4663,'baselineGasPriceWei':price,'gasPriceCapturedAtUTC':probe['capturedAt'],'baselineBlock':probe['snapshots']['latest']['number'],'ethUsd':fx,'ethUsdSource':'https://api.exchange.coinbase.com/products/ETH-USD/ticker','ethUsdTradeAtUTC':'2026-09-21T16:10:47.868047798Z','ethUsdRetrievedAtUTC':'2026-09-21T16:10:48.068Z','serviceRate':s,'realizationHaircutAssumption':haircut,'policyCostBuffer':buffer,'allocationToGasAssumption':1,'failureProbabilityAssumption':'.05','failedComputeFractionAssumption':'.5','successesPerPublicationAssumption':10,'successesPerRefillAssumption':100,'saleRefillAllInGasEquivalentAssumption':350000,'observedExecutionGasUpper':G,'observedExecutionGasLower':low,'publicationGas':gpub,'nonzeroDataQuotes':quotes,'nonzeroDataCostETH':da,'hypotheticalContinuousPublisher':{'intervalSeconds':25,'perPoolPerDay':3456,'costUSDZeroPosting':cost(gpub)*fx*3456,'costUSDRecordedNonzeroPosting':cost(gpub,data=da['publish_observation'])*fx*3456},'headerPriceSample':{'count':len(prices),'secondsSpan':max(times)-min(times),'minWei':min(prices),'medianWei':statistics.median(prices),'maxWei':max(prices)},'caveats':['observed gas upper is not a maximum limit','baseline price and historical nonzero posting quote are mixed snapshots','all-in AA overhead and treasury token-sale budgets are assumptions, not measured routes','USDG is never assumed to equal USD','no real transactions sent or wallets loaded']},'formulas':{'successCostETH':'P * Gs / 1e18 + Ds','failureCostETH':'P * r * Gs / 1e18 + Ds','postingQuoteETH':'NodeInterface.l1DataGasInL2Units * SAME_RESPONSE.baseFeeWei / 1e18','costPerSuccessETH':'Cs + f/(1-f)*Cf + Cp/N + Cr/B + O','cashBreakEvenConsumedFeesETH':'C / (0.02 * a * (1-h))','bufferedConsumedFeesETH':'1.15 * C / (0.02 * a * (1-h))','aaCostETH':'(1+m)*(Cs+P*Ga/1e18 + f/(1-f)*(Cf+P*Ga/1e18) + (Cp+P*Ga_pub/1e18)/N) + Cr/B + A/ETHUSD*(1/(1-f)+1/N)','N':'successful eligible executions per paid observation publication; includes wasted publications in realized denominator','B':'successful executions supported per treasury realization/refill batch','F':'new original earned fee basis consumed; excludes already charged converted lots and principal','O':'other operating/provider costs allocated per success'},'standaloneExecutionScenarios':observed,'baseline':base,'publisherAmortization':publish,'gasPriceStressWithFixedHistoricalDataETH':stress,'failureSensitivityGeneral':failures,'refillAmortization':refills,'optionRanges':options,'fixedOpexSensitivity':opex,'realizationSensitivity':[{'allocation':a,'haircut':h,'thresholdMultiplierRelativeToBaseline':(1-haircut)/(a*(1-h))} for a in map(D,['1','.75','.5']) for h in map(D,['0','.003','.01','.05'])]}
def conv(x):
 if isinstance(x,D):return format(x,'f')
 raise TypeError(type(x))

# Independent checks of formulas and expected direction; no live state or transactions.
for k in G:
 z=model(k,f=D(0),n=1,b=1,ref='none',nonzero=False,h=D(0));assert z['costETH']==(D(G[k])+gpub)*price/E
 assert z['bufferedConsumedFeesETH']==z['costETH']*D('57.5')
 assert model(k,n=1)['costETH']>model(k,n=10)['costETH']>model(k,n=100)['costETH']
 assert model(k,b=1)['costETH']>model(k,b=100)['costETH']
 assert model(k,f=D('.25'))['costETH']>model(k,f=D(0))['costETH']
 assert model(k,p=D(500000000))['costETH']>model(k,p=price)['costETH']
 assert aa(k,extra=300000)['costETH']>aa(k,extra=100000)['costETH']
 assert model(k,a=D('.5'))['bufferedConsumedFeesETH']==2*model(k)['bufferedConsumedFeesETH']
 assert aa(k,extra=0,markup=D(0),api=D(0))['costETH']==model(k)['costETH']
for q in quotes['quotes']:assert da[q['kind']]*E==D(q['l1DataGasInL2Units'])*D(52962000)
assert len(prices)==61 and max(prices)==491854000
assert G['mint']==read('local-fork-narrow-20pct.json')['lifecycle']['steps'][0]['gasUsed']
calc['numericValidation']={'status':'passed','checks':['zero-failure/zero-posting/zero-refill identity','57.5-times buffered threshold at zero haircut','monotonic publisher and refill sharing','monotonic failure and gas-price cost','monotonic AA overhead','half revenue allocation doubles threshold','zero-overhead/zero-surcharge AA equals EOA model','posting cost uses same quote response base fee','61 observed price samples and recorded maximum','MINT observed upper matches recorded lifecycle']}
(OUT/'calculations.json').write_text(json.dumps(calc,indent=2,default=conv)+'\n')

def money(x,d=3):return f'${x:,.{d}f}'
def et(x):return f'{x:.8f}'
def table(headers,rows):return '\n'.join(['| '+' | '.join(headers)+' |','| '+' | '.join('---' for _ in headers)+' |']+['| '+' | '.join(map(str,row))+' |' for row in rows])
footrows=[]
for k in G:
 z=cost(G[k]);nz=cost(G[k],data=da['execute_'+k]);footrows.append([names[k],f'{low[k]:,}–{G[k]:,}',1764 if k!='swap' else 1956,f'{et(z)} / {money(z*fx)}',f'{et(nz)} / {money(nz*fx)}'])
for label,g,key,bytes_ in [('Publish observation',gpub,'publish_observation',196),('Unwrap WETH',47873,'treasury_unwrap_weth',36),('Native ETH transfer',21000,'treasury_native_transfer',0)]:
 z=cost(g);nz=cost(g,data=da[key]);footrows.append([label,f'{g:,}',bytes_,f'{et(z)} / {money(z*fx,4)}',f'{et(nz)} / {money(nz*fx,4)}'])
pubrows=[[names[k],n,et(model(k,n=n)['costETH']),money(model(k,n=n)['costUSD']),et(model(k,n=n)['bufferedConsumedFeesETH']),money(model(k,n=n)['bufferedConsumedFeesUSD'],2)] for k in G for n in [1,10,100]]
optionrows=[]
for opt,label in [('A_manual_ETH','A — prefunded native ETH'),('B_treasury_conversion','B — treasury conversion/refill'),('C_Pimlico_included_API','C — sponsored, included API'),('C_Pimlico_overquota_API','C — sponsored, over-quota API')]:
 for k in G:
  x=next(x for x in options if x['option']==opt and x['recipe']==k);l=x['lower'];u=x['upper'];optionrows.append([label,names[k],f"{money(l['costUSD'])}–{money(u['costUSD'])}",f"{money(l['bufferedConsumedFeesUSD'],2)}–{money(u['bufferedConsumedFeesUSD'],2)}"])
refillrows=[[{'native':'Native transfer','weth':'WETH unwrap + transfer','sale':'Token conversion, assumed 350k all-in'}[path],money(refill(path)*fx,4)]+[money(refill(path)/D(b)*fx,5) for b in [10,100,1000]] for path in ['native','weth','sale']]
stressrows=[[str(gp)]+[money(model(k,p=gp*D(10)**9)['costUSD'])+' / '+money(model(k,p=gp*D(10)**9)['bufferedConsumedFeesUSD'],2) for k in G] for gp in map(D,['.052694','.1','.25','.5'])]
failrows=[[f'{f*100:g}%']+[money(model('general',f=f,r=r)['costUSD'])+' / '+money(model('general',f=f,r=r)['bufferedConsumedFeesUSD'],2) for r in map(D,['.25','.5','1'])] for f in map(D,['0','.01','.05','.10','.25'])]
opexrows=[[x['monthlySuccesses'],money(x['opexUSDPerSuccess'],3),money(x['generalWithOpex']['costUSD']),money(x['additionalBufferedConsumedFeesUSD'],2),money(x['generalWithOpex']['bufferedConsumedFeesUSD'],2)] for x in opex]
report=f'''# Gas funding economics — 21 September 2026

At the captured gas price, the model puts marginal company cost near **{money(base['general']['costUSD'])} for direct reinvestment, {money(base['swap']['costUSD'])} with a swap, and {money(base['mint']['costUSD'])} for successor creation**. Those examples require roughly **{money(base['general']['bufferedConsumedFeesUSD'],2)}, {money(base['swap']['bufferedConsumedFeesUSD'],2)}, and {money(base['mint']['bufferedConsumedFeesUSD'],2)} of newly charged consumed earned fees**, respectively, for the existing 2% cut to cover the modeled cost plus the policy's 15% buffer. These are planning scenarios, not live complete-transaction estimates or profitability forecasts. A high-gas snapshot changes them substantially.

For launch, prefunded company ETH is the simplest path consistent with the implemented EOA tooling. Automatic conversion of already collected company revenue is the useful next funding feature; it does not require a larger user fee. Sponsorship may reduce wallet-funding work but adds account integration, provider cost and eligibility requirements. [Architecture and controls](OPTIONS_AND_CONTROLS.md) and [provider evidence](ECOSYSTEM.md) describe feasibility separately.

## Scope, prices and measurement quality

Research only. No mainnet transactions, asset sales, keys or new production behavior. Calculations generated at `{calc['generatedAtUTC']}`; [calculation JSON](calculations.json) records formulas, assumptions, source SHA-256 hashes and unrounded decimal results.

The approved [pricing policy](../../PRICING_POLICY.md) charges 2% of consumed earned fees once, excluding principal and previously charged converted lots. Gas comes from that service revenue, with no additional automation fee. The [reinvestment policy](../../REINVESTMENT_POLICY.md) uses a 15% operator-cost buffer and a separate owner-benefit test. Net-realizable fee revenue, failed attempts, route/provider charges and operating expenses all matter. TVL and idle accrued balances are not revenue.

The local synced Nitro node (`eth_syncing=false`) recorded **0.052694 gwei** and zero priority fee at block **68930584**, captured **2026-09-21T16:11:47.060Z**. [Local RPC evidence](local-rpc-probe.json). A 61-header sample spanning 3,604 seconds had minimum **0.049996**, median **0.051788** and maximum **0.491854 gwei**. These are sampled points, not a continuous range, forecast or upper bound. [Measurement evidence](gas-measurements.json).

USD displays use the actual Coinbase ETH/USD trade quote **$2,748.79/ETH**, trade timestamp **2026-09-21T16:10:47.868047798Z**, retrieved **16:10:48.068Z**. [Official ticker](https://api.exchange.coinbase.com/products/ETH-USD/ticker); captured body in [ecosystem evidence](ECOSYSTEM.md). No USDG peg or USDG/USD price is assumed.

Nitro charges child execution plus parent-chain posting, expressed as one gas bill. A full `eth_estimateGas` or `gasEstimateComponents` total already includes posting; adding a separate data estimate to that total would double count. The model below instead combines a synthetic child footprint with a separately measured posting component. [Official Nitro estimation documentation](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas).

The child receipts use an explicit ArbSys stand-in and artificial account funding. They measure these scenarios' EVM work; they do not establish complete native Nitro execution gas. The synthetic 1-gwei receipt price is never used as today's network price. Earlier [corrected fork results](../v4-remediation-2026-09-21/FORK_RESULTS.md), the [fresh footprint](gas-footprint-fork.json), [extended lifecycle footprint](gas-footprint-lifecycle-fork.json), and [local 20% fork](local-fork-narrow-20pct.json) give the observed range. Different treasury/position states change gas; the upper observed value is a conservative modeling input within this sample, **not a worst-case cap**. Owner exits are outside operator automation and excluded.

The exact calldata posting quotes include both zero observations and nonzero observations. [Nonzero quotes](nonzero-data-quotes.json) use pinned block **68923379**, hash `0xbe307cc6ca57f5cd9dc9ac6a3ee319ef3de846f9d78016f53c14d99b9f920207`, captured **2026-09-21T16:19:29.498139Z**. Returned data gas is 116,005 / 122,176 / 117,543 for direct / swap / MINT, and 58,257 for publishing. Each quote returned **52,962,000 wei** per L2 gas unit. Multiplying by that same returned value gives its posting cost; the header base fee and another snapshot's price are not substitutes. WETH/native transfer use the same block's 30,496 / 25,523 data gas from the first measurement. The following nonzero scenario combines these fixed historical posting costs with the baseline execution price; it is deliberately a **mixed-snapshot sensitivity**, not a same-block live quote. A zero sample does not guarantee permanent free posting.

## Per-transaction footprint

The last two columns use the upper observed execution footprint. They exclude publishing, treasury replenishment, failures and fixed operating costs from the individual execute row.

{table(['Operation','Observed child gas','Calldata bytes','Zero posting: ETH / USD','Recorded nonzero posting: ETH / USD'],footrows)}

MINT's 1,737,500 gas comes from the extended measurement and 1,895,616 from the completed local 20% lifecycle. Swap's observed lower and upper are 1,440,762 and 1,497,579. These are particular synthetic states, not guaranteed live bounds. Full native transaction estimation and receipt reconciliation remain necessary before committing funds.

## Model and admission threshold

Let `F` be the gross reference ETH-equivalent value of **new original earned fees actually consumed and charged**, `s=0.02`, `h` the haircut needed to realize the company service share (set it to zero when `F` already uses a net realization quote), and `a` the portion of net service revenue available to this cost budget. Per-currency integer fee rounding must replace `s*F` in actual execution quotes. MINT or another recipe can consume previously charged lots and produce little or no new service revenue; that operation cannot pass a standalone revenue test by charging those lots again. A capped company subsidy is a separate decision.

```text
Cs = P * successful execution gas / 1e18 + success posting cost
Cf = P * failed execution gas / 1e18 + failure posting cost
C  = Cs + f/(1-f)*Cf + publication cost/N + treasury batch cost/B + O
cash break-even F = C / (s * a * (1-h))
policy-buffered F = 1.15 * C / (s * a * (1-h))
```

`f` is the fraction of mined execution attempts that fail; geometric retry averaging is a planning assumption, not permission to retry a stale transaction. `N` is successful eligible executions per paid publication, and `B` successful executions funded per treasury batch. `O` allocates other operating expenses. A mined revert normally earns no service fee but consumes gas and posts its transaction data. Dropped, unmined replacements do not themselves consume chain gas.

The existing planner compares the realized service cut with its supplied buffered gas quote. This study additionally allocates publication, treasury realization, failures and operating costs; it does not claim that current quote generation automatically aggregates every component.

The central scenario uses `f=5%`, failed compute at 50% of successful compute, the same posting allowance for a failed attempt, `N=10`, `B=100`, `h=0.3%`, `a=100%`, and zero fixed operating costs. Failure rate, haircut, sharing, conversion cost and allocation are **assumptions**. The token-conversion batch is a 350,000 all-in gas-equivalent planning allowance, including any approval/swap/unwrap/transfers and their posting; no live route quote supports that allowance. It is not added on top of a second data quote. Slippage/DEX losses belong in `h` only if not already included in a net realizable quote.

At these assumptions, cash break-even is about **50.15 times** cost; the 15% buffered fee threshold is about **57.67 times** cost. The buffer is company cost headroom, not a customer idle reserve. Reserving half the net revenue for other purposes doubles the consumed-fee threshold; reserving 25% raises it by one third. A 1% realization loss raises the baseline threshold by about 0.71%; 5% raises it by about 4.95%. Illiquid or unquoted fee assets cannot be assigned a cash value merely because the contract collected them.

## Publisher sharing and treasury batching

Table uses the recorded nonzero posting scenario and central assumptions above. `F` is consumed fee value, **not** the service fee charged to the owner.

{table(['Recipe','Successful actions/publication N','Cost ETH','Cost USD','Buffered F, ETH','Buffered F, USD'],pubrows)}

Sharing only works for compatible executions using the same eligible pool/anchor within its **255-L2-block freshness bound** and any shorter applicable observation-age policy. Observed block spacing around 0.1 second suggests about 25.5 seconds, not an entitlement to that much time or enough throughput for 100 actions. `N=100` is a sensitivity, not demonstrated production capacity. Wasted/expired publications lower realized `N`; unrelated pools and observations separated by hours cannot share the same publication. Failed publication attempts must also be included in the actual publication budget; the simple table assumes publication succeeds. Publishing every 25 seconds whether work is ready would create 3,456 publications per pool per day. At the measured baseline footprint, that hypothetical cadence costs about **{money(cost(gpub)*fx*3456,2)}–{money(cost(gpub,data=da['publish_observation'])*fx*3456,2)} per pool per day** across the zero/nonzero posting scenarios, before any execution. It is not current behavior or a recommended schedule. Publish on demand for ready eligible work and measure actual sharing; continuous publication can dominate a low-volume service.

A refill transfers previously owned company assets. Native ETH needs only a transfer; WETH needs unwrap plus transfer; another fee token needs a quoted, permitted conversion. The company must bootstrap enough native ETH for the first transactions; future fee revenue cannot prepay the transaction that earns it.

{table(['Treasury batch','One whole batch USD','Per success, B=10','B=100','B=1000'],refillrows)}

For a different token, the assumed 200k–500k all-in conversion budget costs **{money(cost(200000)*fx,4)}–{money(cost(500000)*fx,4)} per batch** at baseline, before token realization loss. A multi-hop route, approvals, extra wallets or difficult tokens can exceed it. One transfer here funds one destination; additional operator/publisher/refiller transfers need their own allowance. Manual and automated execution of the same treasury conversion have the same chain costs. Automation primarily improves replenishment reliability and adds monitoring/signing requirements.

## Three company-funded options

All ranges below keep `N=10`, `B=100`, the 5%/half-compute failure assumption, 0.3% realization haircut and 15% fee threshold buffer. Lower bounds use the zero posting scenario; upper bounds use the recorded nonzero posting scenario. Execution uses the same upper observed footprint throughout. These are **scenario ranges, not guaranteed bounds**. Fixed operating costs are separate.

{table(['Option','Recipe','Marginal cost/success, USD','Buffered consumed fee value, USD'],optionrows)}

**A — prefunded company ETH, manual replenishment.** Fits the existing EOA sender and admission model. The table allocates one native transfer per 100 successes; it assumes company treasury already has native ETH. Low software complexity and direct cost visibility favor launch. Manual lead time and isolated wallet balances can still stop execution. If replenishment requires selling tokens, add the corresponding treasury realization cost from B; initial company capital is working capital, not recurring revenue.

**B — separate automated company treasury realization and replenishment.** Collect the approved service share first, then convert only company assets and fund the operator/publisher. This preserves the user's 2% rate and fee-lot accounting. The table varies the all-in conversion budget from 200k to 500k per batch; no route, approval or sales automation currently qualifies that range. Benefits are fewer interruptions and systematic limits. Costs are token liquidity risk, price impact, refill failures and new treasury controls. Revenue on another chain or in an unavailable market is not immediately spendable local ETH.

**C — company-sponsored smart account/paymaster.** Model adds an assumed **100k–300k all-in incremental gas-equivalent per UserOperation**, covering validation/account/paymaster and additional posting overhead, before the sponsorship percentage. It assumes both execution and publication use sponsorship, charges failure attempts, and keeps B's central treasury-realization allocation for eventual company bill funding. That allocation is not a requirement to top up a managed paymaster. Real account deployment, complete UserOp gas, calldata and provider quotes are unmeasured; a first deployment may cost more. The current EOA validation/signer/nonce/receipt path needs a qualified account adapter. Native contract support alone does not make this a drop-in change.

The C table uses Pimlico's published **10% above EntryPoint actualGasCost** and compares included API quota with its illustrative **$0.0105 per sponsored UserOperation after quota**, applied to modeled execution attempts and publications. Actual polling/request use controls API credits. Commercial access and complete UserOp estimates remain unqualified. [Pimlico pricing](https://docs.pimlico.io/guides/pricing). Robinhood USDG is technically listed for ERC-20 payment, but its plan entitlement and live quote still need confirmation; this does not authorize charging customer assets. [Supported-token table](https://docs.pimlico.io/references/paymaster/erc20-paymaster/supported-tokens).

Alchemy publishes an **8% covered-gas surcharge**, but PAYG mainnet starts with a $0/month base sponsorship limit pending credits/custom limits. Its gas-only equivalent is included separately in calculation JSON; applying the same assumed account overhead yields slightly less than the 10% case, before any separate API or commercial costs. It is not an activated Domino quote. [Alchemy gas-manager terms](https://www.alchemy.com/docs/wallets/reference/gas-manager-faqs). Company sponsorship shifts who fronts and bills gas, not who ultimately pays. Provider availability, spend controls and invoicing can be useful; they introduce another execution dependency.

## Gas, failures and operating costs

Each cell below is `marginal cost / buffered consumed-fee threshold`, in USD at the dated ETH quote. Historical posting ETH costs are held fixed while L2 execution price changes; this isolates price sensitivity and is not a prediction of posting-price correlation. Gas prices above 0.5 gwei and larger posting charges remain possible.

{table(['L2 price, gwei','Direct','Swap','MINT'],stressrows)}

The sampled high of 0.491854 gwei is over nine times the baseline, so a 15% estimation margin cannot protect an old quote across such a move. Re-quote and wait when eligibility fails. The following direct-execution sensitivity includes the same publication/refill allocations and posting assumption. Early `InvalidPrice` refusals in the local 20% run used 317,599/340,536 child gas, but later failures can cost much more; there is no single universal failure discount.

{table(['Mined failure fraction','Failed compute 25%: cost / F','50%: cost / F','100%: cost / F'],failrows)}

Owning a node does not make hardware, electricity, backup, connectivity or staff free. A hypothetical **$50/month**, explicitly not measured Domino spending, allocates as follows to successful direct executions:

{table(['Successes/month','Fixed opex/success','Total cost/success','Additional buffered fee basis','Total buffered fee basis'],opexrows)}

Use actual workload and costs: `O_USD = monthly fixed costs / successful executions + variable support/provider costs`. Avoid double counting an expense already covered by a reduced revenue allocation `a`. The figures above establish neither enough consumed-fee volume nor positive owner benefit to support those monthly counts.

For illustration, 1,000 baseline direct successes consume about **{et(base['general']['costETH']*1000)} ETH ({money(base['general']['costUSD']*1000,2)})**, or **{et(base['general']['costETH']*1150)} ETH** with the model's 15% spending headroom, before fixed costs. That is a workload budget, not a sufficient wallet balance rule. Current signing checks the maximum transaction liability (`gasLimit * maxFeePerGas`), which can exceed expected receipt cost. Reserve outstanding maximum liabilities, the next eligible transaction and burn during refill lead time; mutually exclusive replacements at one nonce use the maximum liability, not the sum of every candidate. Size publisher and refill wallets too. See [signer](../../backend/execution_signer.py) and [economic gate](../../backend/execution_planner.py).

## Decision and remaining evidence

Use A for a controlled launch, with company ETH buffers and honest full-path cost inputs. Build B as a separate, limited treasury service if recurring volume makes manual funding fragile. Treat C as an optional account/billing integration after estimating its complete UserOperations and confirming commercial access. None requires an extra customer fee or a sale of principal. A customer gas escrow or an additional deduction would be a different product policy, not implied by this study.

Before assigning a live threshold, obtain coherent native Nitro estimates for actual deployed calldata/account state, a real realization route or cash value for each fee currency, measured failure/publication utilization, workload and infrastructure cost, and provider terms where relevant. Keep the owner-benefit gate independent. The present evidence establishes useful order-of-magnitude costs and sensitivity; it does not prove that every vault, fee lot or market condition is economically executable.

## Reproduction and arithmetic checks

Run `python3 reports/gas-funding-2026-09-21/reproduce_economics.py --out-dir /tmp/domino-gas-economics-reproduced` from the integrated checkout. The script uses committed evidence and the standard Python library only; it has no network or wallet access. It regenerates this report and calculation JSON, checks the zero-cost-component identity and the 57.5-times buffered threshold at zero haircut, monotonic sharing/failure/price sensitivities, the revenue-allocation identity, AA-to-EOA reduction when overhead and markup are zero, same-response posting arithmetic, and recorded price/MINT inputs. Timestamp and source hashes deliberately reflect the inputs used for that reproduction. These checks validate arithmetic and provenance, not the assumed failure rates, conversion route, provider gas or workload.
'''
(OUT/'ECONOMICS.md').write_text(report)
print(json.dumps({'outputDirectory':str(OUT),'baseline':base,'numericValidation':calc['numericValidation']},default=conv,indent=2))
