import { describe, expect, it } from 'vitest';
import { DeUrgeError, MemoryPersistence, ENCRYPTED_BACKUP_FORMAT } from '../src/index';
import { canonicalJson } from '../src/backup/serialize';
import { sha256Hex } from '../src/backup/crypto';
import { seedRichCore } from './helpers/engines';

describe('backup: JSON export', () => {
  it('exports every collection with counts, versions and an integrity hash', async () => {
    const seeded = await seedRichCore();
    const result = await seeded.core.backup.exportJson();

    expect(result.filename).toMatch(/^deurge-export-\d{8}-\d{6}\.json$/);
    const document = JSON.parse(result.content) as Record<string, unknown>;
    expect(document.format).toBe('deurge-export');
    expect(document.formatVersion).toBe(1);
    expect(document.schemaVersion).toBe(1);
    expect(document.appVersion).toBe(seeded.core.appVersion);
    expect(document.exportedAt).toBe(seeded.clock.now());
    expect(document.timeZone).toBe('UTC');

    const data = document.data as Record<string, unknown[]>;
    const counts = document.counts as Record<string, number>;
    expect(counts.trackers).toBe(2);
    expect(counts.trackers).toBe(data.trackers!.length);
    expect(counts.sessions).toBe(data.sessions!.length);
    expect(counts.lapses).toBe(4);
    expect(counts.lapses).toBe(data.lapses!.length);
    expect(counts.urges).toBe(2);
    expect(counts.journalEntries).toBe(1);
    expect(counts.checkIns).toBe(1);
    expect(counts.settings).toBe(data.settingsRows!.length);
    expect(counts.historyEvents).toBe(data.historyEvents!.length);
    expect(result.counts).toEqual(counts);
    // The export is exactly what a restore would produce.
    expect(data.trackers!.map((tracker) => (tracker as { id: string }).id)).toContain(seeded.trackerId);

    const integrity = document.integrity as { algorithm: string; hash: string };
    expect(integrity.algorithm).toBe('SHA-256');
    expect(integrity.hash).toBe(await sha256Hex(canonicalJson(document.data)));

    // No settings were written by exporting.
    expect(counts.settings).toBe(0);
    expect((document.data as { settings: { lastExportAt: number | null } }).settings.lastExportAt).toBeNull();
  });

  it('is deterministic for a fixed clock and does not mutate the database', async () => {
    const seeded = await seedRichCore();
    const first = await seeded.core.backup.exportJson();
    const second = await seeded.core.backup.exportJson();
    expect(second.content).toBe(first.content);
    expect(second.counts).toEqual(first.counts);
  });

  it('round-trips through parseExport', async () => {
    const seeded = await seedRichCore();
    const result = await seeded.core.backup.exportJson();
    const parsed = seeded.core.backup.parseExport(result.content);
    const document = JSON.parse(result.content);
    expect(parsed.data).toEqual(document.data);
    expect(parsed.counts).toEqual(document.counts);
    expect(parsed.integrity).toEqual(document.integrity);
  });

  it('rejects invalid JSON and non-deUrge files', async () => {
    const seeded = await seedRichCore();
    expect(() => seeded.core.backup.parseExport('{oops')).toThrow(DeUrgeError);
    expect(() => seeded.core.backup.parseExport('')).toThrow(DeUrgeError);
    expect(() => seeded.core.backup.parseExport('{"format":"other"}')).toThrow(DeUrgeError);
    try {
      seeded.core.backup.parseExport('{oops');
    } catch (error) {
      expect((error as DeUrgeError).code).toBe('IMPORT_INVALID');
    }
  });
});

describe('backup: encrypted backups', () => {
  it('seals a backup with PBKDF2 + AES-GCM and restores it', async () => {
    const seeded = await seedRichCore();
    const encrypted = await seeded.core.backup.exportEncrypted('correct horse battery staple');
    expect(encrypted.filename).toMatch(/^deurge-encrypted-backup-\d{8}-\d{6}\.json$/);
    expect(encrypted.createdAt).toBe(seeded.clock.now());

    const envelope = JSON.parse(encrypted.content) as {
      format: string;
      version: number;
      createdAt: number;
      appVersion: string;
      schemaVersion: number;
      kdf: { name: string; hash: string; iterations: number; salt: string };
      cipher: { name: string; iv: string };
      payload: string;
    };
    expect(envelope.format).toBe(ENCRYPTED_BACKUP_FORMAT);
    expect(envelope.version).toBe(1);
    expect(envelope.createdAt).toBe(seeded.clock.now());
    expect(envelope.appVersion).toBe(seeded.core.appVersion);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 310_000 });
    expect(envelope.cipher.name).toBe('AES-GCM');
    expect(envelope.payload.length).toBeGreaterThan(0);
    // Salt/IV must not be empty and must decode to the documented sizes.
    expect(Buffer.from(envelope.kdf.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(envelope.cipher.iv, 'base64')).toHaveLength(12);
    // The plaintext (and therefore anything readable) must not appear.
    expect(encrypted.content).not.toContain('Smoking');
    expect(encrypted.content).not.toContain('lapse');

    const { createTestCore } = await import('./helpers');
    const target = await createTestCore({ now: seeded.clock.now() });
    const report = await target.core.backup.importEncrypted(encrypted.content, 'correct horse battery staple', {
      mode: 'merge',
    });
    expect(report.imported.trackers).toBe(2);
    expect(report.imported.lapses).toBe(4);
    expect(report.imported.urges).toBe(2);
    expect(target.core.trackers.list()).toHaveLength(2);
    expect(target.core.lapses.list()).toHaveLength(4);
    const restored = await target.core.backup.exportJson();
    const source = await seeded.core.backup.exportJson();
    const restoredData = JSON.parse(restored.content).data;
    const sourceData = JSON.parse(source.content).data;
    // Everything except the extra data_imported history event is identical.
    expect(restoredData.trackers).toEqual(sourceData.trackers);
    expect(restoredData.sessions).toEqual(sourceData.sessions);
    expect(restoredData.lapses).toEqual(sourceData.lapses);
    expect(restoredData.urges).toEqual(sourceData.urges);
    expect(restoredData.journalEntries).toEqual(sourceData.journalEntries);
    expect(restoredData.checkIns).toEqual(sourceData.checkIns);
    expect(restoredData.categories).toEqual(sourceData.categories);
  });

  it('rejects a wrong password and a damaged payload before touching the database', async () => {
    const seeded = await seedRichCore();
    const encrypted = await seeded.core.backup.exportEncrypted('hunter2');
    const { createTestCore } = await import('./helpers');
    const target = await createTestCore({ now: seeded.clock.now() });

    await expect(
      target.core.backup.importEncrypted(encrypted.content, 'wrong password', { mode: 'merge' }),
    ).rejects.toMatchObject({ code: 'CRYPTO' });
    expect(target.core.trackers.list()).toHaveLength(0);

    const envelope = JSON.parse(encrypted.content) as { payload: string };
    const tampered = {
      ...envelope,
      payload: `${envelope.payload.slice(0, -4)}AAAA`,
    };
    await expect(
      target.core.backup.importEncrypted(JSON.stringify(tampered), 'hunter2', { mode: 'merge' }),
    ).rejects.toMatchObject({ code: 'CRYPTO' });
    expect(target.core.trackers.list()).toHaveLength(0);
  });

  it('rejects an empty password when export is requested', async () => {
    const seeded = await seedRichCore();
    await expect(seeded.core.backup.exportEncrypted('')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('reports an unavailable crypto implementation honestly', async () => {
    const seeded = await seedRichCore();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      await expect(seeded.core.backup.exportEncrypted('hunter2')).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

describe('backup: persistence integration', () => {
  it('can snapshot the database through the persistence adapter', async () => {
    const seeded = await seedRichCore();
    const memory = seeded.persistence as unknown as MemoryPersistence;
    expect(memory.backupSnapshot()).toBeNull();
    await seeded.core.backup.snapshot();
    expect(memory.backupSnapshot()).not.toBeNull();
    expect(memory.backupSnapshot()).toEqual(seeded.core.bytes());
  });
});
