import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CONTRACT_VERSION, ROUTES, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError } from '../../api-contracts/onboarding-v1/runtime.mjs';

const base = new URL('../../api-contracts/onboarding-v1/', import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, base), 'utf8'));
const manifest = await read('manifest.json');

test('onboarding manifest binds schemas, types, runtime and synthetic adapter fixtures', async () => {
  assert.equal(manifest.contractVersion, CONTRACT_VERSION);
  assert.equal(manifest.status, 'candidate_disabled_pending_consumer_acknowledgement');
  for (const file of manifest.files) {
    const content = await readFile(new URL(file.path, base));
    assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, file.path);
  }
});

for (const route of ROUTES) test(`onboarding synthetic adapter fixtures validate: ${route}`, async () => {
  assert.equal(validateRequest(route, await read(`fixtures/requests/${route}.json`)), true);
  assert.equal(validateResponse(route, await read(`fixtures/responses/${route}.json`)), true);
});

for (const name of ['swap-preview.unknown','position-preview.incomplete','position-preview.blocked','position-preview.native']) test(`onboarding preserves ${name}`, async () => {
  assert.equal(validateResponse(name.split('.')[0], await read(`fixtures/variants/${name}.json`)), true);
});

test('onboarding error statuses match the finite Python map and never forward details', async () => {
  const fixtures=await read('fixtures/errors.json');
  assert.deepEqual(Object.keys(fixtures).sort(),Object.keys(ERROR_STATUS_BY_CODE).sort());
  for(const {body,status} of Object.values(fixtures)) {
    assert.equal(validateError(status,body),true);
    assert.equal(validateError(status+1,body),false);
    assert.equal(validateError(status,{...body,detail:'private-provider-text'}),false);
  }
});

for (const route of ROUTES) test(`closed ${route} output rejects mutations at every nested object`, async () => {
  const body = await read(`fixtures/responses/${route}.json`);
  function mutations(value) {
    const cases=[];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      cases.push({...value,transaction:{data:'private-canary'}});
      for(const [key,child] of Object.entries(value)) {
        const missing={...value};delete missing[key];cases.push(missing);
        cases.push({...value,[key]:typeof child === 'string' ? 123 : 'coercion'});
        if(typeof child === 'boolean') cases.push({...value,[key]:Number(child)});
        for(const changed of mutations(child)) cases.push({...value,[key]:changed});
      }
    } else if(Array.isArray(value)) {
      for(let index=0;index<value.length;index++) for(const changed of mutations(value[index])) {
        const mutation=[...value];mutation[index]=changed;cases.push(mutation);
      }
    }
    return cases;
  }
  for(const changed of mutations(body)) assert.equal(validateResponse(route,changed),false);
});

test('runtime refuses non-JSON objects, raw overflow, negative zero and trailing newlines', async () => {
  const body=await read('fixtures/requests/swap-preview.json');
  for(const value of [null,[],new Date(),Object.assign(Object.create({polluted:true}),body)]) assert.equal(validateRequest('swap-preview',value),false);
  for(const amountRaw of [String(1n<<256n),'01','1\n',1e30]) assert.equal(validateRequest('swap-preview',{...body,amountRaw}),false);
  assert.equal(validateRequest('swap-preview',{...body,slippageBps:-0}),false);
  assert.equal(validateRequest('__proto__',body),false);
  assert.equal(validateError(503,{error:'unknown_provider_error'}),false);
});
