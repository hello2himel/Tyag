/**
 * Ordered schema migrations.
 *
 * Rules:
 *  - Migrations are append-only; never edit a shipped migration.
 *  - Each migration runs inside its own transaction and is recorded in
 *    `schema_migrations`, so re-running is a no-op.
 *  - Schema version 1 is the initial exportable format.
 */
import type { SqlDatabase } from './sqlite';

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );`,
      `CREATE TABLE trackers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        description TEXT,
        category_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
        started_at INTEGER NOT NULL,
        started_time_zone TEXT NOT NULL,
        started_utc_offset_minutes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        notes TEXT,
        reasons TEXT,
        reminder_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reminder_enabled IN (0,1)),
        reminder_interval_minutes INTEGER,
        CHECK (reminder_interval_minutes IS NULL OR reminder_interval_minutes >= 60)
      );`,
      `CREATE INDEX idx_trackers_status ON trackers(status);`,
      `CREATE TABLE tracker_sessions (
        id TEXT PRIMARY KEY,
        tracker_id TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        start_kind TEXT NOT NULL CHECK (start_kind IN ('created','resumed','imported','restored')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (ended_at IS NULL OR ended_at >= started_at)
      );`,
      `CREATE INDEX idx_sessions_tracker ON tracker_sessions(tracker_id, started_at);`,
      `CREATE UNIQUE INDEX ux_sessions_open ON tracker_sessions(tracker_id) WHERE ended_at IS NULL;`,
      `CREATE TABLE lapse_events (
        id TEXT PRIMARY KEY,
        tracker_id TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        occurred_at INTEGER NOT NULL,
        occurred_time_zone TEXT NOT NULL,
        occurred_utc_offset_minutes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reason TEXT,
        trigger TEXT,
        trigger_category_id TEXT,
        description TEXT,
        notes TEXT,
        context TEXT,
        retrospective INTEGER NOT NULL DEFAULT 0 CHECK (retrospective IN (0,1))
      );`,
      `CREATE INDEX idx_lapses_tracker ON lapse_events(tracker_id, occurred_at);`,
      `CREATE TABLE urge_events (
        id TEXT PRIMARY KEY,
        tracker_id TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        occurred_at INTEGER NOT NULL,
        occurred_time_zone TEXT NOT NULL,
        occurred_utc_offset_minutes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        intensity INTEGER NOT NULL CHECK (intensity BETWEEN 1 AND 10),
        duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
        trigger TEXT,
        trigger_category_id TEXT,
        context TEXT,
        notes TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('passed','lapse','unknown')),
        retrospective INTEGER NOT NULL DEFAULT 0 CHECK (retrospective IN (0,1))
      );`,
      `CREATE INDEX idx_urges_tracker ON urge_events(tracker_id, occurred_at);`,
      `CREATE TABLE journal_entries (
        id TEXT PRIMARY KEY,
        tracker_id TEXT REFERENCES trackers(id) ON DELETE SET NULL,
        occurred_at INTEGER NOT NULL,
        occurred_time_zone TEXT NOT NULL,
        occurred_utc_offset_minutes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        title TEXT,
        body TEXT NOT NULL
      );`,
      `CREATE INDEX idx_journal_tracker ON journal_entries(tracker_id, occurred_at);`,
      `CREATE TABLE check_ins (
        id TEXT PRIMARY KEY,
        tracker_id TEXT REFERENCES trackers(id) ON DELETE SET NULL,
        occurred_at INTEGER NOT NULL,
        occurred_time_zone TEXT NOT NULL,
        occurred_utc_offset_minutes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        note TEXT,
        mood INTEGER CHECK (mood IS NULL OR mood BETWEEN 1 AND 5)
      );`,
      `CREATE TABLE custom_categories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('trigger','reason','tracker_category')),
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (kind, name)
      );`,
      `CREATE TABLE application_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
      `CREATE TABLE history_events (
        id TEXT PRIMARY KEY,
        tracker_id TEXT REFERENCES trackers(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        ref_id TEXT,
        metadata TEXT
      );`,
      `CREATE INDEX idx_history_tracker ON history_events(tracker_id, occurred_at);`,
      `CREATE INDEX idx_history_type ON history_events(type);`,
    ],
  },
];

/** Apply all pending migrations. Returns the number of migrations applied. */
export function migrate(db: SqlDatabase, appliedAt: number): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);
  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version),
  );
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        appliedAt,
      ]);
    });
    count += 1;
  }
  return count;
}

export function currentSchemaVersion(db: SqlDatabase): number {
  const row = db.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
  return row?.version ? Number(row.version) : 0;
}
