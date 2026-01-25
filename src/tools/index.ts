import type { StorageAdapter } from '../storage/adapter.js';
import type { Field, SaveStatus } from '../types.js';
import { FillerError } from '../types.js';
import { isEmpty, processSaveValues } from '../validation.js';
import { logger } from '../logger.js';
import {
  addFieldSchema,
  listFieldsSchema,
  getObjectByNameSchema,
  addObjectByNameSchema,
  saveObjectNoOverwriteSchema,
  getNextMissingFieldsObjectSchema,
  useSheetIdSchema,
  googleAuthSchema,
} from './schemas.js';
import {
  requestDeviceCode,
  pollForTokens,
  saveTokens,
  getUserTokenPath,
  loadTokens,
} from '../auth/oauth.js';
import { getConfigFromEnv } from '../storage/adapter.js';
import { getCurrentUserId } from '../context.js';

type ToolHandler<T, R> = (args: T, adapter: StorageAdapter) => Promise<R>;

function stripInstructions(fields: Field[], include: boolean): Field[] {
  if (include) return fields;
  return fields.map(({ instructions, ...rest }) => rest);
}

export const handlers = {
  filler_add_field: (async (args, adapter) => {
    const { field } = addFieldSchema.parse(args);
    const existing = await adapter.getFieldsByNames([field.name]);
    if (existing.length > 0) {
      throw new FillerError('field_already_exists', `Field "${field.name}" already exists`);
    }
    await adapter.addField(field);
    logger.info('tool_add_field_success', { name: field.name, type: field.type || 'string' });
    return { created: true, field };
  }) as ToolHandler<unknown, { created: boolean; field: Field }>,

  filler_list_fields: (async (args, adapter) => {
    const { names, include_instructions } = listFieldsSchema.parse(args);
    const fields = await adapter.listFields(names);
    return { fields: stripInstructions(fields, include_instructions) };
  }) as ToolHandler<unknown, { fields: Field[] }>,

  filler_get_object_by_name: (async (args, adapter) => {
    const { name, include_field_meta } = getObjectByNameSchema.parse(args);
    const obj = await adapter.getObjectByName(name);

    if (!obj) {
      return { found: false };
    }

    // Get list of missing auto fields
    const fields = await adapter.listFields();
    const autoFields = fields.filter((f) => f.auto === true);
    const missingFields = autoFields.filter((f) => isEmpty(obj.values[f.name]));

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

    return { found: true, object: obj, missing };
  }) as ToolHandler<
    unknown,
    {
      found: boolean;
      object?: { name: string; values: Record<string, string> };
      missing?: Array<{ name: string; type?: string; example?: string; instructions?: string }>;
    }
  >,

  filler_add_object_by_name: (async (args, adapter) => {
    const { name } = addObjectByNameSchema.parse(args);
    const existing = await adapter.getObjectByName(name);
    if (existing) {
      throw new FillerError('object_already_exists', `Object "${name}" already exists`);
    }
    await adapter.addObjectByName(name);
    logger.info('tool_add_object_success', { name });
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

    // Summarize results by status
    const statusCounts: Record<string, number> = {};
    for (const status of Object.values(result)) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    logger.info('tool_save_object_result', { name, statusCounts });

    return { result };
  }) as ToolHandler<unknown, { result: Record<string, SaveStatus> }>,

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
    const resolvedId = adapter.getSheetId!();
    logger.info('tool_use_sheet_id', { input: sheet_id, resolvedId });

    return {
      success: true,
      sheet_id: resolvedId,
    };
  }) as ToolHandler<unknown, { success: boolean; sheet_id: string }>,

  filler_google_auth: (async (args, adapter) => {
    const { action, device_code } = googleAuthSchema.parse(args);
    const config = getConfigFromEnv();
    const userId = getCurrentUserId();
    logger.debug('tool_google_auth', { action, userId });

    if (action === 'status') {
      // Check if tokens exist for this user
      const tokenPath = getUserTokenPath(userId);
      const tokens = loadTokens(tokenPath);

      if (tokens && tokens.access_token) {
        logger.debug('tool_google_auth_status', { userId, authenticated: true, method: 'oauth' });
        return { status: 'Authenticated to Google Sheets', user_id: userId };
      }

      // Check if using service account (shared, not user-specific)
      if (config.googleServiceAccountKey) {
        logger.debug('tool_google_auth_status', { userId, authenticated: true, method: 'service_account' });
        return { status: 'Authenticated to Google Sheets (service account)', user_id: userId };
      }

      logger.debug('tool_google_auth_status', { userId, authenticated: false });
      return { status: 'Not authenticated. Use start_auth to begin authentication.', user_id: userId };
    }

    if (action === 'start_auth') {
      if (!config.googleOAuthClientId) {
        throw new FillerError(
          'backend_not_configured',
          'GOOGLE_OAUTH_CLIENT_ID environment variable is required for OAuth authentication'
        );
      }

      const deviceCodeResponse = await requestDeviceCode(config.googleOAuthClientId);
      logger.info('tool_google_auth_started', { userId, user_code: deviceCodeResponse.user_code, expires_in: deviceCodeResponse.expires_in });

      return {
        verification_url: deviceCodeResponse.verification_url,
        user_code: deviceCodeResponse.user_code,
        device_code: deviceCodeResponse.device_code,
        expires_in: deviceCodeResponse.expires_in,
        instructions: `Visit ${deviceCodeResponse.verification_url} and enter code: ${deviceCodeResponse.user_code}`,
        user_id: userId,
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

    // Save tokens to user-specific file
    const tokenPath = getUserTokenPath(userId);
    saveTokens(tokens, tokenPath);

    // Update the adapter with new tokens for this user
    if (adapter.setOAuthTokens) {
      adapter.setOAuthTokens(tokens);
    }

    logger.info('tool_google_auth_completed', { userId });
    return { status: 'Authenticated to Google Sheets', user_id: userId };
  }) as ToolHandler<
    unknown,
    | { status: string; user_id: string }
    | { verification_url: string; user_code: string; device_code: string; expires_in: number; instructions: string; user_id: string }
  >,
};

export type ToolName = keyof typeof handlers;
