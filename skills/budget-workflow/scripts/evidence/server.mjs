#!/usr/bin/env node
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EvidenceBroker } from './broker.mjs';
import { evidenceSchemas } from './schemas.mjs';

const broker = new EvidenceBroker(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
const server = new McpServer({ name: 'research-evidence', version: '1.0.0' });
const response = async action => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await action()) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'blocked', reason: error.message }) }] }; }
};
const schemas = evidenceSchemas(broker.config.mode);

server.registerTool('evidence_find', {
  description: 'Find source handles. Repository searches use literal terms and return matching complete syntax units. External discovery uses approved query IDs or "seeds"; never send private code as web query text.',
  inputSchema: schemas.find,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, data => response(() => broker.find(data)));

server.registerTool('evidence_open', {
  description: 'Open a source ID or a known repository-relative path, optionally a named symbol. Read small files whole; use units for larger files. Expand only when necessary. External focus is local filtering, never an outbound query.',
  inputSchema: schemas.open,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, data => response(() => broker.open(data)));

if (broker.config.mode === 'hybrid') {
  server.registerTool('evidence_contract', {
    description: 'After inspecting repository evidence, record local constraints and the remaining external gaps. Required before hybrid web discovery. This records applicability context, not permission to mutate or a proof of correctness.',
    inputSchema: { sourceIds: z.array(z.string().max(80)).min(1).max(8),
      constraints: z.array(z.string().max(300)).max(8), gaps: z.array(z.string().max(240)).min(1).max(6) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, data => response(() => broker.contract(data)));
}
await server.connect(new StdioServerTransport());
