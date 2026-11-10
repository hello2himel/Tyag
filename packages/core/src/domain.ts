/**
 * Tyag domain model.
 *
 * Every persisted record is described here. All timestamps are UTC epoch
 * milliseconds (`number`) so that they are timezone independent; the local
 * context that produced them (IANA zone + UTC offset) is stored alongside for
 * display and grouping. Derived values (streaks, statistics, insights) are
 * never stored — they are always recomputed from these records.
 */

export type Id = string;

/** Timestamps are UTC epoch milliseconds. */
export type Timestamp = number;

export type TrackerStatus = 'active' | 'paused' | 'archived';

export interface Tracker {
  id: Id;
  name: string;
  description: string | null;
  status: TrackerStatus;
  /** Original commitment start (can be backdated). */
  startedAt: Timestamp;
  /** IANA zone in which `startedAt` was entered (display context). */
  startedTimeZone: string;
  /** UTC offset (minutes east of UTC) at `startedAt` in that zone. */
  startedUtcOffsetMinutes: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
  notes: string | null;
  /** Personal reasons for starting this tracker. */
  reasons: string | null;
  reminderEnabled: boolean;
  reminderIntervalMinutes: number | null;
}

export type SessionStartKind = 'created' | 'resumed' | 'imported' | 'restored';

/**
 * A tracker session is a half-open active interval `[startedAt, endedAt)`.
 * Pausing closes the current session; resuming opens a new one. Every moment
 * of abstinence is measured inside these sessions, so paused time is always
 * excluded from streak calculations. A tracker has at most one open session.
 */
export interface TrackerSession {
  id: Id;
  trackerId: Id;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  startKind: SessionStartKind;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A lapse is an event in the historical record. It never erases progress. */
export interface LapseEvent {
  id: Id;
  trackerId: Id;
  occurredAt: Timestamp;
  occurredTimeZone: string;
  occurredUtcOffsetMinutes: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  reason: string | null;
  trigger: string | null;
  triggerCategoryId: Id | null;
  description: string | null;
  notes: string | null;
  context: string | null;
  /** True when the event was entered after the fact (recorded > 1h later). */
  retrospective: boolean;
}

export type UrgeOutcome = 'passed' | 'lapse' | 'unknown';

/** An urge/craving. Recorded independently of lapses and never resets a streak. */
export interface UrgeEvent {
  id: Id;
  trackerId: Id;
  occurredAt: Timestamp;
  occurredTimeZone: string;
  occurredUtcOffsetMinutes: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  intensity: number; // 1..10
  durationSeconds: number | null;
  trigger: string | null;
  triggerCategoryId: Id | null;
  context: string | null;
  notes: string | null;
  outcome: UrgeOutcome;
  retrospective: boolean;
}

export interface JournalEntry {
  id: Id;
  /** null = entry written in the global journal (not tied to one tracker). */
  trackerId: Id | null;
  occurredAt: Timestamp;
  occurredTimeZone: string;
  occurredUtcOffsetMinutes: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  title: string | null;
  body: string;
}

export interface CheckIn {
  id: Id;
  trackerId: Id | null;
  occurredAt: Timestamp;
  occurredTimeZone: string;
  occurredUtcOffsetMinutes: number;
  createdAt: Timestamp;
  note: string | null;
  mood: number | null; // 1..5, optional
}

export type CategoryKind = 'trigger' | 'reason';

export interface CustomCategory {
  id: Id;
  kind: CategoryKind;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  archived: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ApplicationSettingRow {
  key: string;
  value: string; // JSON encoded
  updatedAt: Timestamp;
}

export type HistoryEventType =
  | 'tracker_created'
  | 'tracker_started'
  | 'tracker_updated'
  | 'tracker_paused'
  | 'tracker_resumed'
  | 'tracker_archived'
  | 'tracker_restored'
  | 'tracker_deleted'
  | 'lapse_recorded'
  | 'lapse_updated'
  | 'lapse_deleted'
  | 'urge_recorded'
  | 'urge_updated'
  | 'urge_deleted'
  | 'journal_entry_created'
  | 'journal_entry_updated'
  | 'journal_entry_deleted'
  | 'checkin_recorded'
  | 'checkin_deleted'
  | 'categories_updated'
  | 'settings_updated'
  | 'data_imported'
  | 'data_exported'
  | 'backup_restored';

/** Append-only activity log: the canonical chronological history. */
export interface HistoryEvent {
  id: Id;
  /** null for global events (settings changed, import, tracker deleted). */
  trackerId: Id | null;
  type: HistoryEventType;
  /** When the real-world event happened (may be backdated). */
  occurredAt: Timestamp;
  /** When the record was written. */
  createdAt: Timestamp;
  /** Row id of the underlying record, when one exists. */
  refId: Id | null;
  /** Non-sensitive structured context (JSON). */
  metadata: Record<string, unknown> | null;
}

/* ------------------------------------------------------------------------- */
/* User-facing settings                                                      */
/* ------------------------------------------------------------------------- */

export type TimeFormat = '12h' | '24h';
export type DateFormat = 'MMM d, yyyy' | 'd MMM yyyy' | 'MM/dd/yyyy' | 'dd/MM/yyyy' | 'yyyy-MM-dd';
export type DurationFormat = 'short' | 'long' | 'compact';
export type ThemeSetting = 'system' | 'light' | 'dark';
export type TimeZoneMode = 'device' | 'fixed';
export type ExportPreference = 'json' | 'encrypted';

export interface AppSettings {
  /** First-run onboarding completed. */
  onboarded: boolean;
  theme: ThemeSetting;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  firstDayOfWeek: 0 | 1; // 0 = Sunday, 1 = Monday
  timeZoneMode: TimeZoneMode;
  fixedTimeZone: string | null;
  durationFormat: DurationFormat;
  notificationsEnabled: boolean;
  /** How often the optional local progress acknowledgement fires (minutes). */
  notificationIntervalMinutes: number;
  exportPreference: ExportPreference;
  /** Categories pre-selected in the record sheet (ids). */
  defaultTriggerCategoryIds: string[];
  /** Privacy/security: require confirmation before replace imports. Always true. */
  confirmDestructiveImports: boolean;
  /** Last time the user exported or backed up (metadata only). */
  lastExportAt: number | null;
  lastBackupAt: number | null;
}

/* ------------------------------------------------------------------------- */
/* Calculations                                                              */
/* ------------------------------------------------------------------------- */

export interface StreakInterval {
  /** Inclusive start. */
  startAt: Timestamp;
  /** Exclusive end (the lapse, or `now` for the current interval). */
  endAt: Timestamp;
  /** Active (non-paused) time inside the interval. */
  activeMs: number;
  /** True for the interval that is still running (ends at `now`). */
  isCurrent: boolean;
  /** The lapse event that closed this interval, if any. */
  endedByLapseId: Id | null;
}

export interface TrackerMetrics {
  trackerId: Id;
  status: TrackerStatus;
  now: Timestamp;
  /** Wall-clock time since the original commitment start. */
  elapsedSinceStartMs: number;
  /** Wall-clock time since the tracker record was created. */
  elapsedSinceCreatedMs: number;
  /** Sum of all active sessions (paused time excluded). */
  activeTrackedMs: number;
  /** Wall-clock time that elapsed while paused (within [startedAt, now]). */
  pausedMs: number;
  /** Current uninterrupted (active) streak. */
  currentStreakMs: number;
  /** When the current streak began (after the last lapse or at start). */
  currentStreakStartAt: Timestamp;
  /** Longest uninterrupted streak ever recorded. */
  longestStreakMs: number;
  longestStreak: StreakInterval | null;
  /** Total accumulated abstinence = all active, non-paused time. */
  accumulatedAbstinenceMs: number;
  completedAbstinenceMs: number;
  lapseCount: number;
  urgeCount: number;
  journalCount: number;
  lastLapseAt: Timestamp | null;
  /** Wall-clock time since the latest lapse (null if none). */
  timeSinceLastLapseMs: number | null;
  /** Every uninterrupted interval, oldest first (the last one is current). */
  intervals: StreakInterval[];
  /** Number of uninterrupted intervals observed (lapses + 1 when tracking). */
  streakCount: number;
  /** Average duration of an uninterrupted interval (active time). */
  averageStreakMs: number | null;
  /** Average active time between consecutive lapses (null with < 2 lapses). */
  averageBetweenLapsesMs: number | null;
  /** Median active time between consecutive lapses. */
  medianBetweenLapsesMs: number | null;
  /** accumulatedAbstinence / elapsedSinceStart, in [0,1]. */
  abstinenceShareOfElapsed: number | null;
  /** activeTracked / elapsedSinceStart, in [0,1]. */
  activeShareOfElapsed: number | null;
  /** Lapses per 7 days of active tracking. */
  lapsesPerActiveWeek: number | null;
  /** Lapses per calendar month (approximate; uses active tracking window). */
  lapsesPerActiveMonth: number | null;
  /** Recorded average urge intensity (1..10) or null. */
  averageUrgeIntensity: number | null;
  /** True if the tracker is currently running (status active). */
  isRunning: boolean;
}

export interface PeriodBucket {
  /** Local period key, e.g. 2026-11-10 / 2026-W46 / 2026-11 / 2026-Q4 / 2026. */
  key: string;
  startAt: Timestamp;
  endAt: Timestamp;
  lapseCount: number;
  urgeCount: number;
  journalCount: number;
  checkInCount: number;
  averageUrgeIntensity: number | null;
  /** Active tracking time overlapping the period (ms). */
  activeMs: number;
  /** Active abstinence time overlapping the period (ms). */
  abstinentMs: number;
}

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface CategoryCount {
  label: string;
  count: number;
}

export interface Distribution<T = string> {
  value: T;
  count: number;
  /** count / total, 0..1 */
  share: number;
}

export interface TrackerAnalytics {
  metrics: TrackerMetrics;
  periods: PeriodBucket[];
  lapseTriggers: CategoryCount[];
  lapseReasons: CategoryCount[];
  lapseContexts: CategoryCount[];
  weekdayCounts: Distribution<number>[]; // value 0..6 (0 = first day of week setting)
  hourCounts: Distribution<number>[]; // 0..23 local hour
  urgeTriggers: CategoryCount[];
  urgeOutcomes: Distribution<UrgeOutcome>[];
  journalDays: string[];
}

export interface CombinedAnalytics {
  trackerCount: number;
  activeTrackerCount: number;
  pausedTrackerCount: number;
  archivedTrackerCount: number;
  /** Sum of each tracker's accumulated abstinence (tracker-time). */
  totalAccumulatedAbstinenceMs: number;
  totalLapseCount: number;
  totalUrgeCount: number;
  averageUrgeIntensity: number | null;
  /** Data behind combined period charts. */
  periods: PeriodBucket[];
  lapseTriggers: CategoryCount[];
  weekdayCounts: Distribution<number>[];
  /** Per-tracker metrics used in the combined view. */
  trackers: TrackerMetrics[];
}

export interface Insight {
  id: string;
  /** Stable rule identifier. */
  rule: string;
  text: string;
  /** Period the statement refers to, human readable. */
  periodLabel: string;
  /** Number of records the statement is based on. */
  sampleSize: number;
  /** Caveat to show with the insight (correlation, low sample, ...). */
  caveat: string | null;
  /** True when the rule had enough data to make a claim. */
  meaningful: boolean;
}

export interface Recognition {
  /** Headline acknowledgement of the current streak. */
  headline: string;
  /** Additional sentence about accumulated progress. */
  accumulated: string | null;
  /** Current streak duration in ms used to generate the message. */
  currentStreakMs: number;
  accumulatedMs: number;
}

/* ------------------------------------------------------------------------- */
/* Inputs                                                                    */
/* ------------------------------------------------------------------------- */

export interface CreateTrackerInput {
  name: string;
  description?: string | null;
  startedAt?: Timestamp;
  startedTimeZone?: string;
  notes?: string | null;
  reasons?: string | null;
  reminderEnabled?: boolean;
  reminderIntervalMinutes?: number | null;
}

export interface UpdateTrackerInput {
  name?: string;
  description?: string | null;
  startedAt?: Timestamp;
  startedTimeZone?: string;
  notes?: string | null;
  reasons?: string | null;
  reminderEnabled?: boolean;
  reminderIntervalMinutes?: number | null;
}

export interface CreateLapseInput {
  trackerId: Id;
  occurredAt?: Timestamp;
  occurredTimeZone?: string;
  reason?: string | null;
  trigger?: string | null;
  triggerCategoryId?: string | null;
  description?: string | null;
  notes?: string | null;
  context?: string | null;
  retrospective?: boolean;
}

export interface UpdateLapseInput {
  occurredAt?: Timestamp;
  occurredTimeZone?: string;
  reason?: string | null;
  trigger?: string | null;
  triggerCategoryId?: string | null;
  description?: string | null;
  notes?: string | null;
  context?: string | null;
}

export interface CreateUrgeInput {
  trackerId: Id;
  occurredAt?: Timestamp;
  occurredTimeZone?: string;
  intensity?: number;
  durationSeconds?: number | null;
  trigger?: string | null;
  triggerCategoryId?: string | null;
  context?: string | null;
  notes?: string | null;
  outcome?: UrgeOutcome;
  retrospective?: boolean;
}

export interface UpdateUrgeInput {
  occurredAt?: Timestamp;
  occurredTimeZone?: string;
  intensity?: number;
  durationSeconds?: number | null;
  trigger?: string | null;
  triggerCategoryId?: string | null;
  context?: string | null;
  notes?: string | null;
  outcome?: UrgeOutcome;
}

export interface CreateJournalEntryInput {
  trackerId?: Id | null;
  occurredAt?: Timestamp;
  occurredTimeZone?: string;
  title?: string | null;
  body: string;
}

export interface UpdateJournalEntryInput {
  trackerId?: Id | null;
  occurredAt?: Timestamp;
  occurredTimeZone?: string;
  title?: string | null;
  body?: string;
}

export interface CreateCheckInInput {
  trackerId: Id;
  occurredAt?: Timestamp;
  occurredTimeZone?: string;
  note?: string | null;
  mood?: number | null;
}

export interface HistoryFilter {
  trackerId?: Id | null;
  types?: HistoryEventType[];
  from?: Timestamp;
  to?: Timestamp;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ImportConflict {
  collection: string;
  id: string;
  reason: string;
}

export interface ImportReport {
  mode: 'merge' | 'replace';
  imported: Record<string, number>;
  skippedDuplicates: number;
  conflicts: ImportConflict[];
  rekeyed: number;
  warnings: string[];
}

/* ------------------------------------------------------------------------- */
/* History presentation                                                      */
/* ------------------------------------------------------------------------- */

export interface HistoryItem {
  event: HistoryEvent;
  trackerName: string | null;
  /** Short label for the event kind ("Lapse", "Urge · 6/10", ...). */
  title: string;
  /** Supporting line (trigger, note excerpt, ...). */
  detail: string | null;
  refType: 'lapse' | 'urge' | 'journal' | 'checkin' | null;
}

/* ------------------------------------------------------------------------- */
/* Export / backup                                                           */
/* ------------------------------------------------------------------------- */

export const EXPORT_FORMAT = 'tyag-export';
export const EXPORT_FORMAT_VERSION = 1;
export const ENCRYPTED_BACKUP_FORMAT = 'tyag-encrypted-backup';

export interface ExportCounts {
  trackers: number;
  sessions: number;
  lapses: number;
  urges: number;
  journalEntries: number;
  checkIns: number;
  categories: number;
  settings: number;
  historyEvents: number;
}

export interface TyagExportData {
  trackers: Tracker[];
  sessions: TrackerSession[];
  lapses: LapseEvent[];
  urges: UrgeEvent[];
  journalEntries: JournalEntry[];
  checkIns: CheckIn[];
  categories: CustomCategory[];
  settings: AppSettings;
  settingsRows: ApplicationSettingRow[];
  historyEvents: HistoryEvent[];
}

export interface TyagExport {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  exportedAt: Timestamp;
  timeZone: string;
  counts: ExportCounts;
  data: TyagExportData;
  integrity?: { algorithm: 'SHA-256'; hash: string };
}

export interface EncryptedBackupEnvelope {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: number;
  createdAt: Timestamp;
  appVersion: string;
  schemaVersion: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  /** Base64 of the encrypted UTF-8 JSON payload. */
  payload: string;
}

export type CsvDataset =
  | 'trackers'
  | 'lapses'
  | 'urges'
  | 'journal'
  | 'daily-summary'
  | 'statistics';

export interface CsvExportOptions {
  /** IANA timezone used for local calendar columns (defaults to effective zone). */
  timeZone?: string;
  dateFormat?: DateFormat;
  timeFormat?: TimeFormat;
  firstDayOfWeek?: 0 | 1;
}

export interface JsonExportResult {
  filename: string;
  content: string;
  counts: ExportCounts;
}

export interface CsvExportResult {
  filename: string;
  content: string;
  rows: number;
}

export interface EncryptedExportResult {
  filename: string;
  content: string;
  createdAt: Timestamp;
}
