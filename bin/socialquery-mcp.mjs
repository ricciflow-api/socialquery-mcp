#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.mjs';

const server = createServer();
try {
  await server.connect(new StdioServerTransport());
} catch {
  console.error('SocialQuery MCP failed to start. Requires Node.js 20 or later.');
  process.exitCode = 1;
}
