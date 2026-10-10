import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({name:'socialquery-live-check',version:'0.1.0'});
const transport = new StdioClientTransport({command:process.execPath,args:['bin/socialquery-mcp.mjs'],env:{PATH:process.env.PATH??'',SOCIALQUERY_API_KEY:''},stderr:'inherit'});
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,5);
  const catalog=await client.callTool({name:'list_endpoints',arguments:{platform:'hackernews'}});
  assert.notEqual(catalog.isError,true);
  assert.ok(catalog.structuredContent.result.endpoints.some(item=>item.id==='get_hackernews_search'));
  const endpoint=await client.callTool({name:'get_endpoint',arguments:{endpointId:'get_github_profile'}});
  assert.equal(endpoint.structuredContent.result.method,'GET');
  const response=await fetch('https://socialquery.dev/v1/github/profile?handle=octocat',{redirect:'error',signal:AbortSignal.timeout(60000)});
  assert.equal(response.status,401);
  await response.body?.cancel();
  console.log('Live stdio initialization, five tools, catalog discovery, and unauthenticated rejection verified. No data credits spent.');
} finally { await client.close(); }
