import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { SocialQueryClient } from '../src/client.mjs';

const expected=['list_platforms','list_endpoints','get_endpoint','call_endpoint','get_credit_balance'];
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
