import { z } from 'zod';

export const addFieldsSchema = z.object({
  fields: z
    .array(
      z.object({
        name: z.string().describe('Unique field name'),
        description: z.string().optional().describe('Field description'),
        auto: z.boolean().optional().describe('Auto-fill flag'),
        instructions: z.string().optional().describe('Instructions for auto-filling'),
        type: z.string().optional().describe('Data type (string, number, date, etc.)'),
        example: z.string().optional().describe('Example value'),
      })
    )
    .min(1)
    .describe('Fields to add'),
});

export const listFieldsSchema = z.object({
  names: z.array(z.string()).optional().describe('Optional list of field names to filter'),
  include_instructions: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include instructions in response'),
});

export const getObjectsByNameSchema = z.object({
  names: z.array(z.string()).min(1).describe('Object names (key field values)'),
  include_field_meta: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include field metadata in response'),
});

export const addObjectsByNameSchema = z.object({
  names: z.array(z.string()).min(1).describe('Names for the new objects'),
});

export const saveObjectsNoOverwriteSchema = z.object({
  objects: z
    .array(
      z.object({
        name: z.string().describe('Object name'),
        values: z.record(z.string(), z.string()).describe('Field values to save'),
      })
    )
    .min(1)
    .describe('Array of objects to save'),
});

export const getNextMissingFieldsObjectsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(1)
    .describe('Maximum number of objects to return'),
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
