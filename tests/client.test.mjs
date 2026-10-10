import test from 'node:test';
import assert from 'node:assert/strict';
import { SocialQueryClient } from '../src/client.mjs';

const endpoint = {id:'get_test_search',method:'GET',path:'/v1/test/search',creditCost:2,params:[{name:'query',required:true},{name:'limit'}]};
const fixture = (item=endpoint) => {
  const calls=[];
  const client=new SocialQueryClient({apiKey:'test-only-key',fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return Response.json({success:true,data:url.pathname==='/v1/meta/endpoints'?{endpoints:[item]}:{items:[]}});
  }});
  return {client,calls};
};

test('catalog discovery omits credentials; a data call encodes query and sends one credential header',async()=>{
  const {client,calls}=fixture();
  await client.callEndpoint({endpointId:endpoint.id,parameters:{query:'a & b',limit:10},maxCredits:2,idempotencyKey:'operation-123'});
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.headers['x-api-key'],undefined);
  assert.equal(calls[1].url.origin,'https://socialquery.dev');
  assert.equal(calls[1].url.searchParams.get('query'),'a & b');
  assert.equal(calls[1].options.headers['x-api-key'],'test-only-key');
  assert.equal(calls[1].options.headers['Idempotency-Key'],'operation-123');
  assert.equal(calls[1].options.redirect,'error');
  assert.ok(!calls[1].url.href.includes('test-only-key'));
});

test('budget, required inputs, unknown inputs, and methods prevent data requests',async()=>{
  for(const input of [
    {parameters:{query:'x'},maxCredits:1},
    {parameters:{query:'x'},maxCredits:NaN},
    {parameters:{},maxCredits:2},
    {parameters:{query:'x',unknown:'x'},maxCredits:2},
    {parameters:[],maxCredits:2},
  ]){
    const {client,calls}=fixture();
    await assert.rejects(client.callEndpoint({endpointId:endpoint.id,...input}));
    assert.equal(calls.length,1);
  }
  const {client,calls}=fixture({...endpoint,method:'POST'});
  await assert.rejects(client.callEndpoint({endpointId:endpoint.id,parameters:{query:'x'},maxCredits:2}),/GET/);
  assert.equal(calls.length,1);
});

test('alternative parameters are enforced and path parameters are substituted safely',async()=>{
  const item={...endpoint,path:'/v1/test/{id}',params:[{name:'id',required:true},{name:'url'},{name:'handle'}],oneOfParameters:[['url','handle']]};
  const {client,calls}=fixture(item);
  await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{id:'abc'},maxCredits:2}),/alternative/);
  for(const id of ['..','a/b','%2e%2e'])await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{id,handle:'test'},maxCredits:2}),/Path/);
  await client.callEndpoint({endpointId:item.id,parameters:{id:'abc-123',handle:'test'},maxCredits:2});
  assert.equal(calls.at(-1).url.pathname,'/v1/test/abc-123');
  assert.equal(calls.at(-1).url.searchParams.has('id'),false);
});

test('arbitrary origins and traversal paths fail before fetch',async()=>{
  let calls=0;
  const client=new SocialQueryClient({apiKey:'test',fetchImpl:async()=>{calls++;throw Error('must not fetch');}});
  for(const path of ['https://evil.example','//evil.example','/v1/../admin','/v1/%2e%2e/admin','/api/admin','/v1/test?token=x','/v1/test\\evil'])await assert.rejects(client.get(path),/Unsupported/);
  assert.equal(calls,0);
});

test('errors do not echo private response text or retry',async()=>{
  let calls=0;
  const client=new SocialQueryClient({apiKey:'test-only-key',fetchImpl:async()=>{calls++;return new Response('private secret text',{status:401,headers:{'x-request-id':'req_123'}});}});
  await assert.rejects(client.get('/v1/github/profile'),error=>error.message.includes('HTTP 401')&&error.message.includes('req_123')&&!error.message.includes('secret'));
  assert.equal(calls,1);
});

test('missing keys fail locally; oversized responses are rejected',async()=>{
  const client=new SocialQueryClient({apiKey:'',fetchImpl:()=>{throw Error('unexpected fetch');}});
  await assert.rejects(client.get('/v1/github/profile'),/SOCIALQUERY_API_KEY/);
  const large=new SocialQueryClient({apiKey:'test',fetchImpl:async()=>new Response(' '.repeat(4*1024*1024+1))});
  await assert.rejects(large.get('/v1/github/profile'),/exceeds/);
});
