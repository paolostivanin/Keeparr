#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KeeparrClient, loadKeeparrConfig } from './keeparr-client.mjs';
import { createKeeparrMcpServer } from './server.mjs';

async function main() {
  const client = new KeeparrClient(loadKeeparrConfig());
  const server = createKeeparrMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(`Keeparr MCP failed to start: ${error instanceof Error ? error.message : 'Unknown error.'}`);
  process.exitCode = 1;
});
