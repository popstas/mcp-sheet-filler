import { google, sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type { StorageAdapter, StorageConfig, AuthMethod, AuthStatus } from './adapter.js';
import type { Field, DataObject } from '../types.js';
import { FillerError } from '../types.js';
import {
  loadTokens,
  saveTokens,
  isTokenExpired,
  refreshAccessToken,
  getDefaultTokenPath,
  type OAuthTokens,
} from '../auth/oauth.js';
import { logger } from '../logger.js';
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

export function createSheetsAdapter(config: StorageConfig): StorageAdapter {
  // Store mutable state for dynamic switching
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
  const dataTab = config.sheetTabData || 'data';

  // Mutable sheets client - will be recreated when auth changes
  let sheets: sheets_v4.Sheets;

  /**
   * Initialize auth with priority: OAuth > Service Account > ADC
   */
  function initializeAuth(): void {
    // Priority 1: OAuth tokens from file
    const tokens = loadTokens(state.oauthTokenPath);
    if (tokens && config.googleOAuthClientId && config.googleOAuthClientSecret) {
      const oauth2Client = new OAuth2Client(
        config.googleOAuthClientId,
        config.googleOAuthClientSecret
      );
      oauth2Client.setCredentials(tokens);

      // Set up token refresh handling
      oauth2Client.on('tokens', (newTokens) => {
        logger.info('oauth_tokens_refreshed', { expiry_date: newTokens.expiry_date });
        const updatedTokens: OAuthTokens = {
          access_token: newTokens.access_token!,
          refresh_token: newTokens.refresh_token || state.oauthTokens?.refresh_token,
          expiry_date: newTokens.expiry_date || undefined,
          token_type: newTokens.token_type || undefined,
          scope: newTokens.scope || undefined,
        };
        state.oauthTokens = updatedTokens;
        saveTokens(updatedTokens, state.oauthTokenPath);
      });

      state.oauthClient = oauth2Client;
      state.oauthTokens = tokens;
      state.authMethod = 'oauth';
      sheets = google.sheets({ version: 'v4', auth: oauth2Client });
      logger.info('sheets_auth_initialized', { method: 'oauth' });
      return;
    }

    // Priority 2: Service account
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
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      state.authMethod = 'service_account';
      sheets = google.sheets({ version: 'v4', auth });
      logger.info('sheets_auth_initialized', { method: 'service_account' });
      return;
    }

    // Priority 3: Application Default Credentials
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    state.authMethod = 'adc';
    sheets = google.sheets({ version: 'v4', auth });
    logger.info('sheets_auth_initialized', { method: 'adc' });
  }

  /**
   * Ensure OAuth tokens are refreshed if expired
   */
  async function ensureValidTokens(): Promise<void> {
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

  // Initialize auth on startup
  initializeAuth();

  // Helper to get all rows from a sheet
  async function getSheetData(sheetName: string): Promise<string[][]> {
    await ensureValidTokens();
    try {
      const response = await sheets.spreadsheets.values.get({
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

  // Helper to get data headers (first row)
  async function getDataHeaders(): Promise<string[]> {
    const data = await getSheetData(dataTab);
    return data[0] || [];
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
      const data = await getSheetData(fieldsTab);
      // Skip header row
      const rows = data.slice(1);
      let fields = rows.map(rowToField).filter((f) => f.name);

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
        await sheets.spreadsheets.values.append({
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
      const headers = await getDataHeaders();
      if (!headers.includes(field.name)) {
        const colIndex = headers.length;
        const colLetter = columnIndexToLetter(colIndex);
        await sheets.spreadsheets.values.update({
          spreadsheetId: state.spreadsheetId,
          range: `${dataTab}!${colLetter}1`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [[field.name]],
          },
        });
      }
    },

    async getObjectByName(name: string): Promise<DataObject | null> {
      const data = await getSheetData(dataTab);
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
      const data = await getSheetData(dataTab);
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
      logger.debug('sheets_add_object_by_name', { name });
      const headers = await getDataHeaders();
      if (headers.length === 0) {
        throw new FillerError('storage_error', 'Data sheet has no headers');
      }

      // First column is always the key
      const keyColIndex = 0;

      // Create row with only the key field set
      const row = new Array(headers.length).fill('');
      row[keyColIndex] = name;

      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: state.spreadsheetId,
          range: `${dataTab}!A:${columnIndexToLetter(headers.length - 1)}`,
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

    async updateObjectFields(name: string, values: Record<string, string>): Promise<void> {
      await ensureValidTokens();
      logger.debug('sheets_update_object_fields', { name, fields: Object.keys(values) });
      const data = await getSheetData(dataTab);
      if (data.length === 0) return;

      const headers = data[0];
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
      const fields = await adapter.listFields();
      const fieldTypeMap = new Map(fields.map((f) => [f.name, f.type]));

      // Update each field
      const updateData: { range: string; values: (string | number)[][] }[] = [];

      for (const [fieldName, value] of Object.entries(values)) {
        const colIndex = headers.indexOf(fieldName);
        if (colIndex === -1) continue;

        const colLetter = columnIndexToLetter(colIndex);
        const fieldType = fieldTypeMap.get(fieldName);

        // Convert number fields to actual numbers
        let cellValue: string | number = value;
        if (fieldType === 'number' && value !== '' && !isNaN(Number(value))) {
          cellValue = Number(value);
        }

        updateData.push({
          range: `${dataTab}!${colLetter}${rowIndex}`,
          values: [[cellValue]],
        });
      }

      if (updateData.length > 0) {
        try {
          await sheets.spreadsheets.values.batchUpdate({
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
      const fields = await adapter.listFields();
      return fields.map((f) => f.name);
    },

    setSheetId(idOrUrl: string): void {
      state.spreadsheetId = extractSheetIdFromUrl(idOrUrl);
    },

    getSheetId(): string {
      return state.spreadsheetId;
    },

    getAuthStatus(): AuthStatus {
      return {
        method: state.authMethod,
      };
    },

    setOAuthTokens(tokens: OAuthTokens): void {
      if (!config.googleOAuthClientId || !config.googleOAuthClientSecret) {
        throw new FillerError(
          'backend_not_configured',
          'OAuth client ID and secret must be configured to use OAuth'
        );
      }

      const oauth2Client = new OAuth2Client(
        config.googleOAuthClientId,
        config.googleOAuthClientSecret
      );
      oauth2Client.setCredentials(tokens);

      // Set up token refresh handling
      oauth2Client.on('tokens', (newTokens) => {
        logger.info('oauth_tokens_refreshed', { expiry_date: newTokens.expiry_date });
        const updatedTokens: OAuthTokens = {
          access_token: newTokens.access_token!,
          refresh_token: newTokens.refresh_token || state.oauthTokens?.refresh_token,
          expiry_date: newTokens.expiry_date || undefined,
          token_type: newTokens.token_type || undefined,
          scope: newTokens.scope || undefined,
        };
        state.oauthTokens = updatedTokens;
        saveTokens(updatedTokens, state.oauthTokenPath);
      });

      state.oauthClient = oauth2Client;
      state.oauthTokens = tokens;
      state.authMethod = 'oauth';
      sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      // Save tokens to file
      saveTokens(tokens, state.oauthTokenPath);

      logger.info('oauth_tokens_set_at_runtime', { method: 'oauth' });
    },
  };

  return adapter;
}
