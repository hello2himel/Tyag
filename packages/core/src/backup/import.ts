/**
 * Transactional import engine (merge and replace).
 *
 * Guarantees:
 *  - Validation and deep-equal comparison happen *before* the transaction, so
 *    a rejected import never writes anything.
 *  - All inserts happen inside ONE `db.transaction`, so an unexpected error
 *    rolls the whole import back and the existing database stays intact.
 *  - Merge never updates or deletes an existing row: an incoming record with a
 *    conflicting id is either skipped (default) or inserted under a brand-new
 *    id when `onConflict: 'keep-both'` is requested. Child references and
 *    history `refId`s follow re-keyed records.
 *  - Replace keeps a persistence snapshot (when the adapter supports one),
 *    requires explicit confirmation, and still runs inside one transaction.
 *  - Ids and timestamps are preserved exactly. Nothing is normalised except
 *    references that must follow a re-keyed record.
 */
import type {
  ApplicationSettingRow,
  CheckIn,
  CustomCategory,
  TyagExport,
  TyagExportData,
  HistoryEvent,
  ImportConflict,
  ImportReport,
  JournalEntry,
  LapseEvent,
  Tracker,
  TrackerSession,
  UrgeEvent,
} from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import type { CoreContext } from '../services/context';
import { appendHistory } from '../services/context';
import type { AllData } from '../services/data';
import { loadAllData } from '../services/data';
import { seedDefaultCategories } from '../settings/defaults';
import { TyagError } from '../util/errors';
import { newId } from '../util/ids';
import { categoryRepo } from '../repos/categories';
import { trackerRepo } from '../repos/trackers';
import { sessionRepo } from '../repos/sessions';
import { checkInRepo, journalRepo, lapseRepo, urgeRepo } from '../repos/events';
import { settingsRepo } from '../repos/settings';
import { historyRepo } from '../repos/history';
import { canonicalJson, summariseCounts } from './serialize';
import { sha256Hex } from './crypto';
import {
  exportMigrationSource,
  mergeKnownReferences,
  replaceKnownReferences,
  validateImportRelationships,
} from './schema';

export interface ImportOptions {
  mode: 'merge' | 'replace';
  /** What to do when an incoming id exists with different content. */
  onConflict?: 'skip' | 'keep-both';
  /** Explicit confirmation of a replace import. */
  confirmReplace?: boolean;
}

/** Collections reported in `ImportReport.imported`, in a stable order. */
const COLLECTION_KEYS = [
  'categories',
  'trackers',
  'sessions',
  'lapses',
  'urges',
  'journalEntries',
  'checkIns',
  'settings',
  'historyEvents',
] as const;

type CollectionKey = (typeof COLLECTION_KEYS)[number];

const CONFLICT_ID = 'id-conflict';
const CONFLICT_DUPLICATE_NAME = 'duplicate-name';
const CONFLICT_SETTINGS = 'settings-conflict';
const CONFLICT_OPEN_SESSION = 'open-session-conflict';

interface MergePlan {
  categories: CustomCategory[];
  trackers: Tracker[];
  sessions: TrackerSession[];
  lapses: LapseEvent[];
  urges: UrgeEvent[];
  journalEntries: JournalEntry[];
  checkIns: CheckIn[];
  settingsRows: ApplicationSettingRow[];
  historyEvents: HistoryEvent[];
  imported: Record<CollectionKey, number>;
  skippedDuplicates: number;
  conflicts: ImportConflict[];
  rekeyed: number;
  warnings: string[];
}

interface ExistingEntry<T> {
  record: T;
  canonical: string;
}

function indexById<T extends { id: string }>(records: T[]): Map<string, ExistingEntry<T>> {
  const map = new Map<string, ExistingEntry<T>>();
  for (const record of records) map.set(record.id, { record, canonical: canonicalJson(record) });
  return map;
}

function emptyImportedCounts(): Record<CollectionKey, number> {
  const counts = {} as Record<CollectionKey, number>;
  for (const key of COLLECTION_KEYS) counts[key] = 0;
  return counts;
}

function categoryNameKey(kind: string, name: string): string {
  return `${kind}\u0000${name.trim().toLowerCase()}`;
}

interface ResolvedRecord<T> {
  action: 'insert' | 'skip-duplicate' | 'skip-conflict' | 'rekey';
  record: T;
  oldId: string;
  newId: string | null;
}

/**
 * Decide what to do with one incoming record by id.
 *
 * `skip-duplicate` means an identical row (canonical JSON equality) already
 * exists; `skip-conflict` means the id exists with different content and the
 * caller chose not to keep both; `rekey` means the record must be inserted
 * under a new id (kept both).
 */
function resolveRecord<T extends { id: string }>(
  incoming: T,
  collection: string,
  existing: Map<string, ExistingEntry<T>>,
  keepBoth: boolean,
  conflicts: ImportConflict[],
  warnings: string[],
): ResolvedRecord<T> {
  const oldId = incoming.id;
  const match = existing.get(oldId);
  if (!match) {
    return { action: 'insert', record: incoming, oldId, newId: null };
  }
  if (match.canonical === canonicalJson(incoming)) {
    return { action: 'skip-duplicate', record: incoming, oldId, newId: null };
  }
  if (!keepBoth) {
    conflicts.push({ collection, id: oldId, reason: CONFLICT_ID });
    warnings.push(
      `An imported ${collection} record was not imported because a different record with the same id already exists. Existing data was not overwritten.`,
    );
    return { action: 'skip-conflict', record: incoming, oldId, newId: null };
  }
  const freshId = newId();
  warnings.push(
    `A ${collection} record with an existing id was imported as a new copy so the existing record is not overwritten.`,
  );
  return { action: 'rekey', record: { ...incoming, id: freshId }, oldId, newId: freshId };
}

function planMerge(existing: AllData, data: TyagExportData, keepBoth: boolean): MergePlan {
  const plan: MergePlan = {
    categories: [],
    trackers: [],
    sessions: [],
    lapses: [],
    urges: [],
    journalEntries: [],
    checkIns: [],
    settingsRows: [],
    historyEvents: [],
    imported: emptyImportedCounts(),
    skippedDuplicates: 0,
    conflicts: [],
    rekeyed: 0,
    warnings: [],
  };

  const categoryById = indexById(existing.categories);
  const categoryByName = new Map<string, CustomCategory>();
  for (const category of existing.categories) {
    categoryByName.set(categoryNameKey(category.kind, category.name), category);
  }
  const trackerById = indexById(existing.trackers);
  const sessionById = indexById(existing.sessions);
  const lapseById = indexById(existing.lapses);
  const urgeById = indexById(existing.urges);
  const journalById = indexById(existing.journalEntries);
  const checkInById = indexById(existing.checkIns);
  const historyById = indexById(existing.historyEvents);
  const settingsByKey = new Map(existing.settingsRows.map((row) => [row.key, row]));

  /** Existing or just-inserted open session per tracker id. */
  const openSessionByTracker = new Map<string, string>();
  for (const session of existing.sessions) {
    if (session.endedAt === null) openSessionByTracker.set(session.trackerId, session.id);
  }
  /** Tracker status by id after the tracker plan has been applied. */
  const trackerStatus = new Map<string, Tracker['status']>();
  for (const tracker of existing.trackers) trackerStatus.set(tracker.id, tracker.status);

  /** Old incoming id -> surviving id, per reference type. */
  const categoryIdMap = new Map<string, string>();
  const trackerIdMap = new Map<string, string>();
  const recordIdMap = new Map<string, string>();

  /* ------------------------------ categories ----------------------------- */
  for (const category of data.categories) {
    const nameKey = categoryNameKey(category.kind, category.name);
    const sameName = categoryByName.get(nameKey);
    if (sameName && sameName.id !== category.id) {
      // `UNIQUE(kind, name)` means the incoming category cannot be inserted
      // beside an existing one with the same name. Merging into the existing
      // category keeps event references valid without overwriting anything.
      categoryIdMap.set(category.id, sameName.id);
      plan.skippedDuplicates += 1;
      plan.conflicts.push({ collection: 'categories', id: category.id, reason: CONFLICT_DUPLICATE_NAME });
      plan.warnings.push(
        `Category "${category.name}" already exists with the same name; imported references were merged into it.`,
      );
      continue;
    }
    const idMatch = categoryById.get(category.id);
    if (idMatch) {
      if (idMatch.canonical === canonicalJson(category)) {
        plan.skippedDuplicates += 1;
        continue;
      }
      // Re-keying would collide on the unique (kind, name) pair, so a
      // category conflict is always skipped rather than duplicated.
      plan.conflicts.push({ collection: 'categories', id: category.id, reason: CONFLICT_ID });
      plan.skippedDuplicates += 1;
      plan.warnings.push(
        `Category "${category.name}" was not imported because a different category with the same id exists.`,
      );
      continue;
    }
    plan.categories.push(category);
    plan.imported.categories += 1;
  }

  /* ------------------------------- trackers ------------------------------ */
  for (const tracker of data.trackers) {
    const resolved = resolveRecord(tracker, 'trackers', trackerById, keepBoth, plan.conflicts, plan.warnings);
    if (resolved.action === 'insert' || resolved.action === 'rekey') {
      plan.trackers.push(resolved.record);
      trackerStatus.set(resolved.record.id, resolved.record.status);
      plan.imported.trackers += 1;
      if (resolved.action === 'rekey' && resolved.newId) {
        trackerIdMap.set(resolved.oldId, resolved.newId);
        plan.rekeyed += 1;
      }
    } else {
      plan.skippedDuplicates += 1;
    }
  }

  /* ------------------------------- sessions ------------------------------ */
  for (const session of data.sessions) {
    const remappedTrackerId = trackerIdMap.get(session.trackerId) ?? session.trackerId;
    const candidate: TrackerSession = { ...session, trackerId: remappedTrackerId };
    if (candidate.endedAt === null) {
      const open = openSessionByTracker.get(candidate.trackerId);
      if (open !== undefined) {
        // The DB has a partial unique index enforcing one open session per
        // tracker. Keep the existing session and report the incoming one; an
        // open session can never be re-keyed beside the existing open one.
        const match = sessionById.get(candidate.id);
        if (match && match.canonical === canonicalJson(candidate)) {
          plan.skippedDuplicates += 1;
        } else {
          plan.conflicts.push({ collection: 'sessions', id: candidate.id, reason: CONFLICT_OPEN_SESSION });
          plan.skippedDuplicates += 1;
          plan.warnings.push(
            'An imported open session was skipped because that tracker already has an open session.',
          );
        }
        continue;
      }
      // Never attach an open session to a paused or archived tracker: that
      // would make a non-running tracker accumulate active time.
      if (trackerStatus.get(candidate.trackerId) !== 'active') {
        plan.conflicts.push({ collection: 'sessions', id: candidate.id, reason: CONFLICT_OPEN_SESSION });
        plan.skippedDuplicates += 1;
        plan.warnings.push(
          'An imported open session was skipped because its tracker is paused or archived on this device.',
        );
        continue;
      }
    }
    const resolved = resolveRecord(
      candidate,
      'sessions',
      sessionById,
      keepBoth,
      plan.conflicts,
      plan.warnings,
    );
    if (resolved.action === 'insert' || resolved.action === 'rekey') {
      plan.sessions.push(resolved.record);
      plan.imported.sessions += 1;
      if (resolved.action === 'rekey') plan.rekeyed += 1;
      if (resolved.record.endedAt === null) {
        openSessionByTracker.set(resolved.record.trackerId, resolved.record.id);
      }
    } else {
      plan.skippedDuplicates += 1;
    }
  }

  /* -------------------------------- lapses ------------------------------- */
  const remapCategory = (categoryId: string | null): string | null =>
    categoryId === null ? null : categoryIdMap.get(categoryId) ?? categoryId;
  for (const lapse of data.lapses) {
    const candidate: LapseEvent = {
      ...lapse,
      trackerId: trackerIdMap.get(lapse.trackerId) ?? lapse.trackerId,
      triggerCategoryId: remapCategory(lapse.triggerCategoryId),
    };
    const resolved = resolveRecord(candidate, 'lapses', lapseById, keepBoth, plan.conflicts, plan.warnings);
    if (resolved.action === 'insert' || resolved.action === 'rekey') {
      plan.lapses.push(resolved.record);
      plan.imported.lapses += 1;
      if (resolved.action === 'rekey' && resolved.newId) {
        recordIdMap.set(resolved.oldId, resolved.newId);
        plan.rekeyed += 1;
      }
    } else {
      plan.skippedDuplicates += 1;
    }
  }

  /* -------------------------------- urges -------------------------------- */
  for (const urge of data.urges) {
    const candidate: UrgeEvent = {
      ...urge,
      trackerId: trackerIdMap.get(urge.trackerId) ?? urge.trackerId,
      triggerCategoryId: remapCategory(urge.triggerCategoryId),
    };
    const resolved = resolveRecord(candidate, 'urges', urgeById, keepBoth, plan.conflicts, plan.warnings);
    if (resolved.action === 'insert' || resolved.action === 'rekey') {
      plan.urges.push(resolved.record);
      plan.imported.urges += 1;
      if (resolved.action === 'rekey' && resolved.newId) {
        recordIdMap.set(resolved.oldId, resolved.newId);
        plan.rekeyed += 1;
      }
    } else {
      plan.skippedDuplicates += 1;
    }
  }

  /* ------------------------------- journal ------------------------------- */
  for (const entry of data.journalEntries) {
    const candidate: JournalEntry = {
      ...entry,
      trackerId: entry.trackerId === null ? null : trackerIdMap.get(entry.trackerId) ?? entry.trackerId,
    };
    const resolved = resolveRecord(candidate, 'journalEntries', journalById, keepBoth, plan.conflicts, plan.warnings);
    if (resolved.action === 'insert' || resolved.action === 'rekey') {
      plan.journalEntries.push(resolved.record);
      plan.imported.journalEntries += 1;
      if (resolved.action === 'rekey' && resolved.newId) {
        recordIdMap.set(resolved.oldId, resolved.newId);
        plan.rekeyed += 1;
      }
    } else {
      plan.skippedDuplicates += 1;
    }
  }

  /* ------------------------------- check-ins ----------------------------- */
  for (const checkIn of data.checkIns) {
    const candidate: CheckIn = {
      ...checkIn,
      trackerId:
        checkIn.trackerId === null ? null : trackerIdMap.get(checkIn.trackerId) ?? checkIn.trackerId,
    };
    const resolved = resolveRecord(candidate, 'checkIns', checkInById, keepBoth, plan.conflicts, plan.warnings);
    if (resolved.action === 'insert' || resolved.action === 'rekey') {
      plan.checkIns.push(resolved.record);
      plan.imported.checkIns += 1;
      if (resolved.action === 'rekey' && resolved.newId) {
        recordIdMap.set(resolved.oldId, resolved.newId);
        plan.rekeyed += 1;
      }
    } else {
      plan.skippedDuplicates += 1;
    }
  }

  /* ------------------------------- settings ------------------------------ */
  for (const row of data.settingsRows) {
    const existingRow = settingsByKey.get(row.key);
    if (existingRow) {
      if (existingRow.value === row.value) {
        plan.skippedDuplicates += 1;
      } else {
        plan.conflicts.push({ collection: 'settings', id: row.key, reason: CONFLICT_SETTINGS });
        plan.skippedDuplicates += 1;
        plan.warnings.push(
          'An imported setting was skipped because this device already has a different value for it.',
        );
      }
      continue;
    }
    plan.settingsRows.push(row);
    plan.imported.settings += 1;
  }

  /* ------------------------------- history ------------------------------- */
  for (const event of data.historyEvents) {
    const candidate: HistoryEvent = {
      ...event,
      trackerId: event.trackerId === null ? null : trackerIdMap.get(event.trackerId) ?? event.trackerId,
      refId: event.refId === null ? null : recordIdMap.get(event.refId) ?? event.refId,
    };
    const resolved = resolveRecord(
      candidate,
      'historyEvents',
      historyById,
      keepBoth,
      plan.conflicts,
      plan.warnings,
    );
    if (resolved.action === 'insert' || resolved.action === 'rekey') {
      plan.historyEvents.push(resolved.record);
      plan.imported.historyEvents += 1;
      if (resolved.action === 'rekey') plan.rekeyed += 1;
    } else {
      plan.skippedDuplicates += 1;
    }
  }

  return plan;
}

function planReplace(data: TyagExportData): MergePlan {
  return {
    categories: [...data.categories],
    trackers: [...data.trackers],
    sessions: [...data.sessions],
    lapses: [...data.lapses],
    urges: [...data.urges],
    journalEntries: [...data.journalEntries],
    checkIns: [...data.checkIns],
    settingsRows: [...data.settingsRows],
    historyEvents: [...data.historyEvents],
    imported: {
      categories: data.categories.length,
      trackers: data.trackers.length,
      sessions: data.sessions.length,
      lapses: data.lapses.length,
      urges: data.urges.length,
      journalEntries: data.journalEntries.length,
      checkIns: data.checkIns.length,
      settings: data.settingsRows.length,
      historyEvents: data.historyEvents.length,
    },
    skippedDuplicates: 0,
    conflicts: [],
    rekeyed: 0,
    warnings: [],
  };
}

/** Insert every planned row, preserving ids and timestamps exactly. */
function writePlan(db: SqlDatabase, plan: MergePlan, replace: boolean): void {
  if (replace) wipeDatabase(db);
  for (const category of plan.categories) categoryRepo.insert(db, category);
  for (const tracker of plan.trackers) trackerRepo.insert(db, tracker);
  for (const session of plan.sessions) sessionRepo.insert(db, session);
  for (const lapse of plan.lapses) lapseRepo.insert(db, lapse);
  for (const urge of plan.urges) urgeRepo.insert(db, urge);
  for (const entry of plan.journalEntries) journalRepo.insert(db, entry);
  for (const checkIn of plan.checkIns) checkInRepo.insert(db, checkIn);
  for (const row of plan.settingsRows) {
    settingsRepo.set(db, row.key, row.value, row.updatedAt);
  }
  for (const event of plan.historyEvents) historyRepo.insert(db, event);
}

/** Delete every user table in FK-safe order (inside the import transaction). */
function wipeDatabase(db: SqlDatabase): void {
  db.run('DELETE FROM history_events');
  db.run('DELETE FROM check_ins');
  db.run('DELETE FROM journal_entries');
  db.run('DELETE FROM urge_events');
  db.run('DELETE FROM lapse_events');
  db.run('DELETE FROM tracker_sessions');
  db.run('DELETE FROM trackers');
  db.run('DELETE FROM custom_categories');
  db.run('DELETE FROM application_settings');
}

function existingReferences(existing: AllData): {
  trackerStartedAt: Map<string, number>;
  categoryIds: Set<string>;
} {
  return {
    trackerStartedAt: new Map(existing.trackers.map((tracker) => [tracker.id, tracker.startedAt])),
    categoryIds: new Set(existing.categories.map((category) => category.id)),
  };
}

/**
 * Verify the SHA-256 integrity hash when the export carries one. A missing
 * hash is tolerated (older exports) and reported as a warning. When the
 * document was upconverted from an older schema, the hash covers the original
 * (pre-migration) data, so that is what must be hashed.
 */
async function verifyIntegrity(parsed: TyagExport, warnings: string[]): Promise<void> {
  if (!parsed.integrity) {
    warnings.push('This export has no integrity hash; it was validated structurally only.');
    return;
  }
  const expected = parsed.integrity.hash.toLowerCase();
  const source = exportMigrationSource(parsed);
  const actual = await sha256Hex(canonicalJson(source ? source.data : parsed.data));
  if (actual !== expected) {
    throw new TyagError(
      'IMPORT_INVALID',
      'This export failed its integrity check and may have been damaged or edited. Nothing was imported.',
    );
  }
}

export interface ExecuteImportOptions extends ImportOptions {
  /** Whether the persistence adapter supports snapshots (adds a warning if not). */
  supportsSnapshot: boolean;
}

/**
 * Validate the import against the current database, plan the writes, and apply
 * them in a single transaction. Returns a report; throws on any failure.
 */
export async function executeImport(
  ctx: CoreContext,
  parsed: TyagExport,
  options: ExecuteImportOptions,
  snapshot: () => Promise<void>,
): Promise<ImportReport> {
  const mode = options.mode;
  if (mode !== 'merge' && mode !== 'replace') {
    throw new TyagError('VALIDATION', 'Choose whether to merge or replace existing data.');
  }
  const onConflict = options.onConflict ?? 'skip';
  if (onConflict !== 'skip' && onConflict !== 'keep-both') {
    throw new TyagError('VALIDATION', 'Unknown import conflict behaviour.');
  }
  if (mode === 'replace' && options.confirmReplace !== true) {
    throw new TyagError(
      'VALIDATION',
      'Replacing all data must be confirmed first. Your current data can be restored from the automatic snapshot.',
    );
  }

  const warnings: string[] = [];
  const migration = exportMigrationSource(parsed);
  if (migration) {
    warnings.push(
      `This backup was created with schema version ${migration.schemaVersion} and was upgraded while importing. ` +
        'Tracker categories no longer exist in Tyag, so they were removed; every other record was imported unchanged.',
    );
  }
  await verifyIntegrity(parsed, warnings);

  const existing = loadAllData(ctx.db);
  const known =
    mode === 'merge'
      ? mergeKnownReferences(existingReferences(existing), parsed.data)
      : replaceKnownReferences(parsed.data);
  const relationship = validateImportRelationships(parsed.data, known);
  warnings.push(...relationship.warnings);

  const plan = mode === 'merge' ? planMerge(existing, parsed.data, onConflict === 'keep-both') : planReplace(parsed.data);
  warnings.push(...plan.warnings);

  if (mode === 'replace' && !options.supportsSnapshot) {
    warnings.push('No automatic pre-import snapshot is available on this platform.');
  }

  if (mode === 'replace') {
    // Snapshot before the destructive transaction; a failing snapshot aborts
    // the import instead of risking unrecoverable data loss.
    try {
      await snapshot();
    } catch {
      throw new TyagError(
        'DATABASE',
        'The import was cancelled because a safety snapshot could not be saved. Nothing was changed.',
      );
    }
  }

  try {
    ctx.db.transaction(() => {
      writePlan(ctx.db, plan, mode === 'replace');
      if (mode === 'replace') {
        // Keep the app invariant that built-in categories exist, without
        // touching any category that was part of the import.
        seedDefaultCategories(ctx.db, ctx.clock.now());
      }
      appendHistory(ctx, {
        trackerId: null,
        type: 'data_imported',
        occurredAt: ctx.clock.now(),
        metadata: {
          mode,
          summary: summariseCounts(plan.imported),
        },
      });
    });
  } catch (error) {
    if (error instanceof TyagError) throw error;
    throw new TyagError(
      'DATABASE',
      'The import could not be completed. Your existing data was left untouched.',
    );
  }
  try {
    await ctx.persist();
  } catch {
    throw new TyagError(
      'DATABASE',
      'The import was applied in memory but could not be saved to this device. Reopen the app and try again.',
    );
  }

  return {
    mode,
    imported: plan.imported,
    skippedDuplicates: plan.skippedDuplicates,
    conflicts: plan.conflicts,
    rekeyed: plan.rekeyed,
    warnings,
  };
}
