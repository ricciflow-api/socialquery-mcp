import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpHandler } from '../src/http.mjs';

const url = 'https://socialquery-mcp.vercel.app/mcp';
const rpcHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
async function connect(handler, headers = {}) {
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => handler(new Request(input, init)), requestInit: { headers },
  }));
  return client;
}

test('HTTP SDK handshake and tools work without sessions; concurrent callers keep separate keys', async () => {
  const calls = [];
  const handler = createHttpHandler({ fetchImpl: async (input, init) => {
    calls.push({ path: input.pathname, key: init.headers['x-api-key'] });
    if (input.pathname === '/v1/meta/platforms') return Response.json({ success: true, data: { platforms: [{ slug: 'test' }] } });
    if (init.headers['x-api-key'] === 'invalid') return Response.json({}, { status: 401 });
    return Response.json({ success: true, data: { user_id: init.headers['x-api-key'], credits_balance: 12 } });
  } });
  const clients = await Promise.all([connect(handler), connect(handler, { Authorization: 'Bearer alice' }), connect(handler, { 'X-API-Key': 'bob' }), connect(handler, { Authorization: 'Bearer invalid' })]);
  try {
    assert.equal((await clients[0].listTools()).tools.length, 7);
    const result = await clients[0].callTool({ name: 'list_platforms', arguments: {} });
    assert.equal(result.structuredContent.result[0].slug, 'test');
    assert.equal(calls[0].key, undefined);
    const balances = await Promise.all(clients.map(client => client.callTool({ name: 'get_credit_balance', arguments: {} })));
    assert.equal(balances[0].isError, true);
    assert.equal(balances[1].structuredContent.result.data.user_id, 'alice');
    assert.equal(balances[2].structuredContent.result.data.user_id, 'bob');
    assert.equal(balances[3].isError, true);
    assert.match(balances[3].content[0].text, /HTTP 401/);
    assert.equal(calls.length, 4);
  } finally { await Promise.all(clients.map(client => client.close())); }
});

test('HTTP guards reject bad origins, methods, malformed credentials and oversized requests', async () => {
  const handler = createHttpHandler({ fetchImpl: () => { throw new Error('Unexpected upstream request'); } });
  const send = (method, headers = {}, body) => handler(new Request(url, { method, headers: { ...rpcHeaders, ...headers }, body }));
  assert.equal((await send('POST', { Origin: 'https://attacker.example' }, '{}')).status, 403);
  assert.equal((await send('POST', { Origin: 'null' }, '{}')).status, 403);
  for (const method of ['GET', 'DELETE', 'PUT']) assert.equal((await send(method)).status, 405);
  const preflight = await send('OPTIONS', { Origin: 'https://claude.ai' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://claude.ai');
  assert.equal((await send('POST', { Authorization: 'Basic secret' }, '{}')).status, 401);
  assert.equal((await send('POST', { Authorization: 'Bearer a', 'X-API-Key': 'b' }, '{}')).status, 401);
  assert.equal((await send('POST', {}, 'x'.repeat(65537))).status, 413);
  assert.equal((await send('POST', {}, '{')).status, 400);
  const response = await send('POST', {}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
