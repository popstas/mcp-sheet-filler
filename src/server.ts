import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
    description: 'Initialize the current spreadsheet by creating a fields tab populated from the first tab\'s column headers',
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

const INSTRUCTIONS_TEXT = `# Sheet Filler — Usage Instructions

## Setup

1. Open or create a Google Sheet with data rows (objects) and column headers (fields).
2. Share the sheet with the service account or authenticate via OAuth.
3. Call \`filler_init\` to create a "fields" tab from the first tab's column headers.
4. Edit the "fields" tab to set \`auto=TRUE\` for columns the AI should fill, and add \`instructions\` describing how to determine each value.

## Workflow

1. Call \`filler_get_next_missing_fields_object\` to get the first object with empty auto-fill fields.
2. Read the field instructions for missing fields.
3. Research or compute the values following those instructions.
4. Call \`filler_save_object_no_overwrite\` to save values (existing non-empty values are never overwritten).
5. Repeat from step 1 until no more objects need filling.

## Available Tools

| Tool | Description |
|------|-------------|
| \`filler_init\` | Create fields tab and populate from first tab's column headers |
| \`filler_add_field\` | Add a new field to the schema |
| \`filler_list_fields\` | List all or a subset of fields |
| \`filler_get_object_by_name\` | Get an object by its name (key field) |
| \`filler_add_object_by_name\` | Create a new object with just the key |
| \`filler_save_object_no_overwrite\` | Save values without overwriting non-empty fields |
| \`filler_get_next_missing_fields_object\` | Get first object with missing auto-fill fields |
| \`filler_get_missing_auto_fields\` | Get empty auto-fill fields for a specific object |
| \`filler_use_sheet_id\` | Switch to a different Google Sheet |
| \`filler_google_auth\` | Authenticate via device code flow |

## Field Properties

Each field has: \`name\` (unique identifier), \`description\`, \`type\` (string, number, date, datetime, url, email, json, or enum:val1|val2|val3), \`auto\` (boolean — whether the AI should fill this field), \`instructions\` (how to determine the value), and \`example\`.

## Save Statuses

When saving values, each field returns one of:
- \`saved\` — value was written successfully
- \`skipped_already_set\` — field already had a non-empty value (not overwritten)
- \`rejected_unknown_field\` — field name not found in schema
- \`rejected_invalid_type\` — value does not match the field's type
`;

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

  // Register instructions resource
  server.registerResource(
    'instructions',
    'filler://instructions',
    {
      title: 'Sheet Filler Instructions',
      description: 'Usage instructions for the sheet-filler MCP server: setup, workflow, available tools, field properties, and save statuses.',
      mimeType: 'text/plain',
    },
    async () => ({
      contents: [{ uri: 'filler://instructions', text: INSTRUCTIONS_TEXT }],
    })
  );

  // Register fill-sheet prompt
  server.registerPrompt(
    'fill-sheet',
    {
      title: 'Fill Sheet',
      description: 'Guide the LLM through the sheet-filling workflow. Optionally specify an object name to fill a specific object.',
      argsSchema: {
        object_name: z.string().optional().describe('Name of a specific object to fill. If omitted, the next object with missing auto-fill fields is used.'),
      },
    },
    async ({ object_name }) => {
      const startStep = object_name
        ? `First, call \`filler_get_object_by_name\` with name "${object_name}" to retrieve the object and its missing auto-fill fields.`
        : `First, call \`filler_get_next_missing_fields_object\` to get the next object that has empty auto-fill fields.`;

      const text = `You are a sheet-filling assistant. Your job is to fill in missing values for objects in a Google Sheet.

${startStep}

Then follow this loop:
1. Look at the missing auto-fill fields and their instructions.
2. For each missing field, research or compute the correct value following the field's instructions.
3. Call \`filler_save_object_no_overwrite\` with the object name and a map of field names to values.
4. If there are more objects to fill, call \`filler_get_next_missing_fields_object\` and repeat from step 1.
5. When no more objects have missing fields, report that all objects are filled.

Important:
- Always follow the field's \`instructions\` to determine the correct value.
- Respect field types (string, number, date, url, email, etc.).
- The save tool will never overwrite existing non-empty values, so you can safely attempt to save all computed values.`;

      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text },
          },
        ],
      };
    }
  );

  return server;
}
