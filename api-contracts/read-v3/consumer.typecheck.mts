import { assertRequest, assertResponse, matchesRequest } from './runtime.mjs';
import type { ReadV3Requests, ReadV3Responses } from './types.js';
const query: ReadV3Requests['overview'] = { token: '0x1111111111111111111111111111111111111111' };
const checked = assertRequest('overview', query);
const read = (value: unknown): ReadV3Responses['overview'] => assertResponse('overview', value);
void ((value: unknown) => matchesRequest('overview', checked, read(value)));
