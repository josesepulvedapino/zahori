import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * MCP smoke test against the real built artifact: spawns `dist/cli.js mcp`
 * exactly the way a coding agent would, over stdio, and speaks the actual
 * protocol. Requires a build (`pnpm build`); CI builds before running e2e.
 */

let client: Client;

beforeAll(async () => {
  if (!existsSync('dist/cli.js')) {
    throw new Error('dist/cli.js not found; run `pnpm build` before the e2e suite');
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/cli.js', 'mcp'],
  });
  client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe('MCP server', () => {
  it('hands every client workflow instructions during the handshake', () => {
    const instructions = client.getInstructions();
    expect(instructions).toContain('zahori_probe');
    expect(instructions).toContain('zahori_test_profile');
    expect(instructions).toContain('DRM');
  });

  it('exposes the six zahori tools with descriptions', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'zahori_get',
      'zahori_list_profiles',
      'zahori_probe',
      'zahori_save_profile',
      'zahori_test_profile',
      'zahori_validate',
    ]);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
    }
  });

  it('answers a tool call end-to-end (zahori_list_profiles)', async () => {
    const res = await client.callTool({ name: 'zahori_list_profiles', arguments: {} });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    expect(content?.type).toBe('text');
    expect(() => JSON.parse(content!.text)).not.toThrow();
  });
});
