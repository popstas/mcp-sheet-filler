import type { StorageAdapter } from '../storage/adapter.js';
import type { Field, SaveStatus } from '../types.js';
import { FillerError } from '../types.js';
import { isEmpty, processSaveValues } from '../validation.js';
import {
  getFieldsByNamesSchema,
  addFieldSchema,
  listFieldsSchema,
  getObjectSchema,
  getObjectByNameSchema,
  addObjectByNameSchema,
  saveObjectNoOverwriteSchema,
  getMissingAutoFieldsSchema,
  getNextMissingFieldsObjectSchema,
  useSheetIdSchema,
  googleAuthSchema,
} from './schemas.js';
import {
  requestDeviceCode,
  pollForTokens,
  saveTokens,
  getDefaultTokenPath,
  loadTokens,
} from '../auth/oauth.js';
import { getConfigFromEnv } from '../storage/adapter.js';

type ToolHandler<T, R> = (args: T, adapter: StorageAdapter) => Promise<R>;

function stripInstructions(fields: Field[], include: boolean): Field[] {
  if (include) return fields;
  return fields.map(({ instructions, ...rest }) => rest);
}

export const handlers = {
  filler_get_fields_by_names: (async (args, adapter) => {
    const { names, include_instructions } = getFieldsByNamesSchema.parse(args);
    const fields = await adapter.getFieldsByNames(names);
    return { fields: stripInstructions(fields, include_instructions) };
  }) as ToolHandler<unknown, { fields: Field[] }>,

  filler_add_field: (async (args, adapter) => {
    const { field } = addFieldSchema.parse(args);
    const existing = await adapter.getFieldsByNames([field.name]);
    if (existing.length > 0) {
      throw new FillerError('field_already_exists', `Field "${field.name}" already exists`);
    }
    await adapter.addField(field);
    return { created: true, field };
  }) as ToolHandler<unknown, { created: boolean; field: Field }>,

  filler_list_fields: (async (args, adapter) => {
    const { names, include_instructions } = listFieldsSchema.parse(args);
    const fields = await adapter.listFields(names);
    return { fields: stripInstructions(fields, include_instructions) };
  }) as ToolHandler<unknown, { fields: Field[] }>,

  filler_get_object: (async (args, adapter) => {
    const { id } = getObjectSchema.parse(args);
    const obj = await adapter.getObjectByName(id);
    return { found: obj !== null, object: obj ?? undefined };
  }) as ToolHandler<unknown, { found: boolean; object?: { name: string; values: Record<string, string> } }>,

  filler_get_object_by_name: (async (args, adapter) => {
    const { name } = getObjectByNameSchema.parse(args);
    const obj = await adapter.getObjectByName(name);
    return { found: obj !== null, object: obj ?? undefined };
  }) as ToolHandler<unknown, { found: boolean; object?: { name: string; values: Record<string, string> } }>,

  filler_add_object_by_name: (async (args, adapter) => {
    const { name } = addObjectByNameSchema.parse(args);
    const existing = await adapter.getObjectByName(name);
    if (existing) {
      throw new FillerError('object_already_exists', `Object "${name}" already exists`);
    }
    await adapter.addObjectByName(name);
    return { created: true, object: { name } };
  }) as ToolHandler<unknown, { created: boolean; object: { name: string } }>,

  filler_save_object_no_overwrite: (async (args, adapter) => {
    const parsed = saveObjectNoOverwriteSchema.parse(args);
    const name = parsed.name;
    const values = parsed.values as Record<string, string>;

    const obj = await adapter.getObjectByName(name);
    if (!obj) {
      throw new FillerError('object_not_found', `Object "${name}" not found`);
    }

    const fieldNames = await adapter.getFieldNames();
    const knownFieldNames = new Set(fieldNames);
    const fields = await adapter.listFields();

    const { result, valuesToSave } = processSaveValues(
      values,
      obj.values,
      fields,
      knownFieldNames
    );

    if (Object.keys(valuesToSave).length > 0) {
      await adapter.updateObjectFields(name, valuesToSave);
    }

    return { result };
  }) as ToolHandler<unknown, { result: Record<string, SaveStatus> }>,

  filler_get_missing_auto_fields: (async (args, adapter) => {
    const { name, include_field_meta } = getMissingAutoFieldsSchema.parse(args);

    const obj = await adapter.getObjectByName(name);
    if (!obj) {
      throw new FillerError('object_not_found', `Object "${name}" not found`);
    }

    const fields = await adapter.listFields();
    const autoFields = fields.filter((f) => f.auto === true);

    const missing = autoFields
      .filter((f) => isEmpty(obj.values[f.name]))
      .map((f) => {
        if (include_field_meta) {
          return {
            name: f.name,
            type: f.type,
            example: f.example,
            instructions: f.instructions,
          };
        }
        return { name: f.name };
      });

    return { missing };
  }) as ToolHandler<
    unknown,
    { missing: Array<{ name: string; type?: string; example?: string; instructions?: string }> }
  >,

  filler_get_next_missing_fields_object: (async (args, adapter) => {
    const { include_field_meta } = getNextMissingFieldsObjectSchema.parse(args);

    const fields = await adapter.listFields();
    const autoFields = fields.filter((f) => f.auto === true);

    if (autoFields.length === 0) {
      return { found: false };
    }

    const objects = await adapter.listObjects();

    for (const obj of objects) {
      const missingFields = autoFields.filter((f) => isEmpty(obj.values[f.name]));

      if (missingFields.length > 0) {
        const missing = missingFields.map((f) => {
          if (include_field_meta) {
            return {
              name: f.name,
              type: f.type,
              example: f.example,
              instructions: f.instructions,
            };
          }
          return { name: f.name };
        });

        return {
          found: true,
          object: obj,
          missing,
        };
      }
    }

    return { found: false };
  }) as ToolHandler<
    unknown,
    {
      found: boolean;
      object?: { name: string; values: Record<string, string> };
      missing?: Array<{ name: string; type?: string; example?: string; instructions?: string }>;
    }
  >,

  filler_use_sheet_id: (async (args, adapter) => {
    const { sheet_id } = useSheetIdSchema.parse(args);

    if (!adapter.setSheetId) {
      throw new FillerError(
        'backend_not_configured',
        'filler_use_sheet_id is only available with the sheets backend'
      );
    }

    adapter.setSheetId(sheet_id);

    return {
      success: true,
      sheet_id: adapter.getSheetId!(),
    };
  }) as ToolHandler<unknown, { success: boolean; sheet_id: string }>,

  filler_google_auth: (async (args, adapter) => {
    const { action, device_code } = googleAuthSchema.parse(args);
    const config = getConfigFromEnv();

    if (action === 'status') {
      // Check if tokens exist
      const tokenPath = config.googleOAuthTokenPath || getDefaultTokenPath();
      const tokens = loadTokens(tokenPath);

      if (tokens && tokens.access_token) {
        return { status: 'Authenticated to Google Sheets' };
      }

      // Check if using service account
      if (config.googleServiceAccountKey) {
        return { status: 'Authenticated to Google Sheets (service account)' };
      }

      return { status: 'Not authenticated. Use start_auth to begin authentication.' };
    }

    if (action === 'start_auth') {
      if (!config.googleOAuthClientId) {
        throw new FillerError(
          'backend_not_configured',
          'GOOGLE_OAUTH_CLIENT_ID environment variable is required for OAuth authentication'
        );
      }

      const deviceCodeResponse = await requestDeviceCode(config.googleOAuthClientId);

      return {
        verification_url: deviceCodeResponse.verification_url,
        user_code: deviceCodeResponse.user_code,
        device_code: deviceCodeResponse.device_code,
        expires_in: deviceCodeResponse.expires_in,
        instructions: `Visit ${deviceCodeResponse.verification_url} and enter code: ${deviceCodeResponse.user_code}`,
      };
    }

    // action === 'complete_auth'
    if (!device_code) {
      throw new FillerError(
        'invalid_argument',
        'device_code is required for complete_auth action'
      );
    }

    if (!config.googleOAuthClientId || !config.googleOAuthClientSecret) {
      throw new FillerError(
        'backend_not_configured',
        'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables are required'
      );
    }

    const tokens = await pollForTokens(
      config.googleOAuthClientId,
      config.googleOAuthClientSecret,
      device_code
    );

    // Save tokens to file
    const tokenPath = config.googleOAuthTokenPath || getDefaultTokenPath();
    saveTokens(tokens, tokenPath);

    // Update the adapter with new tokens if available
    if (adapter.setOAuthTokens) {
      adapter.setOAuthTokens(tokens);
    }

    return { status: 'Authenticated to Google Sheets' };
  }) as ToolHandler<
    unknown,
    | { status: string }
    | { verification_url: string; user_code: string; device_code: string; expires_in: number; instructions: string }
  >,
};

export type ToolName = keyof typeof handlers;
