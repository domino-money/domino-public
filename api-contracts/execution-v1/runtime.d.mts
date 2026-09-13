import type {ExecutionRoute,ExecutionRequests,ExecutionResponses,ExecutionError,ExecutionErrorCode} from './types.js';
export const CONTRACT_VERSION:'1.0.0-rc.1';
export const ROUTES:readonly ExecutionRoute[];
export const ERROR_STATUS_BY_CODE:Readonly<Record<ExecutionErrorCode,number>>;
export function validateRequest<R extends ExecutionRoute>(route:R,value:unknown):value is ExecutionRequests[R];
export function validateResponse<R extends ExecutionRoute>(route:R,value:unknown):value is ExecutionResponses[R];
export function validateError(status:number,value:unknown):value is ExecutionError;
