import type { Field, DataObject, SaveStatus } from '../types.js';

export interface StorageAdapter {
  listFields(names?: string[]): Promise<Field[]>;
  getFieldsByNames(names: string[]): Promise<Field[]>;
  addField(field: Field): Promise<void>;
  getObjectByName(name: string): Promise<DataObject | null>;
  listObjects(): Promise<DataObject[]>;
  addObjectByName(name: string): Promise<void>;
  updateObjectFields(name: string, values: Record<string, string>): Promise<void>;
  getFieldNames(): Promise<string[]>;
}

export type StorageBackend = 'sheets' | 'sqlite';

export interface StorageConfig {
  backend: StorageBackend;
  objectKeyField: string;
  // Sheets config
  googleSheetId?: string;
  sheetTabData?: string;
  sheetTabFields?: string;
  googleServiceAccountKey?: string; // JSON string or path to file
  // SQLite config
  sqlitePath?: string;
}

export function getConfigFromEnv(): StorageConfig {
  const backend = (process.env.STORAGE_BACKEND || 'sqlite') as StorageBackend;

  return {
    backend,
    objectKeyField: process.env.OBJECT_KEY_FIELD || 'name',
    // Sheets
    googleSheetId: process.env.GOOGLE_SHEET_ID,
    sheetTabData: process.env.SHEET_TAB_DATA || 'data',
    sheetTabFields: process.env.SHEET_TAB_FIELDS || 'fields',
    googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    // SQLite
    sqlitePath: process.env.SQLITE_PATH || 'data.db',
  };
}
