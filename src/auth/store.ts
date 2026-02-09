import Database from 'better-sqlite3';

/**
 * Open (or create) the SQLite database for OAuth persistence.
 * Creates `registered_clients` and `refresh_tokens` tables if they don't exist.
 */
export function openAuthDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS registered_clients (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

/**
 * A Map-compatible wrapper backed by a SQLite table.
 * Values are serialized as JSON TEXT.
 */
export class SqliteMap<V> {
  private stmtGet: Database.Statement;
  private stmtSet: Database.Statement;
  private stmtHas: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtClear: Database.Statement;
  private stmtCount: Database.Statement;

  constructor(
    private db: Database.Database,
    private tableName: string,
  ) {
    this.stmtGet = db.prepare(`SELECT value FROM ${tableName} WHERE key = ?`);
    this.stmtSet = db.prepare(
      `INSERT OR REPLACE INTO ${tableName} (key, value) VALUES (?, ?)`,
    );
    this.stmtHas = db.prepare(
      `SELECT 1 FROM ${tableName} WHERE key = ? LIMIT 1`,
    );
    this.stmtDelete = db.prepare(`DELETE FROM ${tableName} WHERE key = ?`);
    this.stmtClear = db.prepare(`DELETE FROM ${tableName}`);
    this.stmtCount = db.prepare(
      `SELECT COUNT(*) AS cnt FROM ${tableName}`,
    );
  }

  get(key: string): V | undefined {
    const row = this.stmtGet.get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as V) : undefined;
  }

  set(key: string, value: V): this {
    this.stmtSet.run(key, JSON.stringify(value));
    return this;
  }

  has(key: string): boolean {
    return this.stmtHas.get(key) !== undefined;
  }

  delete(key: string): boolean {
    const result = this.stmtDelete.run(key);
    return result.changes > 0;
  }

  clear(): void {
    this.stmtClear.run();
  }

  get size(): number {
    const row = this.stmtCount.get() as { cnt: number };
    return row.cnt;
  }
}
