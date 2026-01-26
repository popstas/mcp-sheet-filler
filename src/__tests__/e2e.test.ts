import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Skip e2e tests if Google Sheets credentials are not available
const hasGoogleCredentials =
  process.env.GOOGLE_SHEET_ID &&
  (process.env.GOOGLE_SERVICE_ACCOUNT_KEY ||
    (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET));

describe.skipIf(!hasGoogleCredentials)('E2E: MCP Server', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/index.ts'],
      env: {
        ...process.env,
        STORAGE_BACKEND: 'sheets',
        OBJECT_KEY_FIELD: 'name',
      },
      stderr: 'pipe',
    });

    client = new Client({
      name: 'test-client',
      version: '1.0.0',
    });

    await client.connect(transport);
  });

  afterAll(async () => {
    await transport.close();
  });

  describe('tools/list', () => {
    it('returns all expected tools', async () => {
      const result = await client.listTools();

      const toolNames = result.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'filler_add_field',
        'filler_add_object_by_name',
        'filler_get_fields_by_names',
        'filler_get_missing_auto_fields',
        'filler_get_next_missing_fields_object',
        'filler_get_object',
        'filler_get_object_by_name',
        'filler_google_auth',
        'filler_init',
        'filler_list_fields',
        'filler_save_object_no_overwrite',
        'filler_use_sheet_id',
      ]);
    });

    it('each tool has valid inputSchema with type=object', async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('filler_get_fields_by_names has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_get_fields_by_names');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Get field metadata by list of names');
      expect(tool!.inputSchema.properties).toHaveProperty('names');
      expect(tool!.inputSchema.properties).toHaveProperty('include_instructions');
      expect(tool!.inputSchema.required).toContain('names');
    });

    it('filler_add_field has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_add_field');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Add a new field to the schema');
      expect(tool!.inputSchema.properties).toHaveProperty('field');
      expect(tool!.inputSchema.required).toContain('field');
    });

    it('filler_list_fields has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_list_fields');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('List all fields or a subset by names');
      expect(tool!.inputSchema.properties).toHaveProperty('names');
      expect(tool!.inputSchema.properties).toHaveProperty('include_instructions');
    });

    it('filler_get_object has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_get_object');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Get an object by its identifier');
      expect(tool!.inputSchema.properties).toHaveProperty('id');
      expect(tool!.inputSchema.required).toContain('id');
    });

    it('filler_get_object_by_name has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_get_object_by_name');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Get an object by its name (key field)');
      expect(tool!.inputSchema.properties).toHaveProperty('name');
      expect(tool!.inputSchema.required).toContain('name');
    });

    it('filler_add_object_by_name has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_add_object_by_name');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Create a new object with the given name');
      expect(tool!.inputSchema.properties).toHaveProperty('name');
      expect(tool!.inputSchema.required).toContain('name');
    });

    it('filler_save_object_no_overwrite has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_save_object_no_overwrite');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe(
        'Save field values without overwriting existing non-empty values'
      );
      expect(tool!.inputSchema.properties).toHaveProperty('name');
      expect(tool!.inputSchema.properties).toHaveProperty('values');
      expect(tool!.inputSchema.required).toContain('name');
      expect(tool!.inputSchema.required).toContain('values');
    });

    it('filler_get_missing_auto_fields has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_get_missing_auto_fields');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Get list of auto-fill fields that are empty for an object');
      expect(tool!.inputSchema.properties).toHaveProperty('name');
      expect(tool!.inputSchema.properties).toHaveProperty('include_field_meta');
      expect(tool!.inputSchema.required).toContain('name');
    });

    it('filler_get_next_missing_fields_object has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_get_next_missing_fields_object');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Get the first object that has missing auto-fill fields');
      expect(tool!.inputSchema.properties).toHaveProperty('include_field_meta');
    });

    it('filler_use_sheet_id has correct schema', async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === 'filler_use_sheet_id');

      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Switch to a different Google Sheet by ID or URL (sheets backend only)');
      expect(tool!.inputSchema.properties).toHaveProperty('sheet_id');
      expect(tool!.inputSchema.required).toContain('sheet_id');
    });
  });
});
