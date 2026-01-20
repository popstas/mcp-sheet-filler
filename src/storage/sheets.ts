import { google, sheets_v4 } from 'googleapis';
import type { StorageAdapter, StorageConfig } from './adapter.js';
import type { Field, DataObject } from '../types.js';
import { FillerError } from '../types.js';
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
  if (!config.googleSheetId) {
    throw new FillerError('backend_not_configured', 'GOOGLE_SHEET_ID is required');
  }

  const spreadsheetId = config.googleSheetId;
  const fieldsTab = config.sheetTabFields || 'fields';
  const dataTab = config.sheetTabData || 'data';

  // Initialize Google Sheets API
  let auth: InstanceType<typeof google.auth.GoogleAuth>;

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
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    // Try Application Default Credentials
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  const sheets = google.sheets({ version: 'v4', auth });

  // Helper to get all rows from a sheet
  async function getSheetData(sheetName: string): Promise<string[][]> {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: sheetName,
      });
      return (response.data.values as string[][]) || [];
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

      return fields;
    },

    async getFieldsByNames(names: string[]): Promise<Field[]> {
      if (names.length === 0) return [];
      const allFields = await adapter.listFields();
      const nameSet = new Set(names);
      return allFields.filter((f) => nameSet.has(f.name));
    },

    async addField(field: Field): Promise<void> {
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
          spreadsheetId,
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
          spreadsheetId,
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
      if (data.length === 0) return null;

      const headers = data[0];
      if (headers.length === 0) return null;

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
          return { name, values };
        }
      }

      return null;
    },

    async addObjectByName(name: string): Promise<void> {
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
          spreadsheetId,
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

      // Update each field
      const updateData: { range: string; values: string[][] }[] = [];

      for (const [fieldName, value] of Object.entries(values)) {
        const colIndex = headers.indexOf(fieldName);
        if (colIndex === -1) continue;

        const colLetter = columnIndexToLetter(colIndex);
        updateData.push({
          range: `${dataTab}!${colLetter}${rowIndex}`,
          values: [[value]],
        });
      }

      if (updateData.length > 0) {
        try {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
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
  };

  return adapter;
}
