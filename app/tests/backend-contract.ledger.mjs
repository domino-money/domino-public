/**
 * Issue #1, first acceptance criterion: agree the adapter's request and
 * response types against backend/openapi-read.json and the Python response
 * fixtures, and record the backend contract gaps.
 *
 * The adapter is typed against read-v1, the package the browser actually
 * reads through the bridge. The backend's OpenAPI document is generated from
 * the Python request and response models, and read-v1's fixtures/producer/
 * are Python-produced responses, never handwritten. tests/backend-contract.test.mjs
 * compares all three, field by field, and this file is the record of every
 * difference it finds. The test fails when a difference appears that is not
 * listed here, and when one listed here disappears, so the record cannot go
 * stale in either direction.
 *
 * It lives with the tests, not in src: nothing in the app imports it, and it
 * has to name the private API's paths to describe them, which src never may
 * (tests/read.test.mjs scans src for them).
 *
 * In every case the browser path (read-v1 and the bridge) is the stricter or
 * more specific side, or the two sides are equivalent, and the adapter follows
 * the browser path. None needs a change to the adapter. rugged97 decided the
 * three questions this record raised on issue #1
 * (https://github.com/domino-money/domino/issues/1#issuecomment-5634425074);
 * each such entry quotes the decision.
 */

/**
 * @typedef {object} BackendGap
 * @property {string} id
 * @property {readonly string[]} schemaDiffs The differences the test's schema comparison reports for this gap, exactly.
 * @property {string} openapi
 * @property {string} readV1
 * @property {string} adapter What the adapter does about it.
 * @property {string} question What is still open for rugged97, or 'None' and why.
 * @property {string} [decision] rugged97's decision on issue #1, quoted, where one was asked for.
 * @property {string} [endAssertion] For a pattern difference: what OpenAPI appends to the read-v1 pattern, exactly.
 */

/** Paths outside read-v1. V3 and the V4 owner snapshot are additive, separately gated read namespaces. */
export const OPENAPI_NON_READ_PATHS = [
  'GET /health', 'GET /v1/capabilities',
  'POST /v3/read/history', 'POST /v3/read/overview', 'POST /v3/read/search',
  'POST /v4/read/sequence-snapshot', 'POST /v5/read/featured-pools',
];

/** Error statuses in read-v1 that no OpenAPI read route declares, with their codes. */
export const BRIDGE_ONLY_ERROR_STATUSES = {
  404: ['route_not_available'],
  405: ['method_not_allowed'],
};

/** Whether the OpenAPI document mentions the X-Domino-Read-Contract header anywhere. */
export const OPENAPI_DECLARES_CONTRACT_HEADER = false;

/**
 * Requests the Python models accept that the bridge refuses before any
 * gateway sees them, by boundary-corpus case, with the code it answers.
 */
export const BRIDGE_REFUSES_PYTHON_VALID = {
  'wallet-assets cursor-unicode-max': 'request_too_large',
};

/** Producer fixtures whose body differs from the browser-facing gateway fixture of the same name, by JSON path. */
export const PRODUCER_GATEWAY_DIFFERENCES = {
  'wallet-assets.page': ['inventory.nextCursor'],
};

/** @type {readonly BackendGap[]} */
export const BACKEND_GAPS = [
  {
    id: 'nft-token-id-range',
    schemaDiffs: ['nft-positions.request.tokenIds[].pattern'],
    endAssertion: '(?![\\s\\S])',
    openapi: 'Since #74 the tokenIds items carry maxLength 78 and the uint256 pattern, and since #77 the array carries uniqueItems. The item pattern is the read-v1 pattern followed by (?![\\s\\S]), so the end of the value is asserted without relying on $, which in JavaScript also matches before a final newline.',
    readV1: 'The same maxLength 78, the same uint256 alternation anchored ^...$, and uniqueItems. The read-v1 runtime refuses an anchored pattern whose match is not the whole value, so a final newline is refused there as well: the two describe the same set of ids.',
    adapter: 'Validates every request with the read-v1 runtime before sending, so an out-of-range, duplicate or newline-suffixed id never leaves the browser. tests/backend-contract.test.mjs checks the pattern relation exactly and runs both patterns over the 2^256 boundary; the Python request corpus (fixtures/request-boundaries.json) agrees with read-v1 on every case.',
    question: 'None: the uint256 description defect is fixed on the producer side (#74 bound, #77 uniqueness) and what remains is this equivalent end assertion.',
    decision: 'rugged97 on issue #1: "The adapter/runtime bound is correct." The OpenAPI follow-up was the producer\'s, with no widening of the runtime.',
  },
  {
    id: 'capabilities-untyped',
    schemaDiffs: [
      'capabilities.response.additionalProperties',
      'capabilities.response.automation',
      'capabilities.response.chainId',
      'capabilities.response.contractVersion',
      'capabilities.response.dataMode',
      'capabilities.response.enabledReads',
      'capabilities.response.ownerTransactions',
      'capabilities.response.privateAccounts',
      'capabilities.response.required',
      'capabilities.response.type',
      'capabilities.response.walletAuthentication',
    ],
    openapi: 'GET /v1/capabilities answers an untyped schema ({}).',
    readV1: 'capabilities.response is a closed object: chainId 4663, contractVersion, dataMode, enabledReads and the four capability flags fixed to false.',
    adapter: 'Reads capabilities only through the bridge (GET /api/read/v1/capabilities) and trusts nothing the read-v1 schema does not describe.',
    question: 'None: decided. The private /v1/capabilities is a different, local-development document; the bridge builds the public capabilities reply itself.',
    decision: 'rugged97 on issue #1: "keep validating that closed read-v1 shape." Typing the private endpoint later must not replace it or expose private paths.',
  },
  {
    id: 'cursor-size',
    schemaDiffs: [],
    openapi: 'wallet-assets cursor is up to 4096 characters, counted as code points by the Python model, so up to 16 KiB of UTF-8.',
    readV1: 'The bridge refuses any request body over 8192 bytes with 413 request_too_large, so a 4096-character cursor of four-byte characters (the corpus case wallet-assets cursor-unicode-max, 16451 bytes) never reaches the gateway.',
    adapter: 'Sends cursors back byte for byte and treats the 413 as a refused request: shown as unavailable, not retried. Real cursors come from the gateway as 64 hex characters, far inside both limits.',
    question: 'None: decided. The bridge limit is the intended one; no larger body limit and no cursor normalization.',
    decision: 'rugged97 on issue #1: "the 8192-byte bridge request limit is intentional." Preserve the handle byte for byte and surface 413 without retry.',
  },
  {
    id: 'bridge-only-statuses',
    schemaDiffs: [],
    openapi: 'Every read route declares 400, 403, 408, 409, 413, 415, 422, 429, 502, 503 and 504, all with the same ErrorResponse.',
    readV1: 'The same 56 error codes, plus route_not_available (404) and method_not_allowed (405), which only the bridge produces; each code is bound to one status.',
    adapter: 'The error table covers all 56 codes and the 404/405 pair; validateError checks the code against its status.',
    question: 'None: the pair belongs to the bridge. Recorded so it is not mistaken for drift.',
  },
  {
    id: 'no-contract-header',
    schemaDiffs: [],
    openapi: 'Declares no response headers and no contract version; info.version is the Python API version (0.8.0).',
    readV1: 'Every bridge reply carries X-Domino-Read-Contract: 1.1.0-rc.3.',
    adapter: 'Requires the exact header on every JSON reply, success or error.',
    question: 'None: the header is the bridge contract, not the private API. Recorded so the two versions are not confused.',
  },
  {
    id: 'private-paths',
    schemaDiffs: [],
    openapi: 'Describes the private API at /v1/read/* and /v1/capabilities, plus /health.',
    readV1: 'The browser reads /api/read/v1/* on its own origin; the bridge maps it to the gateway and never relays /health or the OpenAPI document.',
    adapter: 'Sends only to /api/read/v1/ plus a route from the closed list; a source scan fails on any private path in src.',
    question: 'None.',
  },
  {
    id: 'sealed-cursor',
    schemaDiffs: [],
    openapi: 'wallet-assets inventory.nextCursor is a string.',
    readV1: 'The Python producer fixture carries the private API\'s own continuation; the gateway fixture carries the handle the bridge hands the browser instead.',
    adapter: 'Holds any cursor as an opaque handle and sends it back byte for byte; it never parses or shows one.',
    question: 'None: confirms the browser only ever sees the gateway handle.',
  },
];
