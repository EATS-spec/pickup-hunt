import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/** Real SQLite behind the small D1 interface, including transactional batch. */
export function createTestD1({ path = ':memory:' } = {}) {
  const sqlite = new DatabaseSync(path);
  const migrations = new URL('../../drizzle/', import.meta.url);
  for (const filename of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(filename, migrations), 'utf8'));
  }
  const db = {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...input) { values = input; return this; },
        async first(column) { const result = statement.get(...values) ?? null; return column && result ? result[column] : result; },
        async all() { return { success: true, results: statement.all(...values) }; },
        _run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
        async run() { return this._run(); },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement._run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close() { sqlite.close(); },
  };
  return db;
}
