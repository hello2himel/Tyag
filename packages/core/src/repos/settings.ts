import type { AppSettings, ApplicationSettingRow } from '../domain';
import type { SqlDatabase } from '../db/sqlite';

export const settingsRepo = {
  /** Read the raw key/value rows (undeclared keys are preserved on save). */
  rows(db: SqlDatabase): ApplicationSettingRow[] {
    return db.all<{ key: string; value: string; updated_at: number }>(
      'SELECT key, value, updated_at FROM application_settings ORDER BY key ASC',
    ).map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  },
  get(db: SqlDatabase, key: string): string | null {
    const row = db.get<{ value: string }>('SELECT value FROM application_settings WHERE key = ?', [key]);
    return row ? row.value : null;
  },
  set(db: SqlDatabase, key: string, valueJson: string, updatedAt: number): void {
    db.run(
      `INSERT INTO application_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, valueJson, updatedAt],
    );
  },
  delete(db: SqlDatabase, key: string): void {
    db.run('DELETE FROM application_settings WHERE key = ?', [key]);
  },
  /** Load all settings; unknown keys are returned as-is so migrations can extend. */
  loadSettings(db: SqlDatabase, keys: (keyof AppSettings)[]): Partial<AppSettings> {
    const values: Partial<AppSettings> = {};
    for (const key of keys) {
      const raw = settingsRepo.get(db, key);
      if (raw === null) continue;
      try {
        (values as Record<string, unknown>)[key] = JSON.parse(raw);
      } catch {
        // Ignore corrupt setting values; defaults win and remain usable.
      }
    }
    return values;
  },
  saveSettings(db: SqlDatabase, settings: Partial<AppSettings>, updatedAt: number): void {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) continue;
      settingsRepo.set(db, key, JSON.stringify(value), updatedAt);
    }
  },
};
