import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './server.mjs';
import { SocialQueryClient } from './client.mjs';

const browserOrigins = new Set(['https://socialquery.dev', 'https://www.socialquery.dev', 'https://socialquery-mcp.vercel.app', 'https://claude.ai', 'https://chatgpt.com']);

// Every HTTP request gets a separate client and transport. Never use a shared
// server or an environment API key for remote callers.
export function createHttpHandler({ fetchImpl = globalThis.fetch } = {}) {
  return async function handle(request) {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
    const fail = (status, message, code = -32600) => Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status, headers });
    const origin = request.headers.get('origin');
    if (origin && !browserOrigins.has(origin)) return fail(403, 'Origin is not allowed.');
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, Accept, MCP-Protocol-Version, MCP-Session-Id');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') {
      headers.set('Allow', 'POST, OPTIONS');
      return fail(405, 'Use Streamable HTTP POST. This stateless server does not provide a persistent SSE session.', -32601);
    }
    const authorization = request.headers.get('authorization');
    const bearer = authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    const keyHeader = request.headers.get('x-api-key');
    if ((authorization && !bearer) || (keyHeader && !/^[^\s,]+$/.test(keyHeader)) || (bearer && keyHeader && bearer !== keyHeader)) {
      return fail(401, 'Supply one SocialQuery API key using Authorization: Bearer or X-API-Key.', -32001);
    }
    const apiKey = bearer ?? keyHeader ?? '';
    if (apiKey.length > 512) return fail(401, 'Invalid API key format.', -32001);
    const server = createServer(new SocialQueryClient({ apiKey, fetchImpl }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 64 * 1024 });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // JSON mode buffers the completed result before transport cleanup.
      const body = await response.arrayBuffer();
      for (const [name, value] of response.headers) headers.set(name, value);
      return new Response(body.byteLength ? body : null, { status: response.status, headers });
    } catch {
      return fail(500, 'Unable to complete the MCP request.', -32603);
    } finally {
      await server.close();
    }
  };
}

export const handleHttpRequest = createHttpHandler();
