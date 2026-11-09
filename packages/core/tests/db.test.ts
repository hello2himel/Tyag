import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, currentSchemaVersion, newId, type SqlDatabase } from '../src/index';
import { createTestCore, reopenTestCore, DAY, T0 } from './helpers';

function expectThrows(fn: () => unknown): void {
  expect(fn).toThrow();
}

describe('SQLite schema and migrations', () => {
  it('creates schema version 1 and reports integrity', async () => {
    const { core } = await createTestCore();
    expect(currentSchemaVersion(core.db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
    expect(core.checkIntegrity()).toBe('ok');
    const migrations = core.db.all<{ version: number; name: string }>('SELECT version, name FROM schema_migrations');
    expect(migrations).toEqual([{ version: 1, name: 'initial' }]);
  });

  it('is idempotent across restarts', async () => {
    const test = await createTestCore();
    await test.core.trackers.create({ name: 'X' });
    test.core.close();
    const reopened = await reopenTestCore(test);
    expect(currentSchemaVersion(reopened.core.db)).toBe(1);
    expect(reopened.core.trackers.list()).toHaveLength(1);
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
    const { DeUrgeCore, MemoryPersistence, loadSqlJs } = await import('../src/index');
    const SQL = await loadSqlJs();
    // loadSqlJs without wasmBinary does not work in Node; use the cached wasm from helpers.
    void SQL;
    expect(bytes.length).toBeGreaterThan(0);
    const reimport = await (async () => {
      const { loadSqlWasm } = await import('./helpers');
      const SQL2 = await loadSqlWasm();
      const persistence = new MemoryPersistence(bytes);
      return DeUrgeCore.open({ SQL: SQL2, persistence, clock });
    })();
    expect(reimport.trackers.list()[0]?.name).toBe('Snapshot');
    expect(reimport.metrics(tracker.id).currentStreakMs).toBe(2 * DAY);
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
