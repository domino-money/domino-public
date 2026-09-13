import {createAuthenticatedWorker} from './authenticated-worker.mjs';
import * as runtime from '../../api-contracts/performance-v2/runtime.mjs';

export const PERFORMANCE_LIMITS = Object.freeze({requestBytes:8192,responseBytes:65536,cookiesBytes:8192,
  bodyMs:5000,totalMs:25000,upstreamMs:20000});

function associated(route, body, data) {
  if (route === 'cards') return data.cards.length === body.epochIds.length &&
    data.cards.every((card,index) => card.epochId === body.epochIds[index]);
  if (route === 'enroll') return data.enrollment.vault === body.vault &&
    data.enrollment.tokenIds.length === body.tokenIds.length &&
    data.enrollment.tokenIds.every(id => body.tokenIds.includes(id));
  return data.enrollments.every(row => !body.after || row.enrollmentId > body.after) &&
    new Set(data.enrollments.map(row => row.enrollmentId)).size === data.enrollments.length &&
    (data.nextAfter === null || data.nextAfter === data.enrollments.at(-1)?.enrollmentId);
}

export function createPerformanceWorker(options={}) {
  return createAuthenticatedWorker({...runtime,PREFIX:'/api/performance/v2/',HEADER:'X-Domino-Performance-Contract',
    envPrefix:'PERFORMANCE',internalPrefix:'/internal/performance/v2/',limits:PERFORMANCE_LIMITS,
    associated,assertFresh:()=>{}},options);
}
export default createPerformanceWorker();
