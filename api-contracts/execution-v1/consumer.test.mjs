import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import * as runtime from './runtime.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/status-wire.json',import.meta.url)));
test('producer fixtures and closed owner-free request contract',()=>{
 for(const [route,value] of Object.entries(fixture.requests))assert(runtime.validateRequest(route,value));
 for(const [name,value] of Object.entries(fixture.responses))assert(runtime.validateResponse(name.split('.')[0],value),name);
 assert(!runtime.validateRequest('list',{owner:'0x'+'a'.repeat(40)}));
 assert(!runtime.validateRequest('list',{limit:21}));
 assert(!runtime.validateRequest('status',{intentId:'0x'+'1'.repeat(64)+'\n'}));
});
test('cannot fabricate reconciled effect, cancel a submitted transaction, or inject signed bytes',()=>{
 const base=fixture.responses['status.reserved'];
 for(const item of [{...base.item,state:'reconciled'},{...base.item,state:'submitted'},{...base.item,signedBytes:'0x1234'}, {...base.item,nonceRaw:'1'}])assert(!runtime.validateResponse('status',{...base,item}));
 assert(!runtime.validateResponse('status',{...base,executionAvailable:true}));
});
test('keyset list rejects duplicates, bad ordering and unbound continuation',()=>{
 const base=fixture.responses['list.empty'],item=fixture.responses['status.reserved'].item;
 assert(!runtime.validateResponse('list',{...base,items:[item,item]}));
 assert(!runtime.validateResponse('list',{...base,nextAfterIntentId:item.intentId}));
 assert(runtime.validateResponse('list',{...base,items:[item],nextAfterIntentId:item.intentId}));
});
