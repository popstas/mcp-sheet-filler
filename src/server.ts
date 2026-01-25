import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { getConfigFromEnv, type StorageAdapter } from './storage/adapter.js';
import { FillerError } from './types.js';
import { handlers, type ToolName } from './tools/index.js';
import { logger } from './logger.js';
import {
  addFieldSchema,
  listFieldsSchema,
  getObjectByNameSchema,
  addObjectByNameSchema,
  saveObjectNoOverwriteSchema,
  getNextMissingFieldsObjectSchema,
  useSheetIdSchema,
  googleAuthSchema,
} from './tools/schemas.js';

type ToolDefinition = {
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
};

const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  filler_add_field: {
    description: 'Add a new field to the schema',
    inputSchema: addFieldSchema,
  },
  filler_list_fields: {
    description: 'List all fields or a subset by names',
    inputSchema: listFieldsSchema,
  },
  filler_get_object_by_name: {
    description: 'Get an object by its name (key field)',
    inputSchema: getObjectByNameSchema,
  },
  filler_add_object_by_name: {
    description: 'Create a new object with the given name',
    inputSchema: addObjectByNameSchema,
  },
  filler_save_object_no_overwrite: {
    description: 'Save field values without overwriting existing non-empty values',
    inputSchema: saveObjectNoOverwriteSchema,
  },
  filler_get_next_missing_fields_object: {
    description: 'Get the first object that has missing auto-fill fields',
    inputSchema: getNextMissingFieldsObjectSchema,
  },
  filler_use_sheet_id: {
    description: 'Switch to a different Google Sheet by ID or URL (sheets backend only)',
    inputSchema: useSheetIdSchema,
  },
  filler_google_auth: {
    description: 'Authenticate to Google Sheets using device code flow. Actions: status (check auth), start_auth (get verification URL/code), complete_auth (finish auth with device_code)',
    inputSchema: googleAuthSchema,
  },
};

export async function createAdapter(): Promise<StorageAdapter> {
  const config = getConfigFromEnv();
  logger.info('adapter_config', { objectKeyField: config.objectKeyField });

  const { createSheetsAdapter } = await import('./storage/sheets.js');
  logger.info('adapter_created', { backend: 'sheets', sheetId: config.googleSheetId });
  return createSheetsAdapter(config);
}

export function createServer(adapter: StorageAdapter, excludeTools: string[] = []): McpServer {
  const server = new McpServer({
    name: 'mcp-sheet-filler',
    version: '1.0.0',
  });

  // Register all tools using registerTool with Zod schemas
  for (const [name, handler] of Object.entries(handlers)) {
    const toolName = name as ToolName;

    // Skip excluded tools
    if (excludeTools.includes(toolName)) {
      continue;
    }
    const def = TOOL_DEFINITIONS[toolName];

    server.registerTool(
      toolName,
      {
        description: def.description,
        inputSchema: def.inputSchema,
      },
      async (args) => {
        logger.info(`tool_call: ${toolName}`, { args });
        try {
          const result = await handler(args as Record<string, unknown>, adapter);
          logger.debug(`tool_result: ${toolName}`, { result });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          if (error instanceof FillerError) {
            logger.error(`tool_error: ${toolName}`, { error: error.toJSON(), args });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: error.toJSON() }) }],
              isError: true,
            };
          }
          logger.error(`tool_unexpected_error: ${toolName}`, {
            error: error instanceof Error ? error.message : String(error),
            args,
          });
          throw error;
        }
      }
    );
  }

  return server;
}
