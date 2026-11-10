import { describe, expect, it } from 'vitest';
import {
  DeUrgeCore,
  MIGRATIONS,
  MemoryPersistence,
  SCHEMA_VERSION,
  currentSchemaVersion,
  newId,
  type SqlDatabase,
} from '../src/index';
import { createTestCore, loadSqlWasm, reopenTestCore, DAY, T0 } from './helpers';

function expectThrows(fn: () => unknown): void {
  expect(fn).toThrow();
}

const V1_TRACKER_ID = 'v1-tracker';
const V1_ARCHIVED_TRACKER_ID = 'v1-tracker-2';
const V1_TRIGGER_CATEGORY_ID = 'v1-custom-trigger-commuting';
const V1_REASON_CATEGORY_ID = 'v1-custom-reason-focus';
const V1_DAY = DAY;

/**
 * Build a genuine schema-v1 SQLite snapshot: migration 1 only, a tracker with
 * `category_id`, `tracker_category` rows, and child records that must survive
 * the migration-2 table rebuild. This is the data an installed v1 app persists.
 */
async function createV1Snapshot(): Promise<Uint8Array> {
  const SQL = await loadSqlWasm();
  const raw = new SQL.Database();
  try {
    raw.run('PRAGMA foreign_keys = ON;');
    for (const statement of MIGRATIONS[0]!.statements) raw.exec(statement);
    raw.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );`);
    raw.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)', ['initial', T0]);

    raw.run(
      `INSERT INTO trackers (id, name, description, category_id, status, started_at, started_time_zone,
        started_utc_offset_minutes, created_at, updated_at, archived_at, notes, reasons,
        reminder_enabled, reminder_interval_minutes)
       VALUES (?, ?, ?, ?, 'active', ?, 'UTC', 0, ?, ?, NULL, ?, ?, 1, 1440)`,
      [
        V1_TRACKER_ID,
        'Old tracker',
        'from v1',
        'v1-tracker-category-digital',
        T0 - 10 * V1_DAY,
        T0 - 10 * V1_DAY,
        T0 - 10 * V1_DAY,
        'legacy notes',
        'legacy reasons',
      ],
    );
    raw.run(
      `INSERT INTO trackers (id, name, description, category_id, status, started_at, started_time_zone,
        started_utc_offset_minutes, created_at, updated_at, archived_at, notes, reasons,
        reminder_enabled, reminder_interval_minutes)
       VALUES (?, ?, NULL, NULL, 'archived', ?, 'UTC', 0, ?, ?, ?, NULL, NULL, 0, NULL)`,
      [V1_ARCHIVED_TRACKER_ID, 'Archived one', T0 - 20 * V1_DAY, T0 - 20 * V1_DAY, T0 - 20 * V1_DAY, T0 - V1_DAY],
    );

    raw.run(
      `INSERT INTO custom_categories (id, kind, name, sort_order, is_default, archived, created_at, updated_at)
       VALUES (?, 'tracker_category', 'Digital', 10, 1, 0, ?, ?),
              (?, 'trigger', 'Commuting', 5, 0, 0, ?, ?),
              (?, 'reason', 'Focus', 5, 0, 0, ?, ?),
              (?, 'tracker_category', 'Substances', 20, 1, 0, ?, ?)`,
      [
        'v1-tracker-category-digital',
        T0 - 30 * V1_DAY,
        T0 - 30 * V1_DAY,
        V1_TRIGGER_CATEGORY_ID,
        T0 - 5 * V1_DAY,
        T0 - 4 * V1_DAY,
        V1_REASON_CATEGORY_ID,
        T0 - 5 * V1_DAY,
        T0 - 4 * V1_DAY,
        'v1-tracker-category-substances',
        T0 - 30 * V1_DAY,
        T0 - 30 * V1_DAY,
      ],
    );

    raw.run(
      `INSERT INTO tracker_sessions (id, tracker_id, started_at, ended_at, start_kind, created_at, updated_at)
       VALUES ('v1-session', ?, ?, NULL, 'created', ?, ?)`,
      [V1_TRACKER_ID, T0 - 10 * V1_DAY, T0 - 10 * V1_DAY, T0 - 10 * V1_DAY],
    );
    raw.run(
      `INSERT INTO lapse_events (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
        created_at, updated_at, reason, trigger, trigger_category_id, description, notes, context, retrospective)
       VALUES ('v1-lapse', ?, ?, 'UTC', 0, ?, ?, 'Anxious', 'Commuting', ?, NULL, NULL, NULL, 0)`,
      [V1_TRACKER_ID, T0 - 5 * V1_DAY, T0 - 5 * V1_DAY, T0 - 5 * V1_DAY, V1_TRIGGER_CATEGORY_ID],
    );
    raw.run(
      `INSERT INTO urge_events (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
        created_at, updated_at, intensity, duration_seconds, trigger, trigger_category_id, context, notes,
        outcome, retrospective)
       VALUES ('v1-urge', ?, ?, 'UTC', 0, ?, ?, 5, NULL, 'Stress', NULL, NULL, NULL, 'passed', 0)`,
      [V1_TRACKER_ID, T0 - 4 * V1_DAY, T0 - 4 * V1_DAY, T0 - 4 * V1_DAY],
    );
    raw.run(
      `INSERT INTO journal_entries (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
        created_at, updated_at, title, body)
       VALUES ('v1-journal', ?, ?, 'UTC', 0, ?, ?, NULL, 'Old note')`,
      [V1_TRACKER_ID, T0 - 3 * V1_DAY, T0 - 3 * V1_DAY, T0 - 3 * V1_DAY],
    );
    raw.run(
      `INSERT INTO check_ins (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
        created_at, note, mood)
       VALUES ('v1-checkin', ?, ?, 'UTC', 0, ?, 'Steady', 3)`,
      [V1_TRACKER_ID, T0 - 2 * V1_DAY, T0 - 2 * V1_DAY],
    );
    raw.run(
      `INSERT INTO history_events (id, tracker_id, type, occurred_at, created_at, ref_id, metadata)
       VALUES ('v1-history', ?, 'tracker_created', ?, ?, NULL, '{"name":"Old tracker"}')`,
      [V1_TRACKER_ID, T0 - 10 * V1_DAY, T0 - 10 * V1_DAY],
    );
    raw.run(
      `INSERT INTO application_settings (key, value, updated_at) VALUES ('theme', '"dark"', ?)`,
      [T0 - V1_DAY],
    );
    return raw.export();
  } finally {
    raw.close();
  }
}

describe('SQLite schema and migrations', () => {
  it('creates schema version 2 and reports integrity', async () => {
    const { core } = await createTestCore();
    expect(currentSchemaVersion(core.db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(2);
    expect(core.checkIntegrity()).toBe('ok');
    expect(core.db.foreignKeyViolations()).toEqual([]);
    const migrations = core.db.all<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    );
    expect(migrations).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'remove-tracker-category' },
    ]);
  });

  it('has no tracker category columns on a fresh database', async () => {
    const { core } = await createTestCore();
    const trackerColumns = core.db
      .all<{ name: string }>("SELECT name FROM pragma_table_info('trackers')")
      .map((row) => row.name);
    expect(trackerColumns).not.toContain('category_id');
    const categorySql = core.db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'custom_categories'",
    );
    expect(categorySql?.sql).toContain("kind IN ('trigger','reason')");
    expectThrows(() =>
      core.db.run(
        `INSERT INTO custom_categories (id, kind, name, sort_order, is_default, archived, created_at, updated_at)
         VALUES (?, 'tracker_category', 'Digital', 0, 0, 0, ?, ?)`,
        [newId(), T0, T0],
      ),
    );
  });

  it('is idempotent across restarts', async () => {
    const test = await createTestCore();
    await test.core.trackers.create({ name: 'X' });
    test.core.close();
    const reopened = await reopenTestCore(test);
    expect(currentSchemaVersion(reopened.core.db)).toBe(2);
    expect(reopened.core.trackers.list()).toHaveLength(1);
    expect(reopened.core.db.foreignKeyViolations()).toEqual([]);
  });

  it('migrates a persisted v1 database without losing records', async () => {
    const bytes = await createV1Snapshot();
    const persistence = new MemoryPersistence(bytes);
    const test = await createTestCore({ now: T0, persistence });
    const { core } = test;

    // The migration ran once and recorded itself.
    expect(currentSchemaVersion(core.db)).toBe(2);
    expect(core.db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    expect(core.checkIntegrity()).toBe('ok');
    expect(core.db.foreignKeyViolations()).toEqual([]);

    // Trackers survive with every other column, id and timestamp intact.
    const trackers = core.trackers.list();
    expect(trackers).toHaveLength(2);
    const old = core.trackers.get(V1_TRACKER_ID);
    expect(old).toMatchObject({
      id: V1_TRACKER_ID,
      name: 'Old tracker',
      description: 'from v1',
      status: 'active',
      startedAt: T0 - 10 * V1_DAY,
      startedTimeZone: 'UTC',
      startedUtcOffsetMinutes: 0,
      createdAt: T0 - 10 * V1_DAY,
      updatedAt: T0 - 10 * V1_DAY,
      archivedAt: null,
      notes: 'legacy notes',
      reasons: 'legacy reasons',
      reminderEnabled: true,
      reminderIntervalMinutes: 1440,
    });
    expect(old).not.toHaveProperty('categoryId');
    expect(core.trackers.get(V1_ARCHIVED_TRACKER_ID).archivedAt).toBe(T0 - V1_DAY);

    // Child records were not cascade-deleted by the table rebuild.
    expect(core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tracker_sessions')?.n).toBe(1);
    expect(core.lapses.list(V1_TRACKER_ID)).toHaveLength(1);
    expect(core.urges.list(V1_TRACKER_ID)).toHaveLength(1);
    expect(core.journal.list({ trackerId: V1_TRACKER_ID })).toHaveLength(1);
    expect(core.checkIns.list(V1_TRACKER_ID)).toHaveLength(1);
    expect(core.history.list({ trackerId: V1_TRACKER_ID })).toHaveLength(1);
    expect(core.lapses.get('v1-lapse').triggerCategoryId).toBe(V1_TRIGGER_CATEGORY_ID);

    // Trigger/reason categories are preserved (ids and timestamps), while the
    // tracker-category rows are gone for good.
    const categories = core.categories.list(undefined, true);
    expect(categories.some((category) => (category.kind as string) === 'tracker_category')).toBe(false);
    const commuting = categories.find((category) => category.id === V1_TRIGGER_CATEGORY_ID);
    expect(commuting).toMatchObject({
      kind: 'trigger',
      name: 'Commuting',
      sortOrder: 5,
      isDefault: false,
      archived: false,
      createdAt: T0 - 5 * V1_DAY,
      updatedAt: T0 - 4 * V1_DAY,
    });
    expect(categories.some((category) => category.id === V1_REASON_CATEGORY_ID)).toBe(true);
    expect(categories.some((category) => category.id.startsWith('v1-tracker-category'))).toBe(false);

    // Other databases tables are untouched.
    expect(core.settings.get().theme).toBe('dark');

    // The migrated snapshot is persisted and reopens cleanly.
    test.core.close();
    const reopened = await reopenTestCore(test);
    expect(currentSchemaVersion(reopened.core.db)).toBe(2);
    expect(reopened.core.trackers.list()).toHaveLength(2);
    expect(reopened.core.trackers.get(V1_TRACKER_ID).name).toBe('Old tracker');
    expect(reopened.core.checkIntegrity()).toBe('ok');
    expect(reopened.core.db.foreignKeyViolations()).toEqual([]);
  });

  it('enforces foreign keys', async () => {
    const { core } = await createTestCore();
    expectThrows(() =>
      core.db.run(
        `INSERT INTO lapse_events (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
          created_at, updated_at, retrospective) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [newId(), 'missing-tracker', T0, 'UTC', 0, T0, T0],
      ),
    );
  });

  it('allows only one open session per tracker', async () => {
    const { core } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    expectThrows(() =>
      core.db.run(
        `INSERT INTO tracker_sessions (id, tracker_id, started_at, ended_at, start_kind, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'imported', ?, ?)`,
        [newId(), tracker.id, T0, T0, T0],
      ),
    );
  });

  it('cascades tracker deletion to sessions, events and tracker-scoped history', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(DAY);
    await core.lapses.create({ trackerId: tracker.id });
    core.db.run('DELETE FROM trackers WHERE id = ?', [tracker.id]);
    const count = (table: string): number =>
      core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tracker_id = ?`, [tracker.id])?.n ?? -1;
    expect(count('tracker_sessions')).toBe(0);
    expect(count('lapse_events')).toBe(0);
    expect(count('urge_events')).toBe(0);
    expect(count('history_events')).toBe(0);
  });

  it('stores timestamps as integers and enforces check constraints', async () => {
    const { core } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    const row = core.db.get<{ started_at: unknown; status: string }>('SELECT started_at, status FROM trackers WHERE id = ?', [
      tracker.id,
    ]);
    expect(typeof row?.started_at).toBe('number');
    expectThrows(() => core.db.run("UPDATE trackers SET status = 'deleted' WHERE id = ?", [tracker.id]));
    expectThrows(() =>
      core.db.run(
        `INSERT INTO urge_events (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
          created_at, updated_at, intensity, outcome, retrospective) VALUES (?, ?, ?, ?, ?, ?, ?, 11, 'passed', 0)`,
        [newId(), tracker.id, T0, 'UTC', 0, T0, T0],
      ),
    );
  });

  it('exported bytes can be reopened as a new database (snapshot portability)', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'Snapshot' });
    clock.advance(2 * DAY);
    const bytes = core.bytes();
    expect(bytes.length).toBeGreaterThan(0);
    const SQL2 = await loadSqlWasm();
    const persistence = new MemoryPersistence(bytes);
    const reimport = await DeUrgeCore.open({ SQL: SQL2, persistence, clock });
    expect(reimport.trackers.list()[0]?.name).toBe('Snapshot');
    expect(reimport.metrics(tracker.id).currentStreakMs).toBe(2 * DAY);
    expect(reimport.checkIntegrity()).toBe('ok');
    reimport.close();
  });

  it('keeps settings and categories after restart', async () => {
    const test = await createTestCore();
    await test.core.settings.update({ theme: 'dark', durationFormat: 'long' });
    await test.core.categories.create('trigger', 'Commuting');
    test.core.close();
    const reopened = await reopenTestCore(test);
    expect(reopened.core.settings.get().theme).toBe('dark');
    expect(reopened.core.settings.get().durationFormat).toBe('long');
    expect(reopened.core.categories.list('trigger').some((category) => category.name === 'Commuting')).toBe(true);
    expect(reopened.core.categories.list('trigger')).toHaveLength(10);
  });

  it('validates table constraints for names and categories', async () => {
    const { core } = await createTestCore();
    expectThrows(() =>
      core.db.run(
        `INSERT INTO trackers (id, name, status, started_at, started_time_zone, started_utc_offset_minutes,
          created_at, updated_at) VALUES (?, '   ', 'active', ?, 'UTC', 0, ?, ?)`,
        [newId(), T0, T0, T0],
      ),
    );
    expectThrows(() =>
      core.db.run(
        `INSERT INTO custom_categories (id, kind, name, sort_order, is_default, archived, created_at, updated_at)
         VALUES (?, 'nonsense', 'X', 0, 0, 0, ?, ?)`,
        [newId(), T0, T0],
      ),
    );
    void (null as SqlDatabase | null);
  });
});
