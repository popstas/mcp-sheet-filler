import type { StorageAdapter } from '../storage/adapter.js';
import type { Field, SaveStatus } from '../types.js';
import { FillerError } from '../types.js';
import { isEmpty, processSaveValues } from '../validation.js';
import { logger } from '../logger.js';
import {
  addFieldsSchema,
  listFieldsSchema,
  getObjectsByNameSchema,
  addObjectsByNameSchema,
  saveObjectsNoOverwriteSchema,
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
  filler_add_fields: (async (args, adapter) => {
    const { fields } = addFieldsSchema.parse(args);

    // Check for duplicates within input
    const inputNames = new Set<string>();
    const results: Record<string, { created: true } | { error: string }> = {};

    for (const field of fields) {
      if (inputNames.has(field.name)) {
        results[field.name] = { error: `Duplicate field name in request` };
      }
      inputNames.add(field.name);
    }

    // Check which names already exist (1 call)
    const existing = await adapter.getFieldsByNames([...inputNames]);
    const existingNames = new Set(existing.map((f) => f.name));

    const toAdd: Field[] = [];
    for (const field of fields) {
      if (results[field.name]) continue; // already marked as duplicate
      if (existingNames.has(field.name)) {
        results[field.name] = { error: `Field "${field.name}" already exists` };
      } else {
        toAdd.push(field);
        results[field.name] = { created: true };
      }
    }

    if (toAdd.length > 0) {
      if (adapter.addFields) {
        await adapter.addFields(toAdd);
      } else {
        for (const field of toAdd) {
          await adapter.addField(field);
        }
      }
    }

    logger.info('tool_add_fields_success', { count: toAdd.length, total: fields.length });
    return { results };
  }) as ToolHandler<unknown, { results: Record<string, { created: true } | { error: string }> }>,

  filler_list_fields: (async (args, adapter) => {
    const { names, include_instructions } = listFieldsSchema.parse(args);
    const fields = await adapter.listFields(names);
    return { fields: stripInstructions(fields, include_instructions) };
  }) as ToolHandler<unknown, { fields: Field[] }>,

  filler_get_objects_by_name: (async (args, adapter) => {
    const { names, include_field_meta } = getObjectsByNameSchema.parse(args);

    // Load all objects and fields in one call
    let allObjects: { name: string; values: Record<string, string> }[];
    let fields: Field[];

    if (adapter.getObjectsAndFields) {
      const result = await adapter.getObjectsAndFields();
      allObjects = result.objects;
      fields = result.fields;
    } else {
      allObjects = await adapter.listObjects();
      fields = await adapter.listFields();
    }

    const objectMap = new Map(allObjects.map((o) => [o.name, o]));
    const autoFields = fields.filter((f) => f.auto === true);

    let isFirst = true;
    const objects = names.map((name) => {
      const obj = objectMap.get(name);
      if (!obj) {
        return { found: false as const, name };
      }

      const missingFields = autoFields.filter((f) => isEmpty(obj.values[f.name]));

      const missing = missingFields.map((f) => {
        if (include_field_meta && isFirst) {
          return {
            name: f.name,
            type: f.type,
            example: f.example,
            instructions: f.instructions,
          };
        }
        return { name: f.name };
      });

      isFirst = false;
      return { found: true as const, object: obj, missing };
    });

    return { objects };
  }) as ToolHandler<
    unknown,
    {
      objects: Array<
        | { found: false; name: string }
        | {
            found: true;
            object: { name: string; values: Record<string, string> };
            missing: Array<{ name: string; type?: string; example?: string; instructions?: string }>;
          }
      >;
    }
  >,

  filler_add_objects_by_name: (async (args, adapter) => {
    const { names } = addObjectsByNameSchema.parse(args);

    // Check for duplicates within input
    const inputNames = new Set<string>();
    const results: Record<string, { created: true } | { error: string }> = {};

    for (const name of names) {
      if (inputNames.has(name)) {
        results[name] = { error: `Duplicate name in request` };
      }
      inputNames.add(name);
    }

    // Load all objects to check existence (1 call)
    const allObjects = await adapter.listObjects();
    const existingNames = new Set(allObjects.map((o) => o.name));

    const toAdd: string[] = [];
    for (const name of names) {
      if (results[name]) continue; // already marked as duplicate
      if (existingNames.has(name)) {
        results[name] = { error: `Object "${name}" already exists` };
      } else {
        toAdd.push(name);
        results[name] = { created: true };
      }
    }

    if (toAdd.length > 0) {
      if (adapter.addObjectsByName) {
        await adapter.addObjectsByName(toAdd);
      } else {
        for (const name of toAdd) {
          await adapter.addObjectByName(name);
        }
      }
    }

    logger.info('tool_add_objects_success', { count: toAdd.length, total: names.length });
    return { results };
  }) as ToolHandler<unknown, { results: Record<string, { created: true } | { error: string }> }>,

  filler_save_objects_no_overwrite: (async (args, adapter) => {
    const { objects: inputObjects } = saveObjectsNoOverwriteSchema.parse(args);

    // Fetch fields and objects in one call (1 API call via batchGet)
    let fields: Field[];
    let allObjects: { name: string; values: Record<string, string> }[];

    if (adapter.getObjectsAndFields) {
      const data = await adapter.getObjectsAndFields();
      fields = data.fields;
      allObjects = data.objects;
    } else {
      fields = await adapter.listFields();
      allObjects = await adapter.listObjects();
    }

    const knownFieldNames = new Set(fields.map((f) => f.name));
    const objectMap = new Map(allObjects.map((o) => [o.name, o]));

    const results: Record<string, Record<string, SaveStatus> | { error: string }> = {};
    const pendingUpdates: Array<{ name: string; values: Record<string, string> }> = [];

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
        pendingUpdates.push({ name, values: valuesToSave });
        // Update local copy so subsequent saves for same object see new values
        Object.assign(obj.values, valuesToSave);
      }

      results[name] = result;
    }

    // Write all updates in one batch call (1 data read + 1 batchUpdate = 2 API calls)
    if (pendingUpdates.length > 0) {
      if (adapter.batchUpdateObjectsFields) {
        await adapter.batchUpdateObjectsFields(pendingUpdates, fields);
      } else {
        // Fallback: per-object updates (for mock adapter / adapters without batch support)
        for (const { name, values } of pendingUpdates) {
          await adapter.updateObjectFields(name, values, fields);
        }
      }
    }

    logger.info('tool_save_objects_result', { count: inputObjects.length });
    return { results };
  }) as ToolHandler<
    unknown,
    { results: Record<string, Record<string, SaveStatus> | { error: string }> }
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
      return { found: false, objects: [], count: 0, remain: 0 };
    }

    const collected: Array<{
      object: { name: string; values: Record<string, string> };
      missing: Array<{ name: string; type?: string; example?: string; instructions?: string }>;
    }> = [];

    let count = 0;

    for (const obj of objects) {
      const missingFields = autoFields.filter((f) => isEmpty(obj.values[f.name]));

      if (missingFields.length > 0) {
        count++;

        if (collected.length < limit) {
          const missing = missingFields.map((f) => {
            if (include_field_meta && collected.length === 0) {
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
    }

    return {
      found: collected.length > 0,
      objects: collected,
      count,
      remain: count - collected.length,
    };
  }) as ToolHandler<
    unknown,
    {
      found: boolean;
      objects: Array<{
        object: { name: string; values: Record<string, string> };
        missing: Array<{ name: string; type?: string; example?: string; instructions?: string }>;
      }>;
      count: number;
      remain: number;
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
