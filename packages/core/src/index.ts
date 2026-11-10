/**
 * Public API of @deurge/core.
 * UI code only needs this module; persistence/analytics/backup internals stay
 * behind the DeUrgeCore facade.
 */
export * from './domain';
export { DeUrgeCore, type CoreOpenOptions } from './core';
export { loadSqlJs, SqlDatabase, type LoadSqlJsOptions } from './db/sqlite';
export { SCHEMA_VERSION, MIGRATIONS, migrate, currentSchemaVersion } from './db/migrations';
export { MemoryPersistence, type PersistenceAdapter } from './persistence';
export { APP_NAME, APP_VERSION, APP_SLUG, APP_ID, REPOSITORY_URL } from './constants';
export { systemClock, fixedClock, type Clock } from './util/clock';
export { DeUrgeError, isDeUrgeError, userMessage, type DeUrgeErrorCode } from './util/errors';
export { newId, isUuid } from './util/ids';
export {
  splitDuration,
  formatDurationShort,
  formatDurationCompact,
  formatDurationLong,
  formatDurationFine,
  formatDurationIso,
} from './time/duration';
export {
  Temporal,
  MS_PER_SECOND,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
  isValidTimeZone,
  zonedAt,
  utcOffsetMinutesAt,
  localDateKey,
  localTimeKey,
  localHour,
  isoWeekday,
  weekdayIndex,
  startOfLocalDayMs,
  startOfLocalWeekMs,
  startOfLocalMonthMs,
  startOfLocalQuarterMs,
  startOfLocalYearMs,
  addLocalDaysMs,
  addLocalMonthsMs,
  toIsoUtc,
  fromIsoUtc,
} from './time/temporal';
export {
  formatDate,
  formatDateCompact,
  formatDateTime,
  formatDateParts,
  formatMonthLong,
  formatMonthShort,
  formatRelativeDateTime,
  formatTimeOfDay,
  formatTimelineDate,
  formatUtcOffset,
  formatWeekdayForFirstDay,
  formatWeekdayLong,
  formatWeekdayShort,
  isSameLocalDay,
} from './time/format';
export {
  enumeratePeriods,
  formatPeriodLabel,
  periodKeyFor,
  periodRange,
  startOfPeriodMs,
  addPeriodsMs,
  type PeriodRange,
} from './time/periods';
export {
  computeTrackerMetrics,
  buildActiveIntervals,
  currentStreakMs,
  type TrackerMetricsInput,
} from './engine/streak';
export { buildRecognition, type RecognitionOptions } from './engine/recognition';
export { DEFAULT_SETTINGS, DEFAULT_CATEGORIES, hydrateSettings, SETTINGS_KEYS, seedDefaultCategories } from './settings/defaults';
export { validateAppSettingsPatch, LIMITS } from './validation';
export {
  type TrackerBundle,
  type AllData,
  loadTrackerBundle,
  loadAllData,
  groupBy,
} from './services/data';
export { type HistoryFilter } from './domain';
export { type JournalFilter } from './services/journal';
export { AnalyticsService, type TrackerAnalyticsOptions, type CombinedAnalyticsOptions } from './analytics/service';
export { InsightsService } from './insights/service';
export { BackupService, type ImportOptions } from './backup/service';
export { SecurityService, PASSWORD_ITERATIONS, type AppLockConfig } from './services/security';
export {
  type ExportCounts,
  type JsonExportResult,
  type CsvExportResult,
  type EncryptedExportResult,
} from './domain';
