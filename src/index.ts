#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getConfigFromEnv, type StorageAdapter } from './storage/adapter.js';
import { FillerError } from './types.js';
import { handlers, type ToolName } from './tools/index.js';

const TOOL_DEFINITIONS: Record<ToolName, { description: string; inputSchema: Record<string, unknown> }> = {
  filler_get_fields_by_names: {
    description: 'Get field metadata by list of names',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'List of field names to retrieve' },
        include_instructions: { type: 'boolean', description: 'Include instructions in response' },
      },
      required: ['names'],
    },
  },
  filler_add_field: {
    description: 'Add a new field to the schema',
    inputSchema: {
      type: 'object',
      properties: {
        field: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique field name' },
            description: { type: 'string', description: 'Field description' },
            auto: { type: 'boolean', description: 'Auto-fill flag' },
            instructions: { type: 'string', description: 'Instructions for auto-filling' },
            type: { type: 'string', description: 'Data type (string, number, date, etc.)' },
            example: { type: 'string', description: 'Example value' },
          },
          required: ['name'],
        },
      },
      required: ['field'],
    },
  },
  filler_list_fields: {
    description: 'List all fields or a subset by names',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Optional list of field names to filter' },
        include_instructions: { type: 'boolean', description: 'Include instructions in response' },
      },
    },
  },
  filler_get_object: {
    description: 'Get an object by its identifier',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Object identifier (key field value)' },
      },
      required: ['id'],
    },
  },
  filler_get_object_by_name: {
    description: 'Get an object by its name (key field)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Object name (key field value)' },
      },
      required: ['name'],
    },
  },
  filler_add_object_by_name: {
    description: 'Create a new object with the given name',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the new object' },
      },
      required: ['name'],
    },
  },
  filler_save_object_no_overwrite: {
    description: 'Save field values without overwriting existing non-empty values',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Object name' },
        values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Field values to save' },
      },
      required: ['name', 'values'],
    },
  },
  filler_get_missing_auto_fields: {
    description: 'Get list of auto-fill fields that are empty for an object',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Object name' },
        include_field_meta: { type: 'boolean', description: 'Include field metadata in response' },
      },
      required: ['name'],
    },
  },
};

async function createAdapter(): Promise<StorageAdapter> {
  const config = getConfigFromEnv();

  if (config.backend === 'sqlite') {
    const { createSqliteAdapter } = await import('./storage/sqlite.js');
    return createSqliteAdapter(config.sqlitePath!, config.objectKeyField);
  } else if (config.backend === 'sheets') {
    const { createSheetsAdapter } = await import('./storage/sheets.js');
    return createSheetsAdapter(config);
  }

  throw new FillerError('backend_not_configured', `Unknown backend: ${config.backend}`);
}

async function main() {
  const adapter = await createAdapter();

  const server = new McpServer({
    name: 'mcp-sheet-filler',
    version: '1.0.0',
  });

  // Register all tools
  for (const [name, handler] of Object.entries(handlers)) {
    const toolName = name as ToolName;
    const def = TOOL_DEFINITIONS[toolName];

    server.tool(
      toolName,
      def.description,
      def.inputSchema,
      async (args: Record<string, unknown>) => {
        try {
          const result = await handler(args, adapter);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          if (error instanceof FillerError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: error.toJSON() }) }],
              isError: true,
            };
          }
          throw error;
        }
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('mcp-sheet-filler server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
