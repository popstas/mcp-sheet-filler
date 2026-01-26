import type { Field, DataObject, SaveStatus } from '../types.js';
import type { OAuthTokens } from '../auth/oauth.js';

export type AuthMethod = 'oauth' | 'service_account' | 'adc';

export interface AuthStatus {
  method: AuthMethod;
  email?: string;
}

export interface StorageAdapter {
  listFields(names?: string[]): Promise<Field[]>;
  getFieldsByNames(names: string[]): Promise<Field[]>;
  addField(field: Field): Promise<void>;
  getObjectByName(name: string): Promise<DataObject | null>;
  listObjects(): Promise<DataObject[]>;
  addObjectByName(name: string): Promise<void>;
  updateObjectFields(name: string, values: Record<string, string>): Promise<void>;
  getFieldNames(): Promise<string[]>;
  // Optional: only implemented by sheets adapter for dynamic sheet switching
  setSheetId?(idOrUrl: string): void;
  getSheetId?(): string;
  // Optional: only implemented by sheets adapter for auth status and OAuth
  getAuthStatus?(): AuthStatus;
  setOAuthTokens?(tokens: OAuthTokens): void;
  initSheet?(): Promise<{ fieldsTab: string; dataTab: string; keyField: string }>;
}

export interface StorageConfig {
  objectKeyField: string;
  // HTTP transport config
  resourceUrl?: string; // Public URL of this server (required for HTTP transport)
  // Sheets config
  googleSheetId?: string;
  sheetTabData?: string;
  sheetTabFields?: string;
  googleServiceAccountKey?: string; // JSON string or path to file
  // OAuth config
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
  googleOAuthTokenPath?: string; // default: ~/.config/mcp-sheet-filler/tokens.json
}

export function getConfigFromEnv(): StorageConfig {
  return {
    objectKeyField: process.env.OBJECT_KEY_FIELD || 'name',
    // HTTP transport
    resourceUrl: process.env.RESOURCE_URL,
    // Sheets
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    sheetTabData: process.env.SHEET_TAB_DATA || 'data',
    sheetTabFields: process.env.SHEET_TAB_FIELDS || 'fields',
    googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    // OAuth
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    googleOAuthTokenPath: process.env.GOOGLE_OAUTH_TOKEN_PATH,
  };
}
