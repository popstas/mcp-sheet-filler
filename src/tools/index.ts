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
  saveObjectsNoOverwriteSchema,
  getNextMissingFieldsObjectSchema,
  getNextMissingFieldsObjectsSchema,
  useSheetIdSchema,
  googleAuthSchema,
  initSheetSchema,
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

    // Use batch operation if available, otherwise fall back to separate calls
    let obj: { name: string; values: Record<string, string> } | null;
    let fields: Field[];

    if (adapter.getObjectByNameAndFields) {
      const result = await adapter.getObjectByNameAndFields(name);
      obj = result.object;
      fields = result.fields;
    } else {
      obj = await adapter.getObjectByName(name);
      fields = await adapter.listFields();
    }

    if (!obj) {
      return { found: false };
    }

    // Get list of missing auto fields
    const autoFields = fields.filter((f) => f.auto === true);
    const missingFields = autoFields.filter((f) => isEmpty(obj!.values[f.name]));

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

    // Get fields once and reuse - eliminates duplicate getFieldNames() call
    const fields = await adapter.listFields();
    const knownFieldNames = new Set(fields.map((f) => f.name));

    const { result, valuesToSave } = processSaveValues(
      values,
      obj.values,
      fields,
      knownFieldNames
    );

    if (Object.keys(valuesToSave).length > 0) {
      // Pass fields to avoid re-reading them in updateObjectFields
      await adapter.updateObjectFields(name, valuesToSave, fields);
    }

    // Summarize results by status
    const statusCounts: Record<string, number> = {};
    for (const status of Object.values(result)) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    logger.info('tool_save_object_result', { name, statusCounts });

    return { result };
  }) as ToolHandler<unknown, { result: Record<string, SaveStatus> }>,

  filler_save_objects_no_overwrite: (async (args, adapter) => {
    const { objects: inputObjects } = saveObjectsNoOverwriteSchema.parse(args);

    // Fetch fields once for all objects
    const fields = await adapter.listFields();
    const knownFieldNames = new Set(fields.map((f) => f.name));

    // Fetch all objects once
    let allObjects: { name: string; values: Record<string, string> }[];
    if (adapter.getObjectsAndFields) {
      const data = await adapter.getObjectsAndFields();
      allObjects = data.objects;
    } else {
      allObjects = await adapter.listObjects();
    }
    const objectMap = new Map(allObjects.map((o) => [o.name, o]));

    const results: Record<string, Record<string, SaveStatus> | { error: string }> = {};

    for (const { name, values } of inputObjects) {
      const obj = objectMap.get(name);
      if (!obj) {
        results[name] = { error: `Object "${name}" not found` };
        continue;
      }

      const { result, valuesToSave } = processSaveValues(
        values,
        obj.values,
        fields,
        knownFieldNames
      );

      if (Object.keys(valuesToSave).length > 0) {
        await adapter.updateObjectFields(name, valuesToSave, fields);
        // Update local copy so subsequent saves for same object see new values
        Object.assign(obj.values, valuesToSave);
      }

      results[name] = result;
    }

    logger.info('tool_save_objects_result', { count: inputObjects.length });
    return { results };
  }) as ToolHandler<
    unknown,
    { results: Record<string, Record<string, SaveStatus> | { error: string }> }
  >,

  filler_get_next_missing_fields_object: (async (args, adapter) => {
    const { include_field_meta } = getNextMissingFieldsObjectSchema.parse(args);

    // Use batch operation if available, otherwise fall back to separate calls
    let fields: Field[];
    let objects: { name: string; values: Record<string, string> }[];

    if (adapter.getObjectsAndFields) {
      const result = await adapter.getObjectsAndFields();
      fields = result.fields;
      objects = result.objects;
    } else {
      fields = await adapter.listFields();
      objects = await adapter.listObjects();
    }

    const autoFields = fields.filter((f) => f.auto === true);

    if (autoFields.length === 0) {
      return { found: false };
    }

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

  filler_get_next_missing_fields_objects: (async (args, adapter) => {
    const { limit, include_field_meta } = getNextMissingFieldsObjectsSchema.parse(args);

    let fields: Field[];
    let objects: { name: string; values: Record<string, string> }[];

    if (adapter.getObjectsAndFields) {
      const result = await adapter.getObjectsAndFields();
      fields = result.fields;
      objects = result.objects;
    } else {
      fields = await adapter.listFields();
      objects = await adapter.listObjects();
    }

    const autoFields = fields.filter((f) => f.auto === true);

    if (autoFields.length === 0) {
      return { found: false, objects: [] };
    }

    const collected: Array<{
      object: { name: string; values: Record<string, string> };
      missing: Array<{ name: string; type?: string; example?: string; instructions?: string }>;
    }> = [];

    for (const obj of objects) {
      if (collected.length >= limit) break;

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

        collected.push({ object: obj, missing });
      }
    }

    return {
      found: collected.length > 0,
      objects: collected,
    };
  }) as ToolHandler<
    unknown,
    {
      found: boolean;
      objects: Array<{
        object: { name: string; values: Record<string, string> };
        missing: Array<{ name: string; type?: string; example?: string; instructions?: string }>;
      }>;
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

  filler_init: (async (args, adapter) => {
    initSheetSchema.parse(args);

    if (!adapter.initSheet) {
      throw new FillerError(
        'backend_not_configured',
        'filler_init is only available with the sheets backend'
      );
    }

    const { fieldsTab, dataTab, keyField, alreadyExists } = await adapter.initSheet();
    logger.info('tool_init_success', { fieldsTab, dataTab, keyField, alreadyExists });

    if (alreadyExists) {
      return { success: true, fieldsTab, dataTab, keyField, message: `Tab "${fieldsTab}" already exists` };
    }

    return { success: true, fieldsTab, dataTab, keyField };
  }) as ToolHandler<unknown, { success: boolean; fieldsTab: string; dataTab: string; keyField: string; message?: string }>,
};

export type ToolName = keyof typeof handlers;
