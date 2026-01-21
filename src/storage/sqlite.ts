import Database from 'better-sqlite3';
import type { StorageAdapter } from './adapter.js';
import type { Field, DataObject } from '../types.js';

export function createSqliteAdapter(dbPath: string, objectKeyField: string): StorageAdapter {
  const db = new Database(dbPath);

  // Initialize tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS fields (
      name TEXT PRIMARY KEY,
      description TEXT,
      auto INTEGER DEFAULT 0,
      instructions TEXT,
      type TEXT DEFAULT 'string',
      example TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS objects (
      name TEXT PRIMARY KEY,
      data_json TEXT DEFAULT '{}'
    )
  `);

  const adapter: StorageAdapter = {
    async listFields(names?: string[]): Promise<Field[]> {
      if (names && names.length > 0) {
        const placeholders = names.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT * FROM fields WHERE name IN (${placeholders})`)
          .all(...names) as Array<{
          name: string;
          description: string | null;
          auto: number;
          instructions: string | null;
          type: string | null;
          example: string | null;
        }>;
        return rows.map(rowToField);
      }
      const rows = db.prepare('SELECT * FROM fields').all() as Array<{
        name: string;
        description: string | null;
        auto: number;
        instructions: string | null;
        type: string | null;
        example: string | null;
      }>;
      return rows.map(rowToField);
    },

    async getFieldsByNames(names: string[]): Promise<Field[]> {
      if (names.length === 0) return [];
      const placeholders = names.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT * FROM fields WHERE name IN (${placeholders})`)
        .all(...names) as Array<{
        name: string;
        description: string | null;
        auto: number;
        instructions: string | null;
        type: string | null;
        example: string | null;
      }>;
      return rows.map(rowToField);
    },

    async addField(field: Field): Promise<void> {
      db.prepare(
        `INSERT INTO fields (name, description, auto, instructions, type, example)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        field.name,
        field.description ?? null,
        field.auto ? 1 : 0,
        field.instructions ?? null,
        field.type ?? 'string',
        field.example ?? null
      );
    },

    async getObjectByName(name: string): Promise<DataObject | null> {
      const row = db.prepare('SELECT * FROM objects WHERE name = ?').get(name) as
        | { name: string; data_json: string }
        | undefined;
      if (!row) return null;
      return {
        name: row.name,
        values: JSON.parse(row.data_json),
      };
    },

    async listObjects(): Promise<DataObject[]> {
      const rows = db.prepare('SELECT * FROM objects').all() as Array<{
        name: string;
        data_json: string;
      }>;
      return rows.map((row) => ({
        name: row.name,
        values: JSON.parse(row.data_json),
      }));
    },

    async addObjectByName(name: string): Promise<void> {
      db.prepare('INSERT INTO objects (name, data_json) VALUES (?, ?)').run(name, '{}');
    },

    async updateObjectFields(name: string, values: Record<string, string>): Promise<void> {
      const row = db.prepare('SELECT data_json FROM objects WHERE name = ?').get(name) as
        | { data_json: string }
        | undefined;
      if (!row) return;

      const current = JSON.parse(row.data_json);
      const updated = { ...current, ...values };
      db.prepare('UPDATE objects SET data_json = ? WHERE name = ?').run(
        JSON.stringify(updated),
        name
      );
    },

    async getFieldNames(): Promise<string[]> {
      const rows = db.prepare('SELECT name FROM fields').all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    },
  };

  return adapter;
}

function rowToField(row: {
  name: string;
  description: string | null;
  auto: number;
  instructions: string | null;
  type: string | null;
  example: string | null;
}): Field {
  return {
    name: row.name,
    description: row.description ?? undefined,
    auto: row.auto === 1,
    instructions: row.instructions ?? undefined,
    type: row.type ?? undefined,
    example: row.example ?? undefined,
  };
}
