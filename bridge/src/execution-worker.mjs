import {createAuthenticatedWorker} from './authenticated-worker.mjs';
import * as runtime from '../../api-contracts/execution-v1/runtime.mjs';
export const EXECUTION_LIMITS=Object.freeze({requestBytes:2048,responseBytes:131072,cookiesBytes:8192,bodyMs:5000,totalMs:25000,upstreamMs:20000});
function associated(route,body,data) {
  if(route==='status')return data.item===null || data.item.intentId===body.intentId;
  return data.items.length<=(body.limit??10) && data.items.every(row=>!body.afterIntentId || row.intentId>body.afterIntentId);
}
export function createExecutionWorker(options={}) {
 return createAuthenticatedWorker({...runtime,PREFIX:'/api/execution/v1/',HEADER:'X-Domino-Execution-Contract',envPrefix:'EXECUTION',internalPrefix:'/internal/execution/v1/',limits:EXECUTION_LIMITS,associated,assertFresh:()=>{}},options);
}
export default createExecutionWorker();
