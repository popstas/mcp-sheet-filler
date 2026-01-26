import { z } from 'zod';

export const addFieldSchema = z.object({
  field: z
    .object({
      name: z.string().describe('Unique field name'),
      description: z.string().optional().describe('Field description'),
      auto: z.boolean().optional().describe('Auto-fill flag'),
      instructions: z.string().optional().describe('Instructions for auto-filling'),
      type: z.string().optional().describe('Data type (string, number, date, etc.)'),
      example: z.string().optional().describe('Example value'),
    })
    .describe('Field to add'),
});

export const listFieldsSchema = z.object({
  names: z.array(z.string()).optional().describe('Optional list of field names to filter'),
  include_instructions: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include instructions in response'),
});

export const getObjectByNameSchema = z.object({
  name: z.string().describe('Object name (key field value)'),
  include_field_meta: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include field metadata in response'),
});

export const addObjectByNameSchema = z.object({
  name: z.string().describe('Name for the new object'),
});

export const saveObjectNoOverwriteSchema = z.object({
  name: z.string().describe('Object name'),
  values: z.record(z.string(), z.string()).describe('Field values to save'),
});

export const getNextMissingFieldsObjectSchema = z.object({
  include_field_meta: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include field metadata in response'),
});

export const useSheetIdSchema = z.object({
  sheet_id: z.string().describe('Google Sheets ID or full URL'),
});

export const googleAuthSchema = z.object({
  action: z.enum(['status', 'start_auth', 'complete_auth']).describe('Action to perform'),
  device_code: z
    .string()
    .optional()
    .describe('Device code from start_auth (required for complete_auth action)'),
});

export const initSheetSchema = z.object({});
