import type { SqlDatabase } from '../db/sqlite';

export const metaRepo = {
  get(db: SqlDatabase, key: string): string | null {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? row.value : null;
  },
  set(db: SqlDatabase, key: string, value: string): void {
    db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  },
  delete(db: SqlDatabase, key: string): void {
    db.run('DELETE FROM meta WHERE key = ?', [key]);
  },
  all(db: SqlDatabase): Record<string, string> {
    const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM meta ORDER BY key ASC');
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  },
};
