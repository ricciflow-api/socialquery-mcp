import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = new URL(process.env.MCP_TEST_URL ?? 'https://socialquery-mcp.vercel.app/mcp');
if (endpoint.protocol !== 'https:') throw new Error('Use an HTTPS test endpoint.');
async function connect(headers = {}) {
  const client = new Client({ name: 'socialquery-live-http-check', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers, redirect: 'error' } }));
  return client;
}
const client = await connect();
try {
  assert.equal((await client.listTools()).tools.length, 5);
  const listing = await client.callTool({ name: 'list_endpoints', arguments: { platform: 'hackernews', limit: 2 } });
  assert.equal(listing.isError, undefined);
  assert.ok(listing.structuredContent.result.endpoints.length > 0);
  const detail = await client.callTool({ name: 'get_endpoint', arguments: { endpointId: 'get_github_profile' } });
  assert.equal(detail.structuredContent.result.platformSlug, 'github');
  const noKey = await client.callTool({ name: 'get_credit_balance', arguments: {} });
  assert.equal(noKey.isError, true);
  console.log('PASS: HTTP initialization, five tools, live catalog, endpoint details, missing-key rejection.');
} finally { await client.close(); }
const invalid = await connect({ Authorization: 'Bearer invalid-socialquery-live-check' });
try {
  const denied = await invalid.callTool({ name: 'get_credit_balance', arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /HTTP 401/);
  console.log('PASS: invalid credential rejected by the live API.');
} finally { await invalid.close(); }
for (const method of ['GET', 'DELETE']) assert.equal((await fetch(endpoint, { method })).status, 405);
assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: '{}' })).status, 403);
console.log('PASS: method and origin guards. No data credits spent.');
