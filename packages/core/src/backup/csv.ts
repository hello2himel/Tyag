/**
 * RFC 4180 CSV export.
 *
 * Rules:
 *  - Header row on line 1, columns are stable snake_case names (documented in
 *    the column builders below).
 *  - CRLF line endings, UTF-8 encoding (no BOM), exactly one trailing CRLF.
 *  - Fields containing `,` `"` `\r` or `\n` are quoted; `"` is doubled.
 *  - Timestamps appear twice: a machine-readable ISO-8601 UTC column and a
 *    human-readable local column formatted with the user's zone/format.
 *  - `null` renders as an empty field; booleans render as `true`/`false`.
 *  - Row order is deterministic (chronological for events, repository order
 *    for trackers/statistics).
 */
import type {
  CsvDataset,
  CsvExportOptions,
  CsvExportResult,
  DateFormat,
  PeriodBucket,
  TimeFormat,
  TrackerMetrics,
} from '../domain';
import type { AllData } from '../services/data';
import { isValidTimeZone, toIsoUtc, zonedAt } from '../time/temporal';
import { formatDate, formatDateTime, formatTimeOfDay, formatWeekdayLong } from '../time/format';
import { exportFilename } from './serialize';
import { DeUrgeError } from '../util/errors';

/** Everything the CSV builders need, already loaded by the service. */
export interface CsvContext {
  data: AllData;
  now: number;
  effectiveTimeZone: string;
  /** Daily period buckets across all trackers (for `daily-summary`). */
  combinedDailyPeriods: PeriodBucket[];
  /** Per-tracker metrics in repository order (for `statistics`). */
  trackerMetrics: TrackerMetrics[];
}

interface ResolvedFormatting {
  timeZone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

function resolveFormatting(context: CsvContext, options: CsvExportOptions): ResolvedFormatting {
  const timeZone = options.timeZone ?? context.effectiveTimeZone;
  if (!isValidTimeZone(timeZone)) {
    throw new DeUrgeError('VALIDATION', 'Unknown time zone.');
  }
  return {
    timeZone,
    dateFormat: options.dateFormat ?? context.data.settings.dateFormat,
    timeFormat: options.timeFormat ?? context.data.settings.timeFormat,
  };
}

function nullableText(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function nullableNumber(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '' : String(value);
}

function booleanText(value: boolean): string {
  return value ? 'true' : 'false';
}

function fixedNumber(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

/** Quote one field per RFC 4180. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Serialise a header and row set to a CRLF-terminated CSV string. */
export function serialiseCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function timestampColumns(
  epochMs: number | null,
  formatting: ResolvedFormatting,
): [string, string] {
  if (epochMs === null) return ['', ''];
  return [
    toIsoUtc(epochMs),
    formatDateTime(epochMs, formatting.timeZone, formatting.dateFormat, formatting.timeFormat),
  ];
}

/** Local weekday name for a day period bucket (English, stable). */
function weekdayNameFor(bucket: PeriodBucket, timeZone: string): string {
  const isoDay = zonedAt(bucket.startAt, timeZone).dayOfWeek; // 1 = Monday .. 7 = Sunday
  return formatWeekdayLong(isoDay % 7);
}

function trackerNameMap(context: CsvContext): Map<string, string> {
  return new Map(context.data.trackers.map((tracker) => [tracker.id, tracker.name]));
}

/**
 * `trackers` columns:
 * id, name, description, category_id, status, started_at_utc,
 * started_at_local, started_time_zone, started_utc_offset_minutes,
 * created_at_utc, updated_at_utc, archived_at_utc, notes, reasons,
 * reminder_enabled, reminder_interval_minutes
 */
export const TRACKER_COLUMNS = [
  'id',
  'name',
  'description',
  'category_id',
  'status',
  'started_at_utc',
  'started_at_local',
  'started_time_zone',
  'started_utc_offset_minutes',
  'created_at_utc',
  'updated_at_utc',
  'archived_at_utc',
  'notes',
  'reasons',
  'reminder_enabled',
  'reminder_interval_minutes',
] as const;

/**
 * `lapses` columns:
 * id, tracker_id, tracker_name, occurred_at_utc, occurred_at_local,
 * occurred_time_zone, occurred_utc_offset_minutes, reason, trigger,
 * trigger_category_id, description, notes, context, retrospective,
 * created_at_utc, updated_at_utc
 */
export const LAPSE_COLUMNS = [
  'id',
  'tracker_id',
  'tracker_name',
  'occurred_at_utc',
  'occurred_at_local',
  'occurred_time_zone',
  'occurred_utc_offset_minutes',
  'reason',
  'trigger',
  'trigger_category_id',
  'description',
  'notes',
  'context',
  'retrospective',
  'created_at_utc',
  'updated_at_utc',
] as const;

/**
 * `urges` columns:
 * id, tracker_id, tracker_name, occurred_at_utc, occurred_at_local,
 * occurred_time_zone, occurred_utc_offset_minutes, intensity,
 * duration_seconds, trigger, trigger_category_id, context, notes, outcome,
 * retrospective, created_at_utc, updated_at_utc
 */
export const URGE_COLUMNS = [
  'id',
  'tracker_id',
  'tracker_name',
  'occurred_at_utc',
  'occurred_at_local',
  'occurred_time_zone',
  'occurred_utc_offset_minutes',
  'intensity',
  'duration_seconds',
  'trigger',
  'trigger_category_id',
  'context',
  'notes',
  'outcome',
  'retrospective',
  'created_at_utc',
  'updated_at_utc',
] as const;

/**
 * `journal` columns:
 * id, tracker_id, tracker_name, occurred_at_utc, occurred_at_local,
 * occurred_time_zone, occurred_utc_offset_minutes, title, body,
 * created_at_utc, updated_at_utc
 */
export const JOURNAL_COLUMNS = [
  'id',
  'tracker_id',
  'tracker_name',
  'occurred_at_utc',
  'occurred_at_local',
  'occurred_time_zone',
  'occurred_utc_offset_minutes',
  'title',
  'body',
  'created_at_utc',
  'updated_at_utc',
] as const;

/**
 * `daily-summary` columns (one row per local day in the exported window):
 * date, weekday, active_ms, abstinent_ms, lapse_count, urge_count,
 * journal_count, checkin_count, average_urge_intensity
 */
export const DAILY_SUMMARY_COLUMNS = [
  'date',
  'weekday',
  'active_ms',
  'abstinent_ms',
  'lapse_count',
  'urge_count',
  'journal_count',
  'checkin_count',
  'average_urge_intensity',
] as const;

/**
 * `statistics` columns (one row per tracker):
 * scope, tracker_id, tracker_name, status, now_utc, elapsed_since_start_ms,
 * elapsed_since_created_ms, active_tracked_ms, paused_ms, current_streak_ms,
 * current_streak_start_at_utc, longest_streak_ms, accumulated_abstinence_ms,
 * completed_abstinence_ms, lapse_count, urge_count, journal_count,
 * last_lapse_at_utc, time_since_last_lapse_ms, streak_count, average_streak_ms,
 * average_between_lapses_ms, median_between_lapses_ms,
 * abstinence_share_of_elapsed, active_share_of_elapsed, lapses_per_active_week,
 * lapses_per_active_month, average_urge_intensity
 */
export const STATISTICS_COLUMNS = [
  'scope',
  'tracker_id',
  'tracker_name',
  'status',
  'now_utc',
  'elapsed_since_start_ms',
  'elapsed_since_created_ms',
  'active_tracked_ms',
  'paused_ms',
  'current_streak_ms',
  'current_streak_start_at_utc',
  'longest_streak_ms',
  'accumulated_abstinence_ms',
  'completed_abstinence_ms',
  'lapse_count',
  'urge_count',
  'journal_count',
  'last_lapse_at_utc',
  'time_since_last_lapse_ms',
  'streak_count',
  'average_streak_ms',
  'average_between_lapses_ms',
  'median_between_lapses_ms',
  'abstinence_share_of_elapsed',
  'active_share_of_elapsed',
  'lapses_per_active_week',
  'lapses_per_active_month',
  'average_urge_intensity',
] as const;

function buildTrackerRows(context: CsvContext, formatting: ResolvedFormatting): string[][] {
  return context.data.trackers.map((tracker) => {
    const [startedUtc, startedLocal] = timestampColumns(tracker.startedAt, formatting);
    return [
      tracker.id,
      tracker.name,
      nullableText(tracker.description),
      nullableText(tracker.categoryId),
      tracker.status,
      startedUtc,
      startedLocal,
      tracker.startedTimeZone,
      String(tracker.startedUtcOffsetMinutes),
      toIsoUtc(tracker.createdAt),
      toIsoUtc(tracker.updatedAt),
      tracker.archivedAt === null ? '' : toIsoUtc(tracker.archivedAt),
      nullableText(tracker.notes),
      nullableText(tracker.reasons),
      booleanText(tracker.reminderEnabled),
      nullableNumber(tracker.reminderIntervalMinutes),
    ];
  });
}

function buildLapseRows(context: CsvContext, formatting: ResolvedFormatting): string[][] {
  const names = trackerNameMap(context);
  return context.data.lapses.map((lapse) => {
    const [occurredUtc, occurredLocal] = timestampColumns(lapse.occurredAt, formatting);
    return [
      lapse.id,
      lapse.trackerId,
      names.get(lapse.trackerId) ?? '',
      occurredUtc,
      occurredLocal,
      lapse.occurredTimeZone,
      String(lapse.occurredUtcOffsetMinutes),
      nullableText(lapse.reason),
      nullableText(lapse.trigger),
      nullableText(lapse.triggerCategoryId),
      nullableText(lapse.description),
      nullableText(lapse.notes),
      nullableText(lapse.context),
      booleanText(lapse.retrospective),
      toIsoUtc(lapse.createdAt),
      toIsoUtc(lapse.updatedAt),
    ];
  });
}

function buildUrgeRows(context: CsvContext, formatting: ResolvedFormatting): string[][] {
  const names = trackerNameMap(context);
  return context.data.urges.map((urge) => {
    const [occurredUtc, occurredLocal] = timestampColumns(urge.occurredAt, formatting);
    return [
      urge.id,
      urge.trackerId,
      names.get(urge.trackerId) ?? '',
      occurredUtc,
      occurredLocal,
      urge.occurredTimeZone,
      String(urge.occurredUtcOffsetMinutes),
      String(urge.intensity),
      nullableNumber(urge.durationSeconds),
      nullableText(urge.trigger),
      nullableText(urge.triggerCategoryId),
      nullableText(urge.context),
      nullableText(urge.notes),
      urge.outcome,
      booleanText(urge.retrospective),
      toIsoUtc(urge.createdAt),
      toIsoUtc(urge.updatedAt),
    ];
  });
}

function buildJournalRows(context: CsvContext, formatting: ResolvedFormatting): string[][] {
  const names = trackerNameMap(context);
  return [...context.data.journalEntries]
    .sort((a, b) => a.occurredAt - b.occurredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => {
      const [occurredUtc, occurredLocal] = timestampColumns(entry.occurredAt, formatting);
      return [
        entry.id,
        nullableText(entry.trackerId),
        entry.trackerId ? names.get(entry.trackerId) ?? '' : '',
        occurredUtc,
        occurredLocal,
        entry.occurredTimeZone,
        String(entry.occurredUtcOffsetMinutes),
        nullableText(entry.title),
        entry.body,
        toIsoUtc(entry.createdAt),
        toIsoUtc(entry.updatedAt),
      ];
    });
}

function buildDailySummaryRows(context: CsvContext, formatting: ResolvedFormatting): string[][] {
  return context.combinedDailyPeriods.map((bucket) => [
    bucket.key,
    weekdayNameFor(bucket, formatting.timeZone),
    String(Math.round(bucket.activeMs)),
    String(Math.round(bucket.abstinentMs)),
    String(bucket.lapseCount),
    String(bucket.urgeCount),
    String(bucket.journalCount),
    String(bucket.checkInCount),
    fixedNumber(bucket.averageUrgeIntensity, 2),
  ]);
}

function buildStatisticsRows(context: CsvContext): string[][] {
  const names = trackerNameMap(context);
  return context.trackerMetrics.map((metrics) => [
    'tracker',
    metrics.trackerId,
    names.get(metrics.trackerId) ?? '',
    metrics.status,
    toIsoUtc(metrics.now),
    String(metrics.elapsedSinceStartMs),
    String(metrics.elapsedSinceCreatedMs),
    String(metrics.activeTrackedMs),
    String(metrics.pausedMs),
    String(metrics.currentStreakMs),
    toIsoUtc(metrics.currentStreakStartAt),
    String(metrics.longestStreakMs),
    String(metrics.accumulatedAbstinenceMs),
    String(metrics.completedAbstinenceMs),
    String(metrics.lapseCount),
    String(metrics.urgeCount),
    String(metrics.journalCount),
    metrics.lastLapseAt === null ? '' : toIsoUtc(metrics.lastLapseAt),
    nullableNumber(metrics.timeSinceLastLapseMs),
    String(metrics.streakCount),
    fixedNumber(metrics.averageStreakMs, 0),
    fixedNumber(metrics.averageBetweenLapsesMs, 0),
    fixedNumber(metrics.medianBetweenLapsesMs, 0),
    fixedNumber(metrics.abstinenceShareOfElapsed, 4),
    fixedNumber(metrics.activeShareOfElapsed, 4),
    fixedNumber(metrics.lapsesPerActiveWeek, 4),
    fixedNumber(metrics.lapsesPerActiveMonth, 4),
    fixedNumber(metrics.averageUrgeIntensity, 2),
  ]);
}

function csvPrefix(dataset: CsvDataset): string {
  return `deurge-${dataset}`;
}

/** Build one CSV export for a dataset. */
export function buildCsvExport(
  dataset: CsvDataset,
  context: CsvContext,
  options: CsvExportOptions = {},
): CsvExportResult {
  const formatting = resolveFormatting(context, options);
  let columns: readonly string[];
  let rows: string[][];
  switch (dataset) {
    case 'trackers':
      columns = TRACKER_COLUMNS;
      rows = buildTrackerRows(context, formatting);
      break;
    case 'lapses':
      columns = LAPSE_COLUMNS;
      rows = buildLapseRows(context, formatting);
      break;
    case 'urges':
      columns = URGE_COLUMNS;
      rows = buildUrgeRows(context, formatting);
      break;
    case 'journal':
      columns = JOURNAL_COLUMNS;
      rows = buildJournalRows(context, formatting);
      break;
    case 'daily-summary':
      columns = DAILY_SUMMARY_COLUMNS;
      rows = buildDailySummaryRows(context, formatting);
      break;
    case 'statistics':
      columns = STATISTICS_COLUMNS;
      rows = buildStatisticsRows(context);
      break;
    default: {
      // Exhaustiveness check: a new dataset must be added above.
      const unreachable: never = dataset;
      throw new DeUrgeError('VALIDATION', `Unknown CSV dataset: ${String(unreachable)}`);
    }
  }
  return {
    filename: exportFilename(csvPrefix(dataset), context.now, formatting.timeZone, 'csv'),
    content: serialiseCsv(columns, rows),
    rows: rows.length,
  };
}

/** Exposed for tests: the local time-of-day formatter used by local columns. */
export function localTimeOfDay(epochMs: number, formatting: ResolvedFormatting): string {
  return formatTimeOfDay(epochMs, formatting.timeZone, formatting.timeFormat);
}

/** Exposed for tests: local date formatter used by local columns. */
export function localDateFormatted(epochMs: number, formatting: ResolvedFormatting): string {
  return formatDate(epochMs, formatting.timeZone, formatting.dateFormat);
}

export type { ResolvedFormatting };
