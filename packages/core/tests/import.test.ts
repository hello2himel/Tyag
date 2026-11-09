import { describe, expect, it } from 'vitest';
import { DeUrgeError, MemoryPersistence, SqlDatabase } from '../src/index';
import type { DeUrgeExport, ImportReport } from '../src/index';
import { EXPORT_DATA_MIGRATIONS, applyExportMigrations } from '../src/backup/schema';
import { createTestCore, type TestCore } from './helpers';
import { seedRichCore, type SeededCore } from './helpers/engines';

interface ExportedSource {
  seeded: SeededCore;
  document: DeUrgeExport;
  text: string;
}

async function exportSource(seeded: SeededCore): Promise<ExportedSource> {
  const result = await seeded.core.backup.exportJson();
  return { seeded, document: JSON.parse(result.content) as DeUrgeExport, text: result.content };
}

function mutateExport<T>(text: string, mutate: (document: DeUrgeExport) => T): { text: string; result: T } {
  const document = JSON.parse(text) as DeUrgeExport;
  const result = mutate(document);
  return { text: JSON.stringify(document), result };
}

function allImportedZero(report: ImportReport): void {
  for (const count of Object.values(report.imported)) expect(count).toBe(0);
}

function totalRecordCount(document: DeUrgeExport): number {
  return Object.values(document.counts).reduce((sum, count) => sum + count, 0);
}

/** Assert the target's exported data equals the source's, except import history. */
async function expectDataRestored(
  target: TestCore,
  source: ExportedSource,
  mode: 'merge' | 'replace',
): Promise<void> {
  const targetDocument = JSON.parse((await target.core.backup.exportJson()).content) as DeUrgeExport;
  expect(targetDocument.data.trackers).toEqual(source.document.data.trackers);
  expect(targetDocument.data.sessions).toEqual(source.document.data.sessions);
  expect(targetDocument.data.lapses).toEqual(source.document.data.lapses);
  expect(targetDocument.data.urges).toEqual(source.document.data.urges);
  expect(targetDocument.data.journalEntries).toEqual(source.document.data.journalEntries);
  expect(targetDocument.data.checkIns).toEqual(source.document.data.checkIns);
  expect(targetDocument.data.categories).toEqual(source.document.data.categories);
  expect(targetDocument.data.settingsRows).toEqual(source.document.data.settingsRows);
  const importedEvents = targetDocument.data.historyEvents.filter((event) => event.type === 'data_imported');
  expect(importedEvents).toHaveLength(1);
  expect(importedEvents[0]!.metadata).toMatchObject({ mode });
}

describe('import: merge round-trip', () => {
  it('restores every record with ids, timestamps and relationships intact', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });

    const report = await target.core.backup.importJson(source.text, { mode: 'merge' });
    expect(report.mode).toBe('merge');
    expect(report.conflicts).toEqual([]);
    expect(report.rekeyed).toBe(0);
    // Both cores were seeded with the same deterministic default categories,
    // so those are recognised as duplicates rather than re-inserted.
    expect(report.skippedDuplicates).toBe(source.document.data.categories.length);
    expect(report.imported).toMatchObject({
      trackers: 2,
      sessions: 2,
      lapses: 4,
      urges: 2,
      journalEntries: 1,
      checkIns: 1,
      categories: 0,
      settings: 0,
      historyEvents: source.document.data.historyEvents.length,
    });
    expect(report.warnings.every((warning) => typeof warning === 'string')).toBe(true);

    // Ids and timestamps preserved exactly.
    const tracker = target.core.trackers.get(source.seeded.trackerId);
    expect(tracker).toEqual(source.seeded.core.trackers.get(source.seeded.trackerId));
    expect(target.core.lapses.get(source.seeded.lapseIds[0]!)).toEqual(
      source.seeded.core.lapses.get(source.seeded.lapseIds[0]!),
    );
    expect(target.core.metrics(source.seeded.trackerId)).toEqual(
      source.seeded.core.metrics(source.seeded.trackerId),
    );
    expect(target.core.settings.get()).toEqual(source.seeded.core.settings.get());
    expect(target.core.trackers.list()).toHaveLength(2);

    // The database snapshot was persisted through the adapter.
    const memory = target.persistence as unknown as MemoryPersistence;
    expect(memory.saves).toBeGreaterThan(0);
    expect(memory.snapshot()).toEqual(target.core.bytes());

    await expectDataRestored(target, source, 'merge');
    const importedEvent = (
      JSON.parse((await target.core.backup.exportJson()).content) as DeUrgeExport
    ).data.historyEvents.find((event) => event.type === 'data_imported');
    expect(importedEvent?.metadata?.mode).toBe('merge');
    expect(typeof importedEvent?.metadata?.summary).toBe('string');
  });

  it('detects duplicates when the same export is imported twice', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    await target.core.backup.importJson(source.text, { mode: 'merge' });
    const second = await target.core.backup.importJson(source.text, { mode: 'merge' });
    allImportedZero(second);
    expect(second.skippedDuplicates).toBe(totalRecordCount(source.document));
    expect(second.conflicts).toEqual([]);
    expect(second.rekeyed).toBe(0);
  });
});

describe('import: merge conflicts never overwrite', () => {
  it('skips a differing record by default and reports the conflict', async () => {
    const seeded = await seedRichCore();
    const original = await exportSource(seeded);
    const target = await createTestCore({ now: seeded.clock.now() });
    await target.core.backup.importJson(original.text, { mode: 'merge' });

    await seeded.core.trackers.update(seeded.trackerId, { name: 'Smoking renamed' });
    const changed = await exportSource(seeded);
    const report = await target.core.backup.importJson(changed.text, { mode: 'merge' });

    expect(report.rekeyed).toBe(0);
    expect(report.conflicts).toContainEqual({
      collection: 'trackers',
      id: seeded.trackerId,
      reason: 'id-conflict',
    });
    expect(target.core.trackers.get(seeded.trackerId).name).toBe('Smoking');
    expect(report.warnings.some((warning) => warning.includes('not overwritten'))).toBe(true);
  });

  it('keeps both records and remaps ids, child references and history refIds', async () => {
    const seeded = await seedRichCore();
    const original = await exportSource(seeded);
    const target = await createTestCore({ now: seeded.clock.now() });
    await target.core.backup.importJson(original.text, { mode: 'merge' });

    await seeded.core.trackers.update(seeded.trackerId, { name: 'Smoking renamed' });
    const changed = await exportSource(seeded);
    const report = await target.core.backup.importJson(changed.text, {
      mode: 'merge',
      onConflict: 'keep-both',
    });

    expect(report.rekeyed).toBeGreaterThan(0);
    const trackers = target.core.trackers.list();
    expect(trackers).toHaveLength(3);
    const copy = trackers.find((tracker) => tracker.name === 'Smoking renamed');
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe(seeded.trackerId);
    // The original record was not overwritten.
    expect(target.core.trackers.get(seeded.trackerId).name).toBe('Smoking');

    const copyId = copy!.id;
    const copiedLapses = target.core.lapses.list(copyId);
    expect(copiedLapses).toHaveLength(3);
    const copiedLapseIds = new Set(copiedLapses.map((lapse) => lapse.id));
    expect(copiedLapseIds.size).toBe(3);
    // Original lapse ids still belong to the original tracker.
    for (const lapseId of seeded.lapseIds.slice(0, 3)) {
      expect(target.core.lapses.get(lapseId).trackerId).toBe(seeded.trackerId);
    }
    expect(target.core.urges.list(copyId)).toHaveLength(2);
    expect(target.core.journal.list({ trackerId: copyId })).toHaveLength(1);
    expect(target.core.checkIns.list(copyId)).toHaveLength(1);

    // Sessions follow the re-keyed tracker.
    const sessions = target.core.db.all<{ tracker_id: string }>(
      'SELECT tracker_id FROM tracker_sessions',
    );
    expect(sessions.some((session) => session.tracker_id === copyId)).toBe(true);

    // History for the copy points at the copy's records, not dangling ids.
    const copyHistory = target.core.history.list({ trackerId: copyId, limit: 500 });
    expect(copyHistory.length).toBeGreaterThan(0);
    expect(copyHistory.every((item) => item.event.trackerId === copyId)).toBe(true);
    const recorded = copyHistory.filter((item) => item.event.type === 'lapse_recorded');
    expect(recorded).toHaveLength(3);
    for (const item of recorded) expect(copiedLapseIds.has(item.event.refId!)).toBe(true);
    const journalEvents = copyHistory.filter((item) => item.event.type === 'journal_entry_created');
    expect(journalEvents).toHaveLength(1);
    expect(target.core.journal.get(journalEvents[0]!.event.refId!).trackerId).toBe(copyId);
  });

  it('imports settings rows into a fresh database', async () => {
    const seeded = await seedRichCore();
    await seeded.core.settings.update({ theme: 'dark', firstDayOfWeek: 1 });
    const source = await exportSource(seeded);
    const target = await createTestCore({ now: seeded.clock.now() });
    const report = await target.core.backup.importJson(source.text, { mode: 'merge' });
    expect(report.imported.settings).toBe(2);
    expect(target.core.settings.get().theme).toBe('dark');
    expect(target.core.settings.get().firstDayOfWeek).toBe(1);
  });

  it('never attaches an imported open session to a paused tracker', async () => {
    const seeded = await seedRichCore();
    const original = await exportSource(seeded);
    const target = await createTestCore({ now: seeded.clock.now() });
    await target.core.backup.importJson(original.text, { mode: 'merge' });
    // Pause the tracker on the target device, then import a source that is
    // still running for the same (now conflicting) tracker.
    await target.core.trackers.pause(seeded.trackerId);
    await seeded.core.trackers.update(seeded.trackerId, { name: 'Smoking renamed' });
    const changed = await exportSource(seeded);
    const activeBefore = target.core.metrics(seeded.trackerId).activeTrackedMs;
    const report = await target.core.backup.importJson(changed.text, { mode: 'merge' });

    const sessionConflict = report.conflicts.find((conflict) => conflict.collection === 'sessions');
    expect(sessionConflict).toEqual({
      collection: 'sessions',
      id: expect.any(String),
      reason: 'open-session-conflict',
    });
    expect(target.core.trackers.get(seeded.trackerId).status).toBe('paused');
    const openSessions = target.core.db.all<{ tracker_id: string }>(
      'SELECT tracker_id FROM tracker_sessions WHERE ended_at IS NULL',
    );
    expect(openSessions).toEqual([]);
    expect(target.core.metrics(seeded.trackerId).activeTrackedMs).toBe(activeBefore);
  });

  it('never overwrites settings and reports the conflict', async () => {
    const seeded = await seedRichCore();
    await seeded.core.settings.update({ theme: 'dark' });
    const source = await exportSource(seeded);
    const target = await createTestCore({ now: seeded.clock.now() });
    await target.core.settings.update({ theme: 'light' });
    const report = await target.core.backup.importJson(source.text, { mode: 'merge' });
    expect(report.conflicts).toContainEqual({ collection: 'settings', id: 'theme', reason: 'settings-conflict' });
    expect(target.core.settings.get().theme).toBe('light');
  });

  it('merges categories that collide by name instead of failing', async () => {
    const seeded = await seedRichCore();
    const sourceCategory = await seeded.core.categories.create('trigger', 'My custom trigger');
    const source = await exportSource(seeded);
    const target = await createTestCore({ now: seeded.clock.now() });
    const targetCategory = await target.core.categories.create('trigger', 'My custom trigger');
    const report = await target.core.backup.importJson(source.text, { mode: 'merge' });
    expect(sourceCategory.id).not.toBe(targetCategory.id);
    expect(report.conflicts).toContainEqual({
      collection: 'categories',
      id: sourceCategory.id,
      reason: 'duplicate-name',
    });
    const matching = target.core.categories
      .list('trigger', true)
      .filter((category) => category.name === 'My custom trigger');
    expect(matching).toHaveLength(1);
    expect(matching[0]!.id).toBe(targetCategory.id);
  });
});

describe('import: replace mode', () => {
  it('requires explicit confirmation and leaves the database untouched without it', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    await target.core.trackers.create({ name: 'Extra tracker', startedAt: source.seeded.clock.now() });
    const before = await target.core.backup.exportJson();

    await expect(target.core.backup.importJson(source.text, { mode: 'replace' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const after = await target.core.backup.exportJson();
    expect(after.content).toBe(before.content);
    expect(target.core.trackers.list()).toHaveLength(1);
  });

  it('snapshots, wipes and restores the incoming data in one transaction', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    await target.core.trackers.create({ name: 'Extra tracker', startedAt: source.seeded.clock.now() });
    const beforeBytes = target.core.bytes();
    const memory = target.persistence as unknown as MemoryPersistence;
    expect(memory.backupSnapshot()).toBeNull();

    const report = await target.core.backup.importJson(source.text, {
      mode: 'replace',
      confirmReplace: true,
    });
    expect(report.mode).toBe('replace');
    expect(report.conflicts).toEqual([]);
    expect(report.skippedDuplicates).toBe(0);
    expect(report.imported.trackers).toBe(2);

    // A recovery snapshot of the pre-import database exists.
    expect(memory.backupSnapshot()).toEqual(beforeBytes);
    expect(memory.snapshot()).toEqual(target.core.bytes());

    expect(target.core.trackers.list()).toHaveLength(2);
    expect(target.core.trackers.list().some((tracker) => tracker.name === 'Extra tracker')).toBe(false);
    await expectDataRestored(target, source, 'replace');
  });
});

describe('import: validation failures never write', () => {
  it('rejects invalid JSON', async () => {
    const target = await createTestCore({ now: Date.now() });
    await expect(target.core.backup.importJson('{ not json', { mode: 'merge' })).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
    expect(target.core.trackers.list()).toHaveLength(0);
  });

  it('rejects unsupported schema and format versions', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    for (const mutate of [
      (document: DeUrgeExport) => {
        document.schemaVersion = 99;
      },
      (document: DeUrgeExport) => {
        document.formatVersion = 99;
      },
    ]) {
      const { text } = mutateExport(source.text, mutate);
      await expect(target.core.backup.importJson(text, { mode: 'merge' })).rejects.toMatchObject({
        code: 'IMPORT_UNSUPPORTED_VERSION',
      });
    }
    expect(target.core.trackers.list()).toHaveLength(0);
  });

  it('rejects a corrupted record', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    const { text } = mutateExport(source.text, (document) => {
      (document.data.trackers[0] as unknown as { status: string }).status = 'super-active';
    });
    await expect(target.core.backup.importJson(text, { mode: 'merge' })).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
    expect(target.core.trackers.list()).toHaveLength(0);
  });

  it('rejects inconsistent record counts', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    const { text } = mutateExport(source.text, (document) => {
      document.data.trackers.pop();
    });
    await expect(target.core.backup.importJson(text, { mode: 'merge' })).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
  });

  it('rejects an export whose integrity hash no longer matches', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    const { text } = mutateExport(source.text, (document) => {
      document.data.trackers[0]!.name = 'Tampered name';
    });
    try {
      await target.core.backup.importJson(text, { mode: 'merge' });
      throw new Error('expected import to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DeUrgeError);
      expect((error as DeUrgeError).code).toBe('IMPORT_INVALID');
      expect((error as DeUrgeError).message).toContain('integrity');
    }
    expect(target.core.trackers.list()).toHaveLength(0);
  });

  it('rejects references to unknown trackers', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    const { text } = mutateExport(source.text, (document) => {
      const lapse = document.data.lapses[0]!;
      document.data.lapses.push({ ...lapse, id: 'orphan-lapse', trackerId: 'missing-tracker' });
      document.counts.lapses += 1;
      delete document.integrity;
    });
    await expect(target.core.backup.importJson(text, { mode: 'merge' })).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
    expect(target.core.trackers.list()).toHaveLength(0);
  });

  it('rejects duplicate ids inside one export', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    const { text } = mutateExport(source.text, (document) => {
      document.data.urges.push({ ...document.data.urges[0]! });
      document.counts.urges += 1;
      delete document.integrity;
    });
    await expect(target.core.backup.importJson(text, { mode: 'merge' })).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
    });
  });

  it('rolls back a mid-import database failure, leaving existing data intact', async () => {
    const source = await exportSource(await seedRichCore());
    const target = await createTestCore({ now: source.seeded.clock.now() });
    await target.core.trackers.create({ name: 'Existing', startedAt: source.seeded.clock.now() });
    const before = await target.core.backup.exportJson();

    const originalRun = SqlDatabase.prototype.run;
    SqlDatabase.prototype.run = function patchedRun(
      this: SqlDatabase,
      sql: string,
      params: Parameters<SqlDatabase['run']>[1] = [],
    ): void {
      if (sql.includes('INSERT INTO history_events')) throw new Error('simulated disk failure');
      originalRun.call(this, sql, params);
    };
    try {
      await expect(target.core.backup.importJson(source.text, { mode: 'merge' })).rejects.toMatchObject({
        code: 'DATABASE',
      });
    } finally {
      SqlDatabase.prototype.run = originalRun;
    }

    const after = await target.core.backup.exportJson();
    expect(after.content).toBe(before.content);
    expect(target.core.trackers.list()).toHaveLength(1);
    expect(target.core.trackers.list()[0]!.name).toBe('Existing');
    expect(target.core.checkIntegrity()).toBe('ok');
  });
});

describe('import: schema migration registry', () => {
  it('applies registered migrations and rejects a missing one', () => {
    const data = { marker: 'v2' };
    EXPORT_DATA_MIGRATIONS[2] = (input) => ({ ...(input as object), migrated: true });
    try {
      expect(applyExportMigrations(data, 2, 3)).toEqual({ marker: 'v2', migrated: true });
      expect(applyExportMigrations(data, 3, 3)).toBe(data);
    } finally {
      delete EXPORT_DATA_MIGRATIONS[2];
    }
    expect(() => applyExportMigrations(data, 2, 3)).toThrow(DeUrgeError);
    try {
      applyExportMigrations(data, 2, 3);
    } catch (error) {
      expect((error as DeUrgeError).code).toBe('IMPORT_UNSUPPORTED_VERSION');
    }
  });
});
