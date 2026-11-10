/**
 * Export-file parsing, strict validation and schema migration.
 *
 * Validation happens entirely in memory before a single row is written, so a
 * malformed, tampered or truncated file can never touch the database. Every
 * check throws `IMPORT_INVALID` with a user-safe message; files created by a
 * newer app/schema throw `IMPORT_UNSUPPORTED_VERSION`.
 *
 * Schema migrations are a registry keyed by the *source* schema version:
 * `EXPORT_DATA_MIGRATIONS[1]` transforms schema v1 data into schema v2 data
 * (removing the tracker-category feature). Future releases append an entry
 * whenever `SCHEMA_VERSION` is bumped.
 */
import type {
  AppSettings,
  ApplicationSettingRow,
  CheckIn,
  CustomCategory,
  TyagExport,
  TyagExportData,
  ExportCounts,
  HistoryEvent,
  HistoryEventType,
  JournalEntry,
  LapseEvent,
  SessionStartKind,
  Tracker,
  TrackerSession,
  TrackerStatus,
  UrgeEvent,
  UrgeOutcome,
} from '../domain';
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
} from '../domain';
import { SCHEMA_VERSION } from '../db/migrations';
import { hydrateSettings } from '../settings/defaults';
import { isValidTimeZone } from '../time/temporal';
import { TyagError } from '../util/errors';

/* ------------------------------------------------------------------------- */
/* Migration registry                                                        */
/* ------------------------------------------------------------------------- */

/** Transform export data from schema version N into schema version N + 1. */
export type ExportDataMigration = (data: unknown) => unknown;

/**
 * Registry of forward data migrations. Add an entry when `SCHEMA_VERSION` in
 * `db/migrations.ts` is bumped.
 */
export const EXPORT_DATA_MIGRATIONS: Record<number, ExportDataMigration> = {};

/**
 * Schema v1 → v2: the tracker-category feature was removed from the product.
 * Drop `categoryId` from every tracker record and discard categories whose kind
 * is `tracker_category`. Trigger and reason categories are untouched.
 *
 * The transform works on unvalidated data (validation runs afterwards) and is
 * lenient with malformed shapes so the normal validators remain responsible
 * for rejecting them with their precise error messages.
 */
EXPORT_DATA_MIGRATIONS[1] = (data: unknown): unknown => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  const trackers = Array.isArray(record.trackers)
    ? record.trackers.map((tracker) => {
        if (!tracker || typeof tracker !== 'object' || Array.isArray(tracker)) return tracker;
        const copy = { ...(tracker as Record<string, unknown>) };
        delete copy.categoryId;
        return copy;
      })
    : record.trackers;
  const categories = Array.isArray(record.categories)
    ? record.categories.filter((category) => {
        if (!category || typeof category !== 'object' || Array.isArray(category)) return true;
        return (category as Record<string, unknown>).kind !== 'tracker_category';
      })
    : record.categories;
  return { ...record, trackers, categories };
};

/**
 * Original data of a parsed document that was migrated to the current schema.
 * Kept out of the document object so callers cannot accidentally re-export it;
 * import uses it to verify the integrity hash against the *source* data (the
 * hash is computed before migration by the exporting release).
 */
export interface ExportMigrationSource {
  schemaVersion: number;
  data: unknown;
}

const migrationSources = new WeakMap<TyagExport, ExportMigrationSource>();

/** Pre-migration source for a parsed document, when it was upconverted. */
export function exportMigrationSource(document: TyagExport): ExportMigrationSource | undefined {
  return migrationSources.get(document);
}

/**
 * Apply registered migrations to bring data from `fromVersion` up to
 * `toVersion`. Throws `IMPORT_UNSUPPORTED_VERSION` when a migration step is
 * missing (for example when importing a backup from a much older build).
 */
export function applyExportMigrations(data: unknown, fromVersion: number, toVersion: number): unknown {
  let current = data;
  let version = fromVersion;
  while (version < toVersion) {
    const migration = EXPORT_DATA_MIGRATIONS[version];
    if (!migration) {
      throw new TyagError(
        'IMPORT_UNSUPPORTED_VERSION',
        'This backup was created by an older version of Tyag that this release cannot migrate. Update the app or export again from the older version.',
      );
    }
    current = migration(current);
    version += 1;
  }
  return current;
}

/* ------------------------------------------------------------------------- */
/* Strict primitive validators                                               */
/* ------------------------------------------------------------------------- */

function invalid(message: string): never {
  throw new TyagError('IMPORT_INVALID', message);
}

function recordError(collection: string, index: number, field: string): never {
  invalid(`The backup contains an invalid ${collection} record (${field}) at position ${index + 1}.`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`The backup is missing valid ${label} data.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`The backup is missing the ${label} list.`);
  return value;
}

function readString(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  index: number,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  const value = record[field];
  if (typeof value !== 'string') recordError(collection, index, field);
  if (!options.allowEmpty && value.trim().length === 0) recordError(collection, index, field);
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    recordError(collection, index, field);
  }
  return value;
}

function readNullableString(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  index: number,
): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') recordError(collection, index, field);
  return value;
}

function readBoolean(record: Record<string, unknown>, field: string, collection: string, index: number): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') recordError(collection, index, field);
  return value;
}

function readNumber(record: Record<string, unknown>, field: string, collection: string, index: number): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) recordError(collection, index, field);
  return value;
}

function readInteger(record: Record<string, unknown>, field: string, collection: string, index: number): number {
  const value = readNumber(record, field, collection, index);
  if (!Number.isInteger(value)) recordError(collection, index, field);
  return value;
}

function readNullableInteger(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  index: number,
): number | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    recordError(collection, index, field);
  }
  return value;
}

/** Epoch milliseconds: an integer and not negative (pre-1970 never occurs). */
function readTimestamp(record: Record<string, unknown>, field: string, collection: string, index: number): number {
  const value = readInteger(record, field, collection, index);
  if (value < 0) recordError(collection, index, field);
  return value;
}

function readNullableTimestamp(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  index: number,
): number | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  const parsed = readInteger(record, field, collection, index);
  if (parsed < 0) recordError(collection, index, field);
  return parsed;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  index: number,
  allowed: readonly T[],
): T {
  const value = record[field];
  if (typeof value !== 'string' || !allowed.includes(value as T)) recordError(collection, index, field);
  return value as T;
}

function readTimeZone(record: Record<string, unknown>, field: string, collection: string, index: number): string {
  const value = readString(record, field, collection, index, { maxLength: 64 });
  if (!isValidTimeZone(value)) recordError(collection, index, field);
  return value;
}

function readOffsetMinutes(record: Record<string, unknown>, field: string, collection: string, index: number): number {
  const value = readInteger(record, field, collection, index);
  if (value < -14 * 60 || value > 14 * 60) recordError(collection, index, field);
  return value;
}

function readId(record: Record<string, unknown>, found: Set<string>, collection: string, index: number): string {
  const value = readString(record, 'id', collection, index, { maxLength: 200 });
  if (found.has(value)) {
    invalid(`The backup contains a duplicate ${collection} id.`);
  }
  found.add(value);
  return value;
}

const TRACKER_STATUSES: readonly TrackerStatus[] = ['active', 'paused', 'archived'];
const SESSION_START_KINDS: readonly SessionStartKind[] = ['created', 'resumed', 'imported', 'restored'];
const CATEGORY_KINDS = ['trigger', 'reason'] as const;
const URGE_OUTCOMES: readonly UrgeOutcome[] = ['passed', 'lapse', 'unknown'];
const HISTORY_TYPES: readonly HistoryEventType[] = [
  'tracker_created',
  'tracker_started',
  'tracker_updated',
  'tracker_paused',
  'tracker_resumed',
  'tracker_archived',
  'tracker_restored',
  'tracker_deleted',
  'lapse_recorded',
  'lapse_updated',
  'lapse_deleted',
  'urge_recorded',
  'urge_updated',
  'urge_deleted',
  'journal_entry_created',
  'journal_entry_updated',
  'journal_entry_deleted',
  'checkin_recorded',
  'checkin_deleted',
  'categories_updated',
  'settings_updated',
  'data_imported',
  'data_exported',
  'backup_restored',
];

/* ------------------------------------------------------------------------- */
/* Record validators                                                         */
/* ------------------------------------------------------------------------- */

function validateTrackers(value: unknown): Tracker[] {
  const rows = asArray(value, 'trackers');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'tracker');
    const tracker: Tracker = {
      id: readId(record, ids, 'tracker', index),
      name: readString(record, 'name', 'tracker', index, { maxLength: 120 }),
      description: readNullableString(record, 'description', 'tracker', index),
      status: readEnum(record, 'status', 'tracker', index, TRACKER_STATUSES),
      startedAt: readTimestamp(record, 'startedAt', 'tracker', index),
      startedTimeZone: readTimeZone(record, 'startedTimeZone', 'tracker', index),
      startedUtcOffsetMinutes: readOffsetMinutes(record, 'startedUtcOffsetMinutes', 'tracker', index),
      createdAt: readTimestamp(record, 'createdAt', 'tracker', index),
      updatedAt: readTimestamp(record, 'updatedAt', 'tracker', index),
      archivedAt: readNullableTimestamp(record, 'archivedAt', 'tracker', index),
      notes: readNullableString(record, 'notes', 'tracker', index),
      reasons: readNullableString(record, 'reasons', 'tracker', index),
      reminderEnabled: readBoolean(record, 'reminderEnabled', 'tracker', index),
      reminderIntervalMinutes: readNullableInteger(record, 'reminderIntervalMinutes', 'tracker', index),
    };
    if (tracker.reminderIntervalMinutes !== null && tracker.reminderIntervalMinutes < 60) {
      recordError('tracker', index, 'reminderIntervalMinutes');
    }
    return tracker;
  });
}

function validateSessions(value: unknown): TrackerSession[] {
  const rows = asArray(value, 'sessions');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'session');
    const session: TrackerSession = {
      id: readId(record, ids, 'session', index),
      trackerId: readString(record, 'trackerId', 'session', index, { maxLength: 200 }),
      startedAt: readTimestamp(record, 'startedAt', 'session', index),
      endedAt: readNullableTimestamp(record, 'endedAt', 'session', index),
      startKind: readEnum(record, 'startKind', 'session', index, SESSION_START_KINDS),
      createdAt: readTimestamp(record, 'createdAt', 'session', index),
      updatedAt: readTimestamp(record, 'updatedAt', 'session', index),
    };
    if (session.endedAt !== null && session.endedAt < session.startedAt) {
      recordError('session', index, 'endedAt');
    }
    return session;
  });
}

function validateLapses(value: unknown): LapseEvent[] {
  const rows = asArray(value, 'lapses');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'lapse');
    return {
      id: readId(record, ids, 'lapse', index),
      trackerId: readString(record, 'trackerId', 'lapse', index, { maxLength: 200 }),
      occurredAt: readTimestamp(record, 'occurredAt', 'lapse', index),
      occurredTimeZone: readTimeZone(record, 'occurredTimeZone', 'lapse', index),
      occurredUtcOffsetMinutes: readOffsetMinutes(record, 'occurredUtcOffsetMinutes', 'lapse', index),
      createdAt: readTimestamp(record, 'createdAt', 'lapse', index),
      updatedAt: readTimestamp(record, 'updatedAt', 'lapse', index),
      reason: readNullableString(record, 'reason', 'lapse', index),
      trigger: readNullableString(record, 'trigger', 'lapse', index),
      triggerCategoryId: readNullableString(record, 'triggerCategoryId', 'lapse', index),
      description: readNullableString(record, 'description', 'lapse', index),
      notes: readNullableString(record, 'notes', 'lapse', index),
      context: readNullableString(record, 'context', 'lapse', index),
      retrospective: readBoolean(record, 'retrospective', 'lapse', index),
    };
  });
}

function validateUrges(value: unknown): UrgeEvent[] {
  const rows = asArray(value, 'urges');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'urge');
    const urge: UrgeEvent = {
      id: readId(record, ids, 'urge', index),
      trackerId: readString(record, 'trackerId', 'urge', index, { maxLength: 200 }),
      occurredAt: readTimestamp(record, 'occurredAt', 'urge', index),
      occurredTimeZone: readTimeZone(record, 'occurredTimeZone', 'urge', index),
      occurredUtcOffsetMinutes: readOffsetMinutes(record, 'occurredUtcOffsetMinutes', 'urge', index),
      createdAt: readTimestamp(record, 'createdAt', 'urge', index),
      updatedAt: readTimestamp(record, 'updatedAt', 'urge', index),
      intensity: readInteger(record, 'intensity', 'urge', index),
      durationSeconds: readNullableInteger(record, 'durationSeconds', 'urge', index),
      trigger: readNullableString(record, 'trigger', 'urge', index),
      triggerCategoryId: readNullableString(record, 'triggerCategoryId', 'urge', index),
      context: readNullableString(record, 'context', 'urge', index),
      notes: readNullableString(record, 'notes', 'urge', index),
      outcome: readEnum(record, 'outcome', 'urge', index, URGE_OUTCOMES),
      retrospective: readBoolean(record, 'retrospective', 'urge', index),
    };
    if (urge.intensity < 1 || urge.intensity > 10) recordError('urge', index, 'intensity');
    if (urge.durationSeconds !== null && urge.durationSeconds < 0) {
      recordError('urge', index, 'durationSeconds');
    }
    return urge;
  });
}

function validateJournalEntries(value: unknown): JournalEntry[] {
  const rows = asArray(value, 'journalEntries');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'journal entry');
    return {
      id: readId(record, ids, 'journal entry', index),
      trackerId: (() => {
        const trackerId = readNullableString(record, 'trackerId', 'journal entry', index);
        return trackerId;
      })(),
      occurredAt: readTimestamp(record, 'occurredAt', 'journal entry', index),
      occurredTimeZone: readTimeZone(record, 'occurredTimeZone', 'journal entry', index),
      occurredUtcOffsetMinutes: readOffsetMinutes(record, 'occurredUtcOffsetMinutes', 'journal entry', index),
      createdAt: readTimestamp(record, 'createdAt', 'journal entry', index),
      updatedAt: readTimestamp(record, 'updatedAt', 'journal entry', index),
      title: readNullableString(record, 'title', 'journal entry', index),
      body: readString(record, 'body', 'journal entry', index, { allowEmpty: true, maxLength: 50_000 }),
    };
  });
}

function validateCheckIns(value: unknown): CheckIn[] {
  const rows = asArray(value, 'checkIns');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'check-in');
    const checkIn: CheckIn = {
      id: readId(record, ids, 'check-in', index),
      trackerId: readNullableString(record, 'trackerId', 'check-in', index),
      occurredAt: readTimestamp(record, 'occurredAt', 'check-in', index),
      occurredTimeZone: readTimeZone(record, 'occurredTimeZone', 'check-in', index),
      occurredUtcOffsetMinutes: readOffsetMinutes(record, 'occurredUtcOffsetMinutes', 'check-in', index),
      createdAt: readTimestamp(record, 'createdAt', 'check-in', index),
      mood: readNullableInteger(record, 'mood', 'check-in', index),
      note: readNullableString(record, 'note', 'check-in', index),
    };
    if (checkIn.mood !== null && (checkIn.mood < 1 || checkIn.mood > 5)) {
      recordError('check-in', index, 'mood');
    }
    return checkIn;
  });
}

function validateCategories(value: unknown): CustomCategory[] {
  const rows = asArray(value, 'categories');
  const ids = new Set<string>();
  const names = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'category');
    const category: CustomCategory = {
      id: readId(record, ids, 'category', index),
      kind: readEnum(record, 'kind', 'category', index, CATEGORY_KINDS),
      name: readString(record, 'name', 'category', index, { maxLength: 200 }),
      sortOrder: readInteger(record, 'sortOrder', 'category', index),
      isDefault: readBoolean(record, 'isDefault', 'category', index),
      archived: readBoolean(record, 'archived', 'category', index),
      createdAt: readTimestamp(record, 'createdAt', 'category', index),
      updatedAt: readTimestamp(record, 'updatedAt', 'category', index),
    };
    const nameKey = `${category.kind}\u0000${category.name.toLowerCase()}`;
    if (names.has(nameKey)) invalid('The backup contains two categories with the same name and kind.');
    names.add(nameKey);
    return category;
  });
}

function validateSettingsRows(value: unknown): ApplicationSettingRow[] {
  const rows = asArray(value, 'settingsRows');
  const keys = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'setting');
    const key = readString(record, 'key', 'setting', index, { maxLength: 200 });
    if (keys.has(key)) invalid('The backup contains a duplicate setting key.');
    keys.add(key);
    const valueText = readString(record, 'value', 'setting', index, { allowEmpty: true });
    try {
      JSON.parse(valueText);
    } catch {
      recordError('setting', index, 'value');
    }
    return {
      key,
      value: valueText,
      updatedAt: readTimestamp(record, 'updatedAt', 'setting', index),
    };
  });
}

function validateSettings(value: unknown): AppSettings {
  const record = asRecord(value, 'settings');
  const partial: Partial<AppSettings> = {};
  if (record.onboarded !== undefined) {
    if (typeof record.onboarded !== 'boolean') invalid('The backup contains invalid settings (onboarded).');
    partial.onboarded = record.onboarded;
  }
  if (record.theme !== undefined) {
    if (record.theme !== 'system' && record.theme !== 'light' && record.theme !== 'dark') {
      invalid('The backup contains invalid settings (theme).');
    }
    partial.theme = record.theme;
  }
  if (record.timeFormat !== undefined) {
    if (record.timeFormat !== '12h' && record.timeFormat !== '24h') {
      invalid('The backup contains invalid settings (timeFormat).');
    }
    partial.timeFormat = record.timeFormat;
  }
  if (record.dateFormat !== undefined) {
    const allowed = ['MMM d, yyyy', 'd MMM yyyy', 'MM/dd/yyyy', 'dd/MM/yyyy', 'yyyy-MM-dd'] as const;
    if (typeof record.dateFormat !== 'string' || !(allowed as readonly string[]).includes(record.dateFormat)) {
      invalid('The backup contains invalid settings (dateFormat).');
    }
    partial.dateFormat = record.dateFormat as AppSettings['dateFormat'];
  }
  if (record.firstDayOfWeek !== undefined) {
    if (record.firstDayOfWeek !== 0 && record.firstDayOfWeek !== 1) {
      invalid('The backup contains invalid settings (firstDayOfWeek).');
    }
    partial.firstDayOfWeek = record.firstDayOfWeek;
  }
  if (record.timeZoneMode !== undefined) {
    if (record.timeZoneMode !== 'device' && record.timeZoneMode !== 'fixed') {
      invalid('The backup contains invalid settings (timeZoneMode).');
    }
    partial.timeZoneMode = record.timeZoneMode;
  }
  if (record.fixedTimeZone !== undefined) {
    if (record.fixedTimeZone !== null) {
      if (typeof record.fixedTimeZone !== 'string' || !isValidTimeZone(record.fixedTimeZone)) {
        invalid('The backup contains invalid settings (fixedTimeZone).');
      }
    }
    partial.fixedTimeZone = record.fixedTimeZone as string | null;
  }
  if (record.durationFormat !== undefined) {
    if (
      record.durationFormat !== 'short' &&
      record.durationFormat !== 'long' &&
      record.durationFormat !== 'compact'
    ) {
      invalid('The backup contains invalid settings (durationFormat).');
    }
    partial.durationFormat = record.durationFormat;
  }
  if (record.notificationsEnabled !== undefined) {
    if (typeof record.notificationsEnabled !== 'boolean') {
      invalid('The backup contains invalid settings (notificationsEnabled).');
    }
    partial.notificationsEnabled = record.notificationsEnabled;
  }
  if (record.notificationIntervalMinutes !== undefined) {
    const value = record.notificationIntervalMinutes;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 60) {
      invalid('The backup contains invalid settings (notificationIntervalMinutes).');
    }
    partial.notificationIntervalMinutes = value;
  }
  if (record.exportPreference !== undefined) {
    if (record.exportPreference !== 'json' && record.exportPreference !== 'encrypted') {
      invalid('The backup contains invalid settings (exportPreference).');
    }
    partial.exportPreference = record.exportPreference;
  }
  if (record.defaultTriggerCategoryIds !== undefined) {
    const value = record.defaultTriggerCategoryIds;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      invalid('The backup contains invalid settings (defaultTriggerCategoryIds).');
    }
    partial.defaultTriggerCategoryIds = value as string[];
  }
  if (record.confirmDestructiveImports !== undefined) {
    if (typeof record.confirmDestructiveImports !== 'boolean') {
      invalid('The backup contains invalid settings (confirmDestructiveImports).');
    }
    partial.confirmDestructiveImports = record.confirmDestructiveImports;
  }
  if (record.lastExportAt !== undefined) {
    if (record.lastExportAt !== null) {
      if (typeof record.lastExportAt !== 'number' || !Number.isInteger(record.lastExportAt) || record.lastExportAt < 0) {
        invalid('The backup contains invalid settings (lastExportAt).');
      }
    }
    partial.lastExportAt = record.lastExportAt as number | null;
  }
  if (record.lastBackupAt !== undefined) {
    if (record.lastBackupAt !== null) {
      if (typeof record.lastBackupAt !== 'number' || !Number.isInteger(record.lastBackupAt) || record.lastBackupAt < 0) {
        invalid('The backup contains invalid settings (lastBackupAt).');
      }
    }
    partial.lastBackupAt = record.lastBackupAt as number | null;
  }
  return hydrateSettings(partial);
}

function validateHistoryEvents(value: unknown): HistoryEvent[] {
  const rows = asArray(value, 'historyEvents');
  const ids = new Set<string>();
  return rows.map((row, index) => {
    const record = asRecord(row, 'history event');
    const metadataValue = record.metadata;
    let metadata: Record<string, unknown> | null = null;
    if (metadataValue !== null && metadataValue !== undefined) {
      if (typeof metadataValue !== 'object' || Array.isArray(metadataValue)) {
        recordError('history event', index, 'metadata');
      }
      metadata = metadataValue as Record<string, unknown>;
    }
    return {
      id: readId(record, ids, 'history event', index),
      trackerId: readNullableString(record, 'trackerId', 'history event', index),
      type: readEnum(record, 'type', 'history event', index, HISTORY_TYPES),
      occurredAt: readTimestamp(record, 'occurredAt', 'history event', index),
      createdAt: readTimestamp(record, 'createdAt', 'history event', index),
      refId: readNullableString(record, 'refId', 'history event', index),
      metadata,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Document parsing                                                          */
/* ------------------------------------------------------------------------- */

/** Validate the current-shape export data object and return typed data. */
export function validateExportData(value: unknown): TyagExportData {
  const record = asRecord(value, 'export');
  return {
    trackers: validateTrackers(record.trackers),
    sessions: validateSessions(record.sessions),
    lapses: validateLapses(record.lapses),
    urges: validateUrges(record.urges),
    journalEntries: validateJournalEntries(record.journalEntries),
    checkIns: validateCheckIns(record.checkIns),
    categories: validateCategories(record.categories),
    settings: validateSettings(record.settings),
    settingsRows: validateSettingsRows(record.settingsRows),
    historyEvents: validateHistoryEvents(record.historyEvents),
  };
}

/** Counts that match already-validated export data. */
function countData(data: TyagExportData): ExportCounts {
  return {
    trackers: data.trackers.length,
    sessions: data.sessions.length,
    lapses: data.lapses.length,
    urges: data.urges.length,
    journalEntries: data.journalEntries.length,
    checkIns: data.checkIns.length,
    categories: data.categories.length,
    settings: data.settingsRows.length,
    historyEvents: data.historyEvents.length,
  };
}

/**
 * Counts of the *source* document before an export-data migration, used to
 * verify an older export's declared counts against what the file actually
 * contains. Safe to call after `validateExportData` has accepted the migrated
 * data: any non-array collection would already have been rejected.
 */
function countSourceData(value: unknown): ExportCounts {
  const record = asRecord(value, 'export');
  return {
    trackers: asArray(record.trackers, 'trackers').length,
    sessions: asArray(record.sessions, 'sessions').length,
    lapses: asArray(record.lapses, 'lapses').length,
    urges: asArray(record.urges, 'urges').length,
    journalEntries: asArray(record.journalEntries, 'journalEntries').length,
    checkIns: asArray(record.checkIns, 'checkIns').length,
    categories: asArray(record.categories, 'categories').length,
    settings: asArray(record.settingsRows, 'settingsRows').length,
    historyEvents: asArray(record.historyEvents, 'historyEvents').length,
  };
}

/** Verify that the file's declared counts match the expected counts. */
function validateCounts(value: unknown, expected: ExportCounts): void {
  const record = asRecord(value, 'counts');
  for (const [key, count] of Object.entries(expected) as [keyof ExportCounts, number][]) {
    const incoming = record[key];
    if (incoming !== count) {
      invalid('The backup file is inconsistent: its record counts do not match its data.');
    }
  }
}

function validateIntegrity(value: unknown): { algorithm: 'SHA-256'; hash: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, 'integrity');
  if (record.algorithm !== 'SHA-256') invalid('The backup uses an unsupported integrity algorithm.');
  if (typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(record.hash)) {
    invalid('The backup has an invalid integrity hash.');
  }
  return { algorithm: 'SHA-256', hash: record.hash.toLowerCase() };
}

/**
 * Parse and validate a JSON export string. Performs no database access and no
 * asynchronous work (integrity hashing is verified separately before import).
 */
export function parseExportDocument(text: string): TyagExport {
  if (typeof text !== 'string' || text.trim().length === 0) {
    invalid('This file is empty or is not a Tyag export.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid('This file is not valid JSON. Choose a Tyag JSON export.');
  }
  const record = asRecord(parsed, 'export');
  if (record.format !== EXPORT_FORMAT) {
    invalid('This file is not a Tyag export.');
  }
  const formatVersion = record.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    invalid('This backup has an invalid format version.');
  }
  if (formatVersion > EXPORT_FORMAT_VERSION) {
    throw new TyagError(
      'IMPORT_UNSUPPORTED_VERSION',
      'This export was created by a newer version of Tyag. Update the app before importing it.',
    );
  }
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    invalid('This backup has an invalid schema version.');
  }
  if (schemaVersion > SCHEMA_VERSION) {
    throw new TyagError(
      'IMPORT_UNSUPPORTED_VERSION',
      'This backup was created by a newer version of Tyag. Update the app before importing it.',
    );
  }
  const appVersion = record.appVersion;
  if (typeof appVersion !== 'string' || appVersion.trim().length === 0) {
    invalid('This backup is missing its app version.');
  }
  const exportedAt = record.exportedAt;
  if (typeof exportedAt !== 'number' || !Number.isFinite(exportedAt) || !Number.isInteger(exportedAt) || exportedAt < 0) {
    invalid('This backup has an invalid export timestamp.');
  }
  const timeZone = record.timeZone;
  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) {
    invalid('This backup has an invalid time zone.');
  }
  const integrity = validateIntegrity(record.integrity);

  const currentSchema = schemaVersion >= SCHEMA_VERSION;
  const migratedData = currentSchema
    ? record.data
    : applyExportMigrations(record.data, schemaVersion, SCHEMA_VERSION);
  const data = validateExportData(migratedData);
  if (currentSchema) {
    validateCounts(record.counts, countData(data));
  } else {
    // Older exports declared counts for their own shape (which may include
    // tracker categories); verify those, then report counts for the migrated
    // data so previews match what will actually be imported.
    validateCounts(record.counts, countSourceData(record.data));
  }
  const document: TyagExport = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion,
    exportedAt,
    timeZone,
    counts: countData(data),
    data,
    ...(integrity ? { integrity } : {}),
  };
  if (!currentSchema) migrationSources.set(document, { schemaVersion, data: record.data });
  return document;
}

/* ------------------------------------------------------------------------- */
/* Relationship validation                                                   */
/* ------------------------------------------------------------------------- */

/** Everything an import may legitimately reference. */
export interface KnownReferences {
  /** Tracker id -> commitment start, existing rows plus imported trackers. */
  trackerStartedAt: Map<string, number>;
  categoryIds: Set<string>;
}

export interface RelationshipValidationResult {
  warnings: string[];
}

/**
 * Validate cross-record references. Fatal problems (unknown tracker/category,
 * two open sessions for one tracker) throw `IMPORT_INVALID`; softer issues are
 * returned as user-safe warnings.
 */
export function validateImportRelationships(
  data: TyagExportData,
  known: KnownReferences,
): RelationshipValidationResult {
  const warnings: string[] = [];
  const requireTrackerRef = (trackerId: string | null, collection: string): void => {
    if (trackerId === null) return;
    if (!known.trackerStartedAt.has(trackerId)) {
      invalid(`The backup's ${collection} data references a tracker that is not included or already present.`);
    }
  };
  const requireCategoryRef = (categoryId: string | null, collection: string): void => {
    if (categoryId === null) return;
    if (!known.categoryIds.has(categoryId)) {
      invalid(`The backup's ${collection} data references a category that is not included or already present.`);
    }
  };

  for (const session of data.sessions) requireTrackerRef(session.trackerId, 'session');
  for (const lapse of data.lapses) requireTrackerRef(lapse.trackerId, 'lapse');
  for (const urge of data.urges) requireTrackerRef(urge.trackerId, 'urge');
  for (const entry of data.journalEntries) requireTrackerRef(entry.trackerId, 'journal');
  for (const checkIn of data.checkIns) requireTrackerRef(checkIn.trackerId, 'check-in');
  for (const event of data.historyEvents) requireTrackerRef(event.trackerId, 'history');

  for (const lapse of data.lapses) requireCategoryRef(lapse.triggerCategoryId, 'lapse');
  for (const urge of data.urges) requireCategoryRef(urge.triggerCategoryId, 'urge');

  const openSessions = new Map<string, number>();
  for (const session of data.sessions) {
    if (session.endedAt !== null) continue;
    const count = (openSessions.get(session.trackerId) ?? 0) + 1;
    if (count > 1) {
      invalid('The backup contains more than one open session for the same tracker.');
    }
    openSessions.set(session.trackerId, count);
  }

  const startFor = (trackerId: string | null): number | null => {
    if (trackerId === null) return null;
    const startedAt = known.trackerStartedAt.get(trackerId);
    return startedAt === undefined ? null : startedAt;
  };
  const checkNotBeforeStart = (
    at: number,
    trackerId: string | null,
    description: string,
    collection: string,
  ): void => {
    const startedAt = startFor(trackerId);
    if (startedAt !== null && at < startedAt) {
      warnings.push(
        `${description} in the backup's ${collection} data is earlier than the tracker start; it is preserved but never counted before the start.`,
      );
    }
  };
  for (const session of data.sessions) {
    checkNotBeforeStart(session.startedAt, session.trackerId, 'A session', 'session');
  }
  for (const lapse of data.lapses) {
    checkNotBeforeStart(lapse.occurredAt, lapse.trackerId, 'A lapse', 'lapse');
  }
  for (const urge of data.urges) {
    checkNotBeforeStart(urge.occurredAt, urge.trackerId, 'An urge', 'urge');
  }
  for (const checkIn of data.checkIns) {
    checkNotBeforeStart(checkIn.occurredAt, checkIn.trackerId, 'A check-in', 'check-in');
  }

  for (const categoryId of data.settings.defaultTriggerCategoryIds) {
    if (!known.categoryIds.has(categoryId)) {
      warnings.push('A default trigger category from the backup no longer exists; the preference keeps the id but the category is gone.');
    }
  }
  return { warnings };
}

/**
 * Build the known-reference set for a merge: existing rows plus the incoming
 * export. Imported tracker starts take precedence because validation applies
 * to the source data being imported.
 */
export function mergeKnownReferences(
  existing: { trackerStartedAt: Map<string, number>; categoryIds: Set<string> },
  data: TyagExportData,
): KnownReferences {
  const trackerStartedAt = new Map(existing.trackerStartedAt);
  for (const tracker of data.trackers) trackerStartedAt.set(tracker.id, tracker.startedAt);
  const categoryIds = new Set(existing.categoryIds);
  for (const category of data.categories) categoryIds.add(category.id);
  return { trackerStartedAt, categoryIds };
}

/** Known references for a replace import: only the incoming export counts. */
export function replaceKnownReferences(data: TyagExportData): KnownReferences {
  return {
    trackerStartedAt: new Map(data.trackers.map((tracker) => [tracker.id, tracker.startedAt])),
    categoryIds: new Set(data.categories.map((category) => category.id)),
  };
}
