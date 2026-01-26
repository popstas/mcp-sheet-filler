import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { getConfigFromEnv, type StorageAdapter } from './storage/adapter.js';

/** Keys to redact from tool args when logging to avoid leaking secrets. */
const REDACT_KEYS = ['device_code'];

function redactArgsForLog(args: unknown): unknown {
  if (args === null || typeof args !== 'object') return args;
  const obj = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACT_KEYS.includes(k) ? '[REDACTED]' : v;
  }
  return out;
}
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
  initSheetSchema,
} from './tools/schemas.js';

/** MCP tool annotations: hints about tool behavior for clients (see https://modelcontextprotocol.io/docs/concepts/tools) */
type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type ToolDefinition = {
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
};

const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  filler_add_field: {
    description: 'Add a new field to the schema',
    inputSchema: addFieldSchema,
    annotations: {
      title: 'Add Field',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  filler_list_fields: {
    description: 'List all fields or a subset by names',
    inputSchema: listFieldsSchema,
    annotations: {
      title: 'List Fields',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  filler_get_object_by_name: {
    description: 'Get an object by its name (key field)',
    inputSchema: getObjectByNameSchema,
    annotations: {
      title: 'Get Object by Name',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  filler_add_object_by_name: {
    description: 'Create a new object with the given name',
    inputSchema: addObjectByNameSchema,
    annotations: {
      title: 'Add Object by Name',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  filler_save_object_no_overwrite: {
    description: 'Save field values without overwriting existing non-empty values',
    inputSchema: saveObjectNoOverwriteSchema,
    annotations: {
      title: 'Save Object (No Overwrite)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  filler_get_next_missing_fields_object: {
    description: 'Get the first object that has missing auto-fill fields',
    inputSchema: getNextMissingFieldsObjectSchema,
    annotations: {
      title: 'Get Next Object with Missing Fields',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  filler_use_sheet_id: {
    description: 'Switch to a different Google Sheet by ID or URL (sheets backend only)',
    inputSchema: useSheetIdSchema,
    annotations: {
      title: 'Use Sheet ID',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  filler_google_auth: {
    description: 'Authenticate to Google Sheets using device code flow. Actions: status (check auth), start_auth (get verification URL/code), complete_auth (finish auth with device_code)',
    inputSchema: googleAuthSchema,
    annotations: {
      title: 'Google Authentication',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  filler_init: {
    description: 'Initialize the current spreadsheet by creating data and fields tabs with headers',
    inputSchema: initSheetSchema,
    annotations: {
      title: 'Initialize Sheet',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
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
        annotations: def.annotations,
      },
      async (args) => {
        logger.info(`tool_call: ${toolName}`, { args: redactArgsForLog(args) });
        try {
          const result = await handler(args as Record<string, unknown>, adapter);
          logger.debug(`tool_result: ${toolName}`, { result });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          if (error instanceof FillerError) {
            logger.error(`tool_error: ${toolName}`, { error: error.toJSON(), args: redactArgsForLog(args) });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: error.toJSON() }) }],
              isError: true,
            };
          }
          logger.error(`tool_unexpected_error: ${toolName}`, {
            error: error instanceof Error ? error.message : String(error),
            args: redactArgsForLog(args),
          });
          throw error;
        }
      }
    );
  }

  return server;
}
