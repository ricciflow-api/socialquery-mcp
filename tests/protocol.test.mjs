import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { SocialQueryClient } from '../src/client.mjs';

const expected=['list_platforms','list_endpoints','get_endpoint','call_endpoint','execute_endpoint','get_credit_balance','get_credit_transactions','get_service_status'];
test('real stdio process initializes and lists all tools without a credential',async()=>{
  const client=new Client({name:'protocol-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:['bin/socialquery-mcp.mjs'],env:{PATH:process.env.PATH??'',SOCIALQUERY_API_KEY:''},stderr:'pipe'});
  try{
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),expected);
    const result=await client.callTool({name:'get_credit_balance',arguments:{}});
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/SOCIALQUERY_API_KEY/);
  }finally{await client.close();}
});

test('MCP discovery filters and paginates; data results preserve envelope and invalid budget makes no paid request',async()=>{
  const endpoints=Array.from({length:4},(_,i)=>({id:`get_test_${i}`,title:`Test ${i}`,description:'test',method:'GET',path:`/v1/test/item${i}`,platformSlug:'test',creditCost:1,launchStatus:'beta',params:[]}));
  let paid=0;
  const api=new SocialQueryClient({apiKey:'test',fetchImpl:async url=>{
    if(url.pathname==='/v1/meta/endpoints')return Response.json({success:true,data:{endpoints}});
    paid++;return Response.json({success:true,data:{items:[{text:'untrusted source'}]},credits_used:1,request_id:'req_test'});
  }});
  const server=createServer(api);
  const client=new Client({name:'protocol-test',version:'1.0.0'});
  const [left,right]=InMemoryTransport.createLinkedPair();
  await server.connect(left);await client.connect(right);
  try{
    const listing=await client.callTool({name:'list_endpoints',arguments:{platform:'test',limit:2}});
    assert.equal(listing.structuredContent.result.endpoints.length,2);
    assert.equal(listing.structuredContent.result.nextOffset,2);
    const denied=await client.callTool({name:'call_endpoint',arguments:{endpointId:'get_test_0',maxCredits:0}});
    assert.equal(denied.isError,true);assert.equal(paid,0);
    const result=await client.callTool({name:'call_endpoint',arguments:{endpointId:'get_test_0',maxCredits:1}});
    assert.equal(result.structuredContent.result.request_id,'req_test');assert.equal(paid,1);
    const invalid=await client.callTool({name:'list_endpoints',arguments:{limit:51}});
    assert.equal(invalid.isError,true);
  }finally{await client.close();await server.close();}
});

test('MCP mutations are explicitly annotated and preserve typed body through the SDK',async()=>{
  const endpoint={id:'post_web_batch_scrape',title:'Batch',description:'Batch scrape',method:'POST',path:'/v1/web/batch-scrape',platformSlug:'web',creditCost:1,params:[{name:'urls',required:true}]};
  let mutations=0;
  const api=new SocialQueryClient({apiKey:'test',fetchImpl:async(url,options)=>{
    if(url.pathname==='/v1/meta/endpoints')return Response.json({success:true,data:{endpoints:[endpoint]}});
    mutations++;assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{urls:['https://example.com']});
    assert.equal(options.headers['Idempotency-Key'],'batch-action-123');
    return Response.json({success:true,data:{id:'job_test'},credits_used:1});
  }});
  const server=createServer(api),client=new Client({name:'mutation-test',version:'1'});
  const[left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);
  try {
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(t=>t.name==='call_endpoint').annotations.readOnlyHint,true);
    assert.equal(tools.find(t=>t.name==='execute_endpoint').annotations.readOnlyHint,false);
    assert.equal(tools.find(t=>t.name==='execute_endpoint').annotations.destructiveHint,true);
    const args={endpointId:endpoint.id,parameters:{urls:['https://example.com']},maxCredits:1};
    assert.equal((await client.callTool({name:'call_endpoint',arguments:args})).isError,true);
    assert.equal((await client.callTool({name:'execute_endpoint',arguments:args})).isError,true);
    assert.equal(mutations,0);
    const r=await client.callTool({name:'execute_endpoint',arguments:{...args,idempotencyKey:'batch-action-123'}});
    assert.equal(r.structuredContent.result.data.id,'job_test');assert.equal(mutations,1);
  } finally {await client.close();await server.close();}
});


test('Credit receipt tool makes one private free read with exact cursor and filter',async()=>{
 let calls=0;
 const api=new SocialQueryClient({apiKey:'test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url.pathname,'/v1/credits/transactions');assert.equal(url.searchParams.get('limit'),'2');assert.equal(url.searchParams.get('request_id'),'req_test');assert.equal(url.searchParams.get('cursor'),'opaque_cursor');assert.equal(options.headers['X-Max-Credits'],'0');
  return Response.json({success:true,data:{items:[],next_cursor:null},credits_used:0,request_id:'req_receipt'});
 }});
 const server=createServer(api),client=new Client({name:'receipt-test',version:'1'});
 const[left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);
 try{const r=await client.callTool({name:'get_credit_transactions',arguments:{limit:2,cursor:'opaque_cursor',requestId:'req_test'}});assert.notEqual(r.isError,true);assert.equal(r.structuredContent.result.request_id,'req_receipt');assert.equal(calls,1);}finally{await client.close();await server.close();}
});


test('Credit receipt tool omits absent optional filters before encoding',async()=>{
 const api=new SocialQueryClient({apiKey:'test',fetchImpl:async(url)=>{
  assert.deepEqual([...url.searchParams.entries()],[['limit','50']]);
  return Response.json({success:true,data:{items:[],next_cursor:null},credits_used:0});
 }});
 const server=createServer(api),client=new Client({name:'default-receipts',version:'1'});
 const[left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);
 try{const r=await client.callTool({name:'get_credit_transactions',arguments:{}});assert.notEqual(r.isError,true,r.content[0].text);}finally{await client.close();await server.close();}
});


test('Service status is an explicit public zero-credit read without forwarding a key',async()=>{
 const api=new SocialQueryClient({apiKey:'must-not-send',fetchImpl:async(url,init)=>{
  assert.equal(url.pathname,'/v1/meta/status');assert.equal(init.headers['x-api-key'],undefined);assert.equal(init.headers['X-Max-Credits'],'0');
  return Response.json({success:true,data:{status:'degraded'},credits_used:0});
 }});
 const server=createServer(api),client=new Client({name:'public-status-test',version:'1'}),[left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);
 try{const r=await client.callTool({name:'get_service_status',arguments:{}});assert.notEqual(r.isError,true);assert.equal(r.structuredContent.result.data.status,'degraded');}finally{await client.close();await server.close();}
});
