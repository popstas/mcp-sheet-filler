import { sheets, sheets_v4 } from '@googleapis/sheets';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import type { StorageAdapter, StorageConfig, AuthMethod, AuthStatus } from './adapter.js';
import type { Field, DataObject } from '../types.js';
import { FillerError } from '../types.js';
import {
  loadTokens,
  saveTokens,
  isTokenExpired,
  refreshAccessToken,
  getDefaultTokenPath,
  getUserTokenPath,
  type OAuthTokens,
} from '../auth/oauth.js';
import { logger } from '../logger.js';
import { getCurrentUserId, getCurrentAccessToken } from '../context.js';
import fs from 'fs';

// Field columns in the fields sheet (0-indexed)
const FIELD_COLUMNS = {
  name: 0,
  description: 1,
  auto: 2,
  instructions: 3,
  type: 4,
  example: 5,
};

const FIELD_HEADERS = ['name', 'description', 'auto', 'instructions', 'type', 'example'];

// Extract sheet ID from URL or return as-is if already an ID
export function extractSheetIdFromUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new FillerError('invalid_argument', 'Sheet ID cannot be empty');
  }
  // Handle raw ID (no slashes)
  if (!trimmed.includes('/')) {
    return trimmed;
  }
  // Parse URL: https://docs.google.com/spreadsheets/d/{ID}/...
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    return match[1];
  }
  throw new FillerError('invalid_argument', 'Invalid Google Sheets URL format');
}

function parseBoolean(value: string | undefined | null): boolean {
  if (!value) return false;
  const lower = value.toLowerCase().trim();
  return lower === 'true' || lower === '1' || lower === 'yes';
}

function rowToField(row: (string | undefined)[]): Field {
  return {
    name: row[FIELD_COLUMNS.name] || '',
    description: row[FIELD_COLUMNS.description] || undefined,
    auto: parseBoolean(row[FIELD_COLUMNS.auto]),
    instructions: row[FIELD_COLUMNS.instructions] || undefined,
    type: row[FIELD_COLUMNS.type] || 'string',
    example: row[FIELD_COLUMNS.example] || undefined,
  };
}

function columnIndexToLetter(index: number): string {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

// Per-user OAuth client state
interface UserAuthState {
  oauthClient: OAuth2Client;
  oauthTokens: OAuthTokens;
  sheets: sheets_v4.Sheets;
}

export function createSheetsAdapter(config: StorageConfig): StorageAdapter {
  // Per-user OAuth client cache
  const userAuthCache = new Map<string, UserAuthState>();

  // Store mutable state for dynamic switching (fallback for non-OAuth auth)
  const state: {
    spreadsheetId: string;
    authMethod: AuthMethod;
    oauthClient: OAuth2Client | null;
    oauthTokens: OAuthTokens | null;
    oauthTokenPath: string;
  } = {
    spreadsheetId: config.googleSheetId || '',
    authMethod: 'adc',
    oauthClient: null,
    oauthTokens: null,
    oauthTokenPath: config.googleOAuthTokenPath || getDefaultTokenPath(),
  };

  const fieldsTab = config.sheetTabFields || 'fields';
  let dataTab = config.sheetTabData; // undefined means "use first tab"

  // Cache for first tab name (keyed by spreadsheet ID)
  let cachedFirstTabName: string | null = null;
  let cachedFirstTabNameSheetId: string | null = null;

  // Resolve first tab name from spreadsheet metadata (with caching)
  async function getFirstTabName(): Promise<string> {
    // Return cached value if spreadsheet hasn't changed
    if (cachedFirstTabName && cachedFirstTabNameSheetId === state.spreadsheetId) {
      return cachedFirstTabName;
    }

    await ensureValidTokens();
    const client = getSheetsClient();
    try {
      const spreadsheet = await client.spreadsheets.get({
        spreadsheetId: state.spreadsheetId,
        fields: 'sheets.properties.title',
      });
      const tabs = (spreadsheet.data.sheets || []).map(
        (s) => s.properties?.title || ''
      );
      if (tabs.length === 0) {
        throw new FillerError('storage_error', 'Spreadsheet has no tabs');
      }
      const firstTab = tabs[0];
      // Cache the result
      cachedFirstTabName = firstTab;
      cachedFirstTabNameSheetId = state.spreadsheetId;
      return firstTab;
    } catch (error) {
      if (error instanceof FillerError) throw error;
      const err = error as { message?: string };
      throw new FillerError('storage_error', `Failed to read spreadsheet: ${err.message}`);
    }
  }

  // Returns dataTab if configured, otherwise resolves to first tab and caches
  async function resolveDataTab(): Promise<string> {
    if (dataTab) return dataTab;
    const firstTab = await getFirstTabName();
    if (firstTab === fieldsTab) {
      throw new FillerError(
        'storage_error',
        `First tab "${firstTab}" is the fields metadata tab. ` +
        `Move your data to a different tab and place it first, ` +
        `or set SHEET_TAB_DATA to specify the data tab explicitly.`
      );
    }
    dataTab = firstTab;
    return firstTab;
  }

  // Mutable sheets client - will be recreated when auth changes
  let sheetsClient: sheets_v4.Sheets;

  /**
   * Create OAuth client for a specific user with token refresh handling
   */
  function createUserOAuthClient(userId: string, tokens: OAuthTokens): UserAuthState {
    const oauth2Client = new OAuth2Client(
      config.googleOAuthClientId,
      config.googleOAuthClientSecret
    );
    oauth2Client.setCredentials(tokens);

    const tokenPath = getUserTokenPath(userId);

    // Set up token refresh handling for this user
    oauth2Client.on('tokens', (newTokens) => {
      logger.info('oauth_tokens_refreshed', { userId, expiry_date: newTokens.expiry_date });
      const cachedState = userAuthCache.get(userId);
      const updatedTokens: OAuthTokens = {
        access_token: newTokens.access_token!,
        refresh_token: newTokens.refresh_token || cachedState?.oauthTokens?.refresh_token,
        expiry_date: newTokens.expiry_date || undefined,
        token_type: newTokens.token_type || undefined,
        scope: newTokens.scope || undefined,
      };
      if (cachedState) {
        cachedState.oauthTokens = updatedTokens;
      }
      saveTokens(updatedTokens, tokenPath);
    });

    const userSheets = sheets({ version: 'v4', auth: oauth2Client });

    return {
      oauthClient: oauth2Client,
      oauthTokens: tokens,
      sheets: userSheets,
    };
  }

  // Cache for MCP access token-based sheets clients (keyed by token hash)
  const mcpTokenClientCache = new Map<string, sheets_v4.Sheets>();

  /**
   * Create a Sheets client using an access token directly (from MCP auth).
   * This avoids the need for separate filler_google_auth flow.
   */
  function createSheetsClientFromToken(accessToken: string): sheets_v4.Sheets {
    // Simple hash for cache key (first 16 chars of token)
    const cacheKey = accessToken.slice(0, 16);

    if (mcpTokenClientCache.has(cacheKey)) {
      return mcpTokenClientCache.get(cacheKey)!;
    }

    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken });
    const client = sheets({ version: 'v4', auth: oauth2Client });

    mcpTokenClientCache.set(cacheKey, client);
    logger.debug('sheets_client_from_mcp_token', { source: 'mcp_token' });

    return client;
  }

  /**
   * Get or create OAuth client for current user from context
   * In HTTP transport mode (when MCP access token is present), tokens are not loaded from disk
   * to prevent server owner from accessing user tokens.
   */
  function getUserAuth(): UserAuthState | null {
    const userId = getCurrentUserId();

    // In HTTP transport mode, MCP access token is used directly - don't load tokens from disk
    const mcpToken = getCurrentAccessToken();
    if (mcpToken) {
      // HTTP transport mode - tokens should not be loaded from disk
      return null;
    }

    // Check cache first
    if (userAuthCache.has(userId)) {
      return userAuthCache.get(userId)!;
    }

    // Try to load tokens for this user (stdio transport mode only)
    if (config.googleOAuthClientId && config.googleOAuthClientSecret) {
      const tokenPath = getUserTokenPath(userId);
      const tokens = loadTokens(tokenPath);

      if (tokens) {
        const userAuth = createUserOAuthClient(userId, tokens);
        userAuthCache.set(userId, userAuth);
        logger.info('user_oauth_initialized', { userId, method: 'oauth' });
        return userAuth;
      }
    }

    return null;
  }

  /**
   * Initialize fallback auth (Service Account or ADC) - not user-specific
   */
  function initializeFallbackAuth(): void {
    // Priority 1: Service account
    if (config.googleServiceAccountKey) {
      let credentials: object;
      // Check if it's a path or JSON string
      if (config.googleServiceAccountKey.startsWith('{')) {
        credentials = JSON.parse(config.googleServiceAccountKey);
      } else if (fs.existsSync(config.googleServiceAccountKey)) {
        credentials = JSON.parse(fs.readFileSync(config.googleServiceAccountKey, 'utf-8'));
      } else {
        throw new FillerError(
          'backend_not_configured',
          'GOOGLE_SERVICE_ACCOUNT_KEY must be a JSON string or path to a JSON file'
        );
      }
      const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      state.authMethod = 'service_account';
      sheetsClient = sheets({ version: 'v4', auth });
      logger.info('sheets_auth_initialized', { method: 'service_account' });
      return;
    }

    // Priority 2: Application Default Credentials
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    state.authMethod = 'adc';
    sheetsClient = sheets({ version: 'v4', auth });
    logger.info('sheets_auth_initialized', { method: 'adc' });
  }

  /**
   * Get the sheets client for the current request.
   * Priority:
   * 1. MCP access token from request context (reused for Sheets API)
   * 2. User-specific OAuth tokens (from filler_google_auth)
   * 3. Fallback (service account or ADC)
   */
  function getSheetsClient(): sheets_v4.Sheets {
    // Priority 1: Use MCP access token if available in context
    const mcpToken = getCurrentAccessToken();
    if (mcpToken) {
      return createSheetsClientFromToken(mcpToken);
    }

    // Priority 2: User-specific OAuth tokens
    const userAuth = getUserAuth();
    if (userAuth) {
      return userAuth.sheets;
    }

    // Priority 3: Fallback (service account or ADC)
    return sheetsClient;
  }

  /**
   * Ensure OAuth tokens are refreshed if expired for current user.
   * Skipped when using MCP access token (already validated at HTTP layer).
   */
  async function ensureValidTokens(): Promise<void> {
    // Skip if using MCP token (already validated)
    const mcpToken = getCurrentAccessToken();
    if (mcpToken) {
      return;
    }

    const userAuth = getUserAuth();

    if (userAuth) {
      const userId = getCurrentUserId();
      if (isTokenExpired(userAuth.oauthTokens)) {
        logger.info('oauth_tokens_expired', { userId, expiry_date: userAuth.oauthTokens.expiry_date });
        try {
          const newTokens = await refreshAccessToken(userAuth.oauthClient, userAuth.oauthTokens);
          userAuth.oauthTokens = newTokens;
          userAuth.oauthClient.setCredentials(newTokens);
          saveTokens(newTokens, getUserTokenPath(userId));
        } catch (error) {
          logger.error('oauth_refresh_failed', { userId, error: error instanceof Error ? error.message : String(error) });
          throw new FillerError(
            'backend_not_configured',
            'OAuth token refresh failed. Please re-authenticate using filler_google_auth tool.'
          );
        }
      }
      return;
    }

    // Fallback to legacy state-based auth
    if (state.authMethod !== 'oauth' || !state.oauthClient || !state.oauthTokens) {
      return;
    }

    if (isTokenExpired(state.oauthTokens)) {
      logger.info('oauth_tokens_expired', { expiry_date: state.oauthTokens.expiry_date });
      try {
        const newTokens = await refreshAccessToken(state.oauthClient, state.oauthTokens);
        state.oauthTokens = newTokens;
        state.oauthClient.setCredentials(newTokens);
        saveTokens(newTokens, state.oauthTokenPath);
      } catch (error) {
        logger.error('oauth_refresh_failed', { error: error instanceof Error ? error.message : String(error) });
        throw new FillerError(
          'backend_not_configured',
          'OAuth token refresh failed. Please re-authenticate with: npm run auth'
        );
      }
    }
  }

  // Initialize fallback auth on startup (service account or ADC)
  initializeFallbackAuth();

  // Helper to get all rows from a sheet
  async function getSheetData(sheetName: string): Promise<string[][]> {
    await ensureValidTokens();
    const client = getSheetsClient();
    try {
      const response = await client.spreadsheets.values.get({
        spreadsheetId: state.spreadsheetId,
        range: sheetName,
      });
      const rows = (response.data.values as string[][]) || [];
      logger.debug('sheets_get_data', { tab: sheetName, rowCount: rows.length });
      return rows;
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string };
      if (err.code === 404) {
        throw new FillerError('storage_error', `Sheet "${sheetName}" not found`);
      }
      throw new FillerError('storage_error', `Failed to read sheet: ${err.message}`);
    }
  }

  // Helper to get only headers (first row) from a sheet
  async function getSheetHeaders(sheetName: string): Promise<string[]> {
    await ensureValidTokens();
    const client = getSheetsClient();
    try {
      const response = await client.spreadsheets.values.get({
        spreadsheetId: state.spreadsheetId,
        range: `${sheetName}!1:1`, // Only first row
      });
      const headers = (response.data.values?.[0] as string[]) || [];
      logger.debug('sheets_get_headers', { tab: sheetName, headerCount: headers.length });
      return headers;
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string };
      if (err.code === 404) {
        throw new FillerError('storage_error', `Sheet "${sheetName}" not found`);
      }
      throw new FillerError('storage_error', `Failed to read sheet headers: ${err.message}`);
    }
  }

  // Helper to get data headers (first row) - optimized to read only first row
  async function getDataHeaders(): Promise<string[]> {
    const resolvedDataTab = await resolveDataTab();
    return await getSheetHeaders(resolvedDataTab);
  }

  // Helper to batch read multiple sheet ranges in a single API call
  async function batchGetSheetData(ranges: string[]): Promise<Map<string, string[][]>> {
    await ensureValidTokens();
    const client = getSheetsClient();
    try {
      const response = await client.spreadsheets.values.batchGet({
        spreadsheetId: state.spreadsheetId,
        ranges: ranges, // Например: ['Sheet1', 'fields']
      });

      // Преобразовать в Map: ключ = имя листа, значение = данные
      const result = new Map<string, string[][]>();
      if (response.data.valueRanges) {
        ranges.forEach((range, index) => {
          // Извлечь имя листа из диапазона (убрать '!' и всё после)
          const sheetName = range.split('!')[0];
          const values = (response.data.valueRanges?.[index]?.values as string[][]) || [];
          result.set(sheetName, values);
        });
      }
      logger.debug('sheets_batch_get_data', { rangeCount: ranges.length, sheets: Array.from(result.keys()) });
      return result;
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string };
      if (err.code === 404) {
        throw new FillerError('storage_error', `One or more sheets not found in batch request`);
      }
      throw new FillerError('storage_error', `Failed to batch read sheets: ${err.message}`);
    }
  }

  // Helper to find column index by header name
  async function getColumnIndex(headers: string[], fieldName: string): Promise<number> {
    const index = headers.indexOf(fieldName);
    if (index === -1) {
      throw new FillerError('field_not_found', `Column "${fieldName}" not found in data sheet`);
    }
    return index;
  }

  const adapter: StorageAdapter = {
    async listFields(names?: string[]): Promise<Field[]> {
      let fields: Field[];
      try {
        const data = await getSheetData(fieldsTab);
        // Skip header row
        const rows = data.slice(1);
        fields = rows.map(rowToField).filter((f) => f.name);
      } catch (error) {
        // Fallback: derive fields from data tab headers when fields tab doesn't exist
        if (error instanceof FillerError && error.message.includes('not found')) {
          const headers = await getDataHeaders();
          fields = headers.filter((h) => h).map((h) => ({
            name: h,
            type: 'string',
            auto: false,
          }));
          logger.debug('sheets_list_fields_fallback', { count: fields.length });
        } else {
          throw error;
        }
      }

      if (names && names.length > 0) {
        const nameSet = new Set(names);
        fields = fields.filter((f) => nameSet.has(f.name));
      }

      logger.debug('sheets_list_fields', { count: fields.length, filtered: !!names });
      return fields;
    },

    async getFieldsByNames(names: string[]): Promise<Field[]> {
      if (names.length === 0) return [];
      const allFields = await adapter.listFields();
      const nameSet = new Set(names);
      const found = allFields.filter((f) => nameSet.has(f.name));
      logger.debug('sheets_get_fields_by_names', { requested: names.length, found: found.length });
      return found;
    },

    async addField(field: Field): Promise<void> {
      await ensureValidTokens();
      const client = getSheetsClient();
      logger.debug('sheets_add_field', { name: field.name, type: field.type || 'string' });
      const row = [
        field.name,
        field.description || '',
        field.auto ? 'true' : 'false',
        field.instructions || '',
        field.type || 'string',
        field.example || '',
      ];

      try {
        await client.spreadsheets.values.append({
          spreadsheetId: state.spreadsheetId,
          range: `${fieldsTab}!A:F`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [row],
          },
        });
      } catch (error: unknown) {
        const err = error as { message?: string };
        throw new FillerError('storage_error', `Failed to add field: ${err.message}`);
      }

      // Also add column to data sheet if it doesn't exist
      const resolvedDataTab = await resolveDataTab();
      const headers = await getDataHeaders();
      if (!headers.includes(field.name)) {
        const colIndex = headers.length;
        const colLetter = columnIndexToLetter(colIndex);
        await client.spreadsheets.values.update({
          spreadsheetId: state.spreadsheetId,
          range: `${resolvedDataTab}!${colLetter}1`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [[field.name]],
          },
        });
      }
    },

    async getObjectByName(name: string): Promise<DataObject | null> {
      const resolvedDataTab = await resolveDataTab();
      const data = await getSheetData(resolvedDataTab);
      if (data.length === 0) {
        logger.debug('sheets_get_object_by_name', { name, found: false, reason: 'empty_sheet' });
        return null;
      }

      const headers = data[0];
      if (headers.length === 0) {
        logger.debug('sheets_get_object_by_name', { name, found: false, reason: 'no_headers' });
        return null;
      }

      // First column is always the key
      const keyColIndex = 0;

      // Find row with matching key
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row[keyColIndex] === name) {
          const values: Record<string, string> = {};
          for (let j = 0; j < headers.length; j++) {
            if (headers[j] && row[j] !== undefined && row[j] !== '') {
              values[headers[j]] = row[j];
            }
          }
          logger.debug('sheets_get_object_by_name', { name, found: true, fieldCount: Object.keys(values).length });
          return { name, values };
        }
      }

      logger.debug('sheets_get_object_by_name', { name, found: false });
      return null;
    },

    async listObjects(): Promise<DataObject[]> {
      const resolvedDataTab = await resolveDataTab();
      const data = await getSheetData(resolvedDataTab);
      if (data.length <= 1) {
        logger.debug('sheets_list_objects', { count: 0 });
        return []; // No data rows, only headers
      }

      const headers = data[0];
      if (headers.length === 0) {
        logger.debug('sheets_list_objects', { count: 0 });
        return [];
      }

      const objects: DataObject[] = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const name = row[0]; // First column is the key
        if (!name) continue;

        const values: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
          if (headers[j] && row[j] !== undefined && row[j] !== '') {
            values[headers[j]] = row[j];
          }
        }
        objects.push({ name, values });
      }

      logger.debug('sheets_list_objects', { count: objects.length });
      return objects;
    },

    async addObjectByName(name: string): Promise<void> {
      await ensureValidTokens();
      const client = getSheetsClient();
      logger.debug('sheets_add_object_by_name', { name });
      const headers = await getDataHeaders();
      if (headers.length === 0) {
        throw new FillerError('storage_error', 'Data sheet has no headers');
      }

      // First column is always the key
      const keyColIndex = 0;

      // Create row with only the key field set
      const resolvedDataTab = await resolveDataTab();
      const row = new Array(headers.length).fill('');
      row[keyColIndex] = name;

      try {
        await client.spreadsheets.values.append({
          spreadsheetId: state.spreadsheetId,
          range: `${resolvedDataTab}!A:${columnIndexToLetter(headers.length - 1)}`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [row],
          },
        });
      } catch (error: unknown) {
        const err = error as { message?: string };
        throw new FillerError('storage_error', `Failed to add object: ${err.message}`);
      }
    },

    async updateObjectFields(name: string, values: Record<string, string>, providedFields?: Field[]): Promise<void> {
      await ensureValidTokens();
      const client = getSheetsClient();
      logger.debug('sheets_update_object_fields', { name, fields: Object.keys(values) });
      const resolvedDataTab = await resolveDataTab();

      let data: string[][];
      let fields: Field[];

      // Use batching if fields are not provided
      if (!providedFields) {
        // Batch read both data sheet and fields sheet
        const batchData = await batchGetSheetData([resolvedDataTab, fieldsTab]);
        data = batchData.get(resolvedDataTab) || [];
        const fieldsData = batchData.get(fieldsTab) || [];
        // Skip header row and convert to Field[]
        const rows = fieldsData.slice(1);
        fields = rows.map(rowToField).filter((f) => f.name);
      } else {
        // Use provided fields and read only data sheet
        data = await getSheetData(resolvedDataTab);
        fields = providedFields;
      }

      if (data.length === 0) return;

      const headers = [...data[0]];
      if (headers.length === 0) return;

      // First column is always the key
      const keyColIndex = 0;

      // Find row index
      let rowIndex = -1;
      for (let i = 1; i < data.length; i++) {
        if (data[i][keyColIndex] === name) {
          rowIndex = i + 1; // 1-based for Sheets API
          break;
        }
      }

      if (rowIndex === -1) return;

      // Get field types to convert numbers properly
      const fieldTypeMap = new Map(fields.map((f) => [f.name, f.type]));

      // Update each field
      const updateData: { range: string; values: (string | number)[][] }[] = [];

      for (const [fieldName, value] of Object.entries(values)) {
        let colIndex = headers.indexOf(fieldName);
        if (colIndex === -1) {
          colIndex = headers.length;
          headers.push(fieldName);
          const colLetter = columnIndexToLetter(colIndex);
          updateData.push({
            range: `${resolvedDataTab}!${colLetter}1`,
            values: [[fieldName]],
          });
        }

        const colLetter = columnIndexToLetter(colIndex);
        const fieldType = fieldTypeMap.get(fieldName);

        // Convert number fields to actual numbers
        let cellValue: string | number = value;
        if (fieldType === 'number' && value !== '' && !isNaN(Number(value))) {
          cellValue = Number(value);
        }

        updateData.push({
          range: `${resolvedDataTab}!${colLetter}${rowIndex}`,
          values: [[cellValue]],
        });
      }

      if (updateData.length > 0) {
        try {
          await client.spreadsheets.values.batchUpdate({
            spreadsheetId: state.spreadsheetId,
            requestBody: {
              valueInputOption: 'RAW',
              data: updateData,
            },
          });
        } catch (error: unknown) {
          const err = error as { message?: string };
          throw new FillerError('storage_error', `Failed to update object: ${err.message}`);
        }
      }
    },

    async getFieldNames(): Promise<string[]> {
      // Optimized: read only the name column (column A) from fields sheet
      await ensureValidTokens();
      const client = getSheetsClient();
      try {
        const response = await client.spreadsheets.values.get({
          spreadsheetId: state.spreadsheetId,
          range: `${fieldsTab}!A:A`, // Only column A (name column)
        });
        const rows = (response.data.values as string[][]) || [];
        // Skip header row and filter out empty names
        const names = rows.slice(1).map((row) => row[0]?.trim() || '').filter((name) => name);
        logger.debug('sheets_get_field_names', { count: names.length });
        return names;
      } catch (error: unknown) {
        // Fallback to full listFields if fields sheet doesn't exist
        if (error instanceof FillerError && error.message.includes('not found')) {
          const fields = await adapter.listFields();
          return fields.map((f) => f.name);
        }
        const err = error as { code?: number; message?: string };
        if (err.code === 404) {
          throw new FillerError('storage_error', `Sheet "${fieldsTab}" not found`);
        }
        throw new FillerError('storage_error', `Failed to read field names: ${err.message}`);
      }
    },

    // Batch operations for optimization
    async getObjectByNameAndFields(name: string): Promise<{ object: DataObject | null; fields: Field[] }> {
      const resolvedDataTab = await resolveDataTab();
      // Batch read both data sheet and fields sheet
      const batchData = await batchGetSheetData([resolvedDataTab, fieldsTab]);
      const data = batchData.get(resolvedDataTab) || [];
      const fieldsData = batchData.get(fieldsTab) || [];

      // Parse fields
      const rows = fieldsData.slice(1);
      const fields = rows.map(rowToField).filter((f) => f.name);

      // Parse object from data
      if (data.length === 0) {
        logger.debug('sheets_get_object_by_name_and_fields', { name, found: false, reason: 'empty_sheet' });
        return { object: null, fields };
      }

      const headers = data[0];
      if (headers.length === 0) {
        logger.debug('sheets_get_object_by_name_and_fields', { name, found: false, reason: 'no_headers' });
        return { object: null, fields };
      }

      // First column is always the key
      const keyColIndex = 0;

      // Find row with matching key
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row[keyColIndex] === name) {
          const values: Record<string, string> = {};
          for (let j = 0; j < headers.length; j++) {
            if (headers[j] && row[j] !== undefined && row[j] !== '') {
              values[headers[j]] = row[j];
            }
          }
          logger.debug('sheets_get_object_by_name_and_fields', { name, found: true, fieldCount: Object.keys(values).length });
          return { object: { name, values }, fields };
        }
      }

      logger.debug('sheets_get_object_by_name_and_fields', { name, found: false });
      return { object: null, fields };
    },

    async getObjectsAndFields(): Promise<{ objects: DataObject[]; fields: Field[] }> {
      const resolvedDataTab = await resolveDataTab();
      // Batch read both data sheet and fields sheet
      const batchData = await batchGetSheetData([resolvedDataTab, fieldsTab]);
      const data = batchData.get(resolvedDataTab) || [];
      const fieldsData = batchData.get(fieldsTab) || [];

      // Parse fields
      const rows = fieldsData.slice(1);
      const fields = rows.map(rowToField).filter((f) => f.name);

      // Parse objects from data
      if (data.length <= 1) {
        logger.debug('sheets_get_objects_and_fields', { objectCount: 0 });
        return { objects: [], fields }; // No data rows, only headers
      }

      const headers = data[0];
      if (headers.length === 0) {
        logger.debug('sheets_get_objects_and_fields', { objectCount: 0 });
        return { objects: [], fields };
      }

      const objects: DataObject[] = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const name = row[0]; // First column is the key
        if (!name) continue;

        const values: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
          if (headers[j] && row[j] !== undefined && row[j] !== '') {
            values[headers[j]] = row[j];
          }
        }
        objects.push({ name, values });
      }

      logger.debug('sheets_get_objects_and_fields', { objectCount: objects.length });
      return { objects, fields };
    },

    async initSheet(): Promise<{ fieldsTab: string; dataTab: string; keyField: string }> {
      await ensureValidTokens();
      const client = getSheetsClient();

      let existingTabs: string[];
      // Get existing tabs
      try {
        const spreadsheet = await client.spreadsheets.get({
          spreadsheetId: state.spreadsheetId,
          fields: 'sheets.properties.title',
        });

        existingTabs = (spreadsheet.data.sheets || []).map(
          (s) => s.properties?.title || ''
        );

        if (existingTabs.includes(fieldsTab)) {
          const resolvedDataTab = existingTabs[0] || '';
          return { fieldsTab, dataTab: resolvedDataTab, keyField, alreadyExists: true };
        }
      } catch (error) {
        if (error instanceof FillerError) throw error;
        const err = error as { message?: string };
        throw new FillerError('storage_error', `Failed to read spreadsheet: ${err.message}`);
      }

      // Resolve first tab as data tab
      const resolvedDataTab = existingTabs[0];
      if (!resolvedDataTab) {
        throw new FillerError('storage_error', 'Spreadsheet has no tabs to use as data source');
      }
      dataTab = resolvedDataTab;

      // Read column headers from first tab
      let columnHeaders: string[];
      try {
        const data = await getSheetData(resolvedDataTab);
        columnHeaders = (data[0] || []).filter((h) => h);
      } catch (error: unknown) {
        const err = error as { message?: string };
        throw new FillerError('storage_error', `Failed to read data tab headers: ${err.message}`);
      }

      const keyField = columnHeaders[0] || config.objectKeyField;

      // Create fields tab only
      try {
        await client.spreadsheets.batchUpdate({
          spreadsheetId: state.spreadsheetId,
          requestBody: {
            requests: [
              { addSheet: { properties: { title: fieldsTab } } },
            ],
          },
        });
      } catch (error: unknown) {
        const err = error as { message?: string };
        throw new FillerError('storage_error', `Failed to create fields tab: ${err.message}`);
      }

      // Write field headers + one row per column header
      const fieldRows = columnHeaders.map((header) => [
        header, // name
        '',     // description
        'false', // auto
        '',     // instructions
        'string', // type
        '',     // example
      ]);

      try {
        await client.spreadsheets.values.batchUpdate({
          spreadsheetId: state.spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              {
                range: `${fieldsTab}!A1:F${1 + fieldRows.length}`,
                values: [FIELD_HEADERS, ...fieldRows],
              },
            ],
          },
        });
      } catch (error: unknown) {
        const err = error as { message?: string };
        throw new FillerError('storage_error', `Failed to write fields: ${err.message}`);
      }

      logger.info('sheets_init', { fieldsTab, dataTab: resolvedDataTab, keyField });
      return { fieldsTab, dataTab: resolvedDataTab, keyField };
    },

    setSheetId(idOrUrl: string): void {
      state.spreadsheetId = extractSheetIdFromUrl(idOrUrl);
      // Reset cached data tab and first tab name so they re-resolve for the new sheet
      dataTab = config.sheetTabData;
      cachedFirstTabName = null;
      cachedFirstTabNameSheetId = null;
    },

    getSheetId(): string {
      return state.spreadsheetId;
    },

    getAuthStatus(): AuthStatus {
      // Check if using MCP token
      const mcpToken = getCurrentAccessToken();
      if (mcpToken) {
        return { method: 'oauth' };
      }

      const userAuth = getUserAuth();
      if (userAuth) {
        return { method: 'oauth' };
      }
      return { method: state.authMethod };
    },

    setOAuthTokens(tokens: OAuthTokens): void {
      if (!config.googleOAuthClientId || !config.googleOAuthClientSecret) {
        throw new FillerError(
          'backend_not_configured',
          'OAuth client ID and secret must be configured to use OAuth'
        );
      }

      const userId = getCurrentUserId();
      const tokenPath = getUserTokenPath(userId);

      // Create and cache user-specific OAuth client
      const userAuth = createUserOAuthClient(userId, tokens);
      userAuthCache.set(userId, userAuth);

      // Save tokens to user-specific file
      saveTokens(tokens, tokenPath);

      logger.info('oauth_tokens_set_at_runtime', { userId, method: 'oauth' });
    },
  };

  return adapter;
}
