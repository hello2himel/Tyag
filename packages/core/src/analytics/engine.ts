/**
 * Analytics calculations.
 *
 * The engine is deliberately *derivative*: every number is recomputed from
 * stored records through the streak engine and the local-time period helpers.
 * Nothing is cached, so editing or deleting a record immediately changes the
 * analytics and historical results are reproducible from the same records.
 *
 * Definitions used here (mirrored in docs/CALCULATION_RULES.md):
 *
 *  - `activeMs`  is the tracked (running, non-paused) time of a tracker that
 *    overlaps a period. A tracker session is a half-open interval, so paused
 *    time never contributes.
 *  - `abstinentMs` is the streak-engine view of the same overlap. In deUrge
 *    every active moment is abstinence (see domain.ts), therefore the two
 *    columns are equal by construction today. They are kept as separate
 *    fields so charts, exports and future partial-day rules can diverge
 *    without breaking the public shape; the numbers are never invented.
 *  - Combined periods *sum tracker-time*: two trackers running in parallel
 *    each contribute their own time. This can exceed wall-clock time and is
 *    documented on `CombinedAnalytics`; it is not wall-clock math.
 */
import type {
  CategoryCount,
  CheckIn,
  CombinedAnalytics,
  Distribution,
  Granularity,
  JournalEntry,
  LapseEvent,
  PeriodBucket,
  Tracker,
  TrackerAnalytics,
  TrackerMetrics,
  TrackerSession,
  UrgeEvent,
  UrgeOutcome,
} from '../domain';
import type { CoreContext } from '../services/context';
import { requireTracker } from '../services/context';
import type { SettingsService } from '../services/settings';
import { groupBy, loadAllData, loadTrackerBundle } from '../services/data';
import { buildActiveIntervals, computeTrackerMetrics } from '../engine/streak';
import { addPeriodsMs, periodKeyFor, startOfPeriodMs } from '../time/periods';
import { localDateKey, localHour, weekdayIndex } from '../time/temporal';
import { DeUrgeError } from '../util/errors';
import type { CombinedAnalyticsOptions, TrackerAnalyticsOptions } from './service';

/** Chart buckets returned when the caller does not choose a limit. */
export const DEFAULT_PERIOD_LIMIT = 90;
/** Hard upper bound so analytics can never enumerate unbounded history. */
export const MAX_PERIOD_LIMIT = 1000;

const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month', 'quarter', 'year'];
const URGE_OUTCOMES: readonly UrgeOutcome[] = ['passed', 'lapse', 'unknown'];

/** Half-open active interval in UTC epoch milliseconds. */
export interface ActiveIntervalLike {
  start: number;
  end: number;
}

/** Resolve and validate granularity/period-limit options. */
export function resolveGranularity(granularity: Granularity | undefined): Granularity {
  const value = granularity ?? 'day';
  if (!GRANULARITIES.includes(value)) {
    throw new DeUrgeError('VALIDATION', 'Unknown chart grouping.');
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolvePeriodLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PERIOD_LIMIT;
  if (!Number.isFinite(limit)) throw new DeUrgeError('VALIDATION', 'Invalid chart period limit.');
  return clamp(Math.round(limit), 1, MAX_PERIOD_LIMIT);
}

function assertFiniteBound(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value)) throw new DeUrgeError('VALIDATION', `Invalid chart ${label}.`);
}

/** Active time inside `[from, to)` for a sorted, disjoint interval list. */
export function activeOverlapMs(intervals: ActiveIntervalLike[], from: number, to: number): number {
  if (!(to > from)) return 0;
  let total = 0;
  for (const interval of intervals) {
    if (interval.end <= from) continue;
    if (interval.start >= to) break;
    total += Math.min(interval.end, to) - Math.max(interval.start, from);
  }
  return total;
}

export interface PeriodSeriesInput {
  granularity: Granularity;
  from: number;
  to: number;
  timeZone: string;
  firstDayOfWeek: 0 | 1;
  periodLimit?: number;
  /**
   * One interval list per tracker. Each list is summed independently so a
   * combined series measures tracker-time, not merged wall-clock time.
   */
  intervalSets: ActiveIntervalLike[][];
  lapses: LapseEvent[];
  urges: UrgeEvent[];
  journal: JournalEntry[];
  checkIns: CheckIn[];
}

interface PeriodRangeWithKey {
  key: string;
  startAt: number;
  endAt: number;
}

/**
 * Enumerate the periods overlapping `[from, to)`, keeping the `limit` most
 * recent periods. The first and last range are clipped to the window so a
 * chart never shows time outside the requested bounds.
 */
export function enumeratePeriodRanges(
  granularity: Granularity,
  from: number,
  to: number,
  timeZone: string,
  firstDayOfWeek: 0 | 1,
  limit: number,
): PeriodRangeWithKey[] {
  if (!(to > from)) return [];
  const firstStart = startOfPeriodMs(granularity, from, timeZone, firstDayOfWeek);
  let cursor = startOfPeriodMs(granularity, to - 1, timeZone, firstDayOfWeek);
  const starts: number[] = [];
  let guard = 0;
  while (guard < limit + 1) {
    starts.push(cursor);
    guard += 1;
    if (cursor <= firstStart) break;
    cursor = addPeriodsMs(granularity, cursor, -1, timeZone);
  }
  starts.reverse();
  if (starts.length > limit) starts.splice(0, starts.length - limit);
  return starts.map((start) => {
    const end = addPeriodsMs(granularity, start, 1, timeZone);
    return {
      key: periodKeyFor(granularity, start, timeZone, firstDayOfWeek),
      startAt: Math.max(start, from),
      endAt: Math.min(end, to),
    };
  });
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Build the period buckets for one tracker or a combined view. */
export function buildPeriodSeries(input: PeriodSeriesInput): PeriodBucket[] {
  const { granularity, from, to, timeZone, firstDayOfWeek } = input;
  const limit = resolvePeriodLimit(input.periodLimit);
  const ranges = enumeratePeriodRanges(granularity, from, to, timeZone, firstDayOfWeek, limit);
  if (ranges.length === 0) return [];

  const lapseCounts = new Map<string, number>();
  const urgeCounts = new Map<string, number>();
  const urgeIntensitySums = new Map<string, number>();
  const journalCounts = new Map<string, number>();
  const checkInCounts = new Map<string, number>();

  const keyWithinWindow = (at: number): string | null =>
    at >= from && at < to ? periodKeyFor(granularity, at, timeZone, firstDayOfWeek) : null;

  for (const lapse of input.lapses) {
    const key = keyWithinWindow(lapse.occurredAt);
    if (key !== null) increment(lapseCounts, key);
  }
  for (const urge of input.urges) {
    const key = keyWithinWindow(urge.occurredAt);
    if (key === null) continue;
    increment(urgeCounts, key);
    if (Number.isFinite(urge.intensity)) {
      urgeIntensitySums.set(key, (urgeIntensitySums.get(key) ?? 0) + urge.intensity);
    }
  }
  for (const entry of input.journal) {
    const key = keyWithinWindow(entry.occurredAt);
    if (key !== null) increment(journalCounts, key);
  }
  for (const checkIn of input.checkIns) {
    const key = keyWithinWindow(checkIn.occurredAt);
    if (key !== null) increment(checkInCounts, key);
  }

  return ranges.map((range) => {
    let activeMs = 0;
    for (const intervals of input.intervalSets) {
      activeMs += activeOverlapMs(intervals, range.startAt, range.endAt);
    }
    const urgeCount = urgeCounts.get(range.key) ?? 0;
    const intensitySum = urgeIntensitySums.get(range.key) ?? 0;
    return {
      key: range.key,
      startAt: range.startAt,
      endAt: range.endAt,
      lapseCount: lapseCounts.get(range.key) ?? 0,
      urgeCount,
      journalCount: journalCounts.get(range.key) ?? 0,
      checkInCount: checkInCounts.get(range.key) ?? 0,
      averageUrgeIntensity: urgeCount > 0 ? intensitySum / urgeCount : null,
      activeMs,
      // In deUrge every active (non-paused) moment is abstinence, so the
      // streak-engine overlap is identical; see the module doc comment.
      abstinentMs: activeMs,
    };
  });
}

function compareLabels(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Count non-empty text values; sorted by count desc then label for stability. */
export function countLabels(values: (string | null | undefined)[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const label = value.trim();
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || compareLabels(a.label, b.label));
}

function toDistribution<T>(domainValues: readonly T[], counts: Map<T, number>): Distribution<T>[] {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return domainValues.map((value) => {
    const count = counts.get(value) ?? 0;
    return { value, count, share: total > 0 ? count / total : 0 };
  });
}

/** Local weekday distribution in display order (0 = first day of week). */
export function buildWeekdayDistribution(
  events: { occurredAt: number }[],
  timeZone: string,
  firstDayOfWeek: 0 | 1,
): Distribution<number>[] {
  const counts = new Map<number, number>();
  for (const event of events) {
    const index = weekdayIndex(event.occurredAt, timeZone, firstDayOfWeek);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  return toDistribution([0, 1, 2, 3, 4, 5, 6], counts);
}

/** Local hour-of-day distribution (0..23) in the effective timezone. */
export function buildHourDistribution(events: { occurredAt: number }[], timeZone: string): Distribution<number>[] {
  const counts = new Map<number, number>();
  for (const event of events) {
    const hour = localHour(event.occurredAt, timeZone);
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return toDistribution(
    Array.from({ length: 24 }, (_, hour) => hour),
    counts,
  );
}

/** Unique, ascending local calendar days on which a journal entry exists. */
export function journalDayKeys(entries: JournalEntry[], timeZone: string): string[] {
  const days = new Set<string>();
  for (const entry of entries) days.add(localDateKey(entry.occurredAt, timeZone));
  return [...days].sort(compareLabels);
}

export function buildUrgeOutcomeDistribution(urges: UrgeEvent[]): Distribution<UrgeOutcome>[] {
  const counts = new Map<UrgeOutcome, number>();
  for (const urge of urges) {
    counts.set(urge.outcome, (counts.get(urge.outcome) ?? 0) + 1);
  }
  return toDistribution(URGE_OUTCOMES, counts);
}

/** Full single-tracker analytics: metrics + period buckets + distributions. */
export function buildTrackerAnalytics(
  ctx: CoreContext,
  settings: SettingsService,
  trackerId: string,
  options: TrackerAnalyticsOptions = {},
): TrackerAnalytics {
  // `requireTracker` gives a typed NOT_FOUND error instead of a raw repository
  // exception, so the UI can render a safe message.
  const tracker = requireTracker(ctx, trackerId);
  const bundle = loadTrackerBundle(ctx.db, trackerId);
  assertFiniteBound(options.from, 'start');
  assertFiniteBound(options.to, 'end');
  const now = ctx.clock.now();
  const timeZone = settings.effectiveTimeZone();
  const firstDayOfWeek = settings.get().firstDayOfWeek;
  const granularity = resolveGranularity(options.granularity);
  const from = options.from ?? tracker.startedAt;
  const to = options.to ?? now;
  const periodLimit = resolvePeriodLimit(options.periodLimit);

  const metrics = computeTrackerMetrics({
    tracker,
    sessions: bundle.sessions,
    lapses: bundle.lapses,
    urges: bundle.urges,
    journal: bundle.journal,
    now,
  });
  const activeIntervals = buildActiveIntervals(tracker, bundle.sessions, now);

  const periods = buildPeriodSeries({
    granularity,
    from,
    to,
    timeZone,
    firstDayOfWeek,
    periodLimit,
    intervalSets: [activeIntervals],
    lapses: bundle.lapses,
    urges: bundle.urges,
    journal: bundle.journal,
    checkIns: bundle.checkIns,
  });

  return {
    metrics,
    periods,
    lapseTriggers: countLabels(bundle.lapses.map((lapse) => lapse.trigger)),
    lapseReasons: countLabels(bundle.lapses.map((lapse) => lapse.reason)),
    lapseContexts: countLabels(bundle.lapses.map((lapse) => lapse.context)),
    weekdayCounts: buildWeekdayDistribution(bundle.lapses, timeZone, firstDayOfWeek),
    hourCounts: buildHourDistribution(bundle.lapses, timeZone),
    urgeTriggers: countLabels(bundle.urges.map((urge) => urge.trigger)),
    urgeOutcomes: buildUrgeOutcomeDistribution(bundle.urges),
    journalDays: journalDayKeys(bundle.journal, timeZone),
  };
}

interface TrackerData {
  tracker: Tracker;
  sessions: TrackerSession[];
  lapses: LapseEvent[];
  urges: UrgeEvent[];
  journal: JournalEntry[];
  checkIns: CheckIn[];
  metrics: TrackerMetrics;
  activeIntervals: ActiveIntervalLike[];
}

/** Metrics for every tracker, using the same streak engine as the app. */
export function computeAllTrackerData(ctx: CoreContext): TrackerData[] {
  const data = loadAllData(ctx.db);
  const now = ctx.clock.now();
  const sessionsByTracker = groupBy(data.sessions, (session) => session.trackerId);
  const lapsesByTracker = groupBy(data.lapses, (lapse) => lapse.trackerId);
  const urgesByTracker = groupBy(data.urges, (urge) => urge.trackerId);
  const journalByTracker = groupBy(
    data.journalEntries.filter((entry) => entry.trackerId !== null),
    (entry) => entry.trackerId as string,
  );
  const checkInsByTracker = groupBy(
    data.checkIns.filter((checkIn) => checkIn.trackerId !== null),
    (checkIn) => checkIn.trackerId as string,
  );
  return data.trackers.map((tracker) => {
    const sessions = sessionsByTracker.get(tracker.id) ?? [];
    const lapses = lapsesByTracker.get(tracker.id) ?? [];
    const urges = urgesByTracker.get(tracker.id) ?? [];
    const journal = journalByTracker.get(tracker.id) ?? [];
    const checkIns = checkInsByTracker.get(tracker.id) ?? [];
    return {
      tracker,
      sessions,
      lapses,
      urges,
      journal,
      checkIns,
      metrics: computeTrackerMetrics({ tracker, sessions, lapses, urges, journal, now }),
      activeIntervals: buildActiveIntervals(tracker, sessions, now),
    };
  });
}

/** Combined analytics across every tracker (tracker-time, see module docs). */
export function buildCombinedAnalytics(
  ctx: CoreContext,
  settings: SettingsService,
  options: CombinedAnalyticsOptions = {},
): CombinedAnalytics {
  assertFiniteBound(options.from, 'start');
  assertFiniteBound(options.to, 'end');
  const data = loadAllData(ctx.db);
  const now = ctx.clock.now();
  const timeZone = settings.effectiveTimeZone();
  const firstDayOfWeek = settings.get().firstDayOfWeek;
  const granularity = resolveGranularity(options.granularity);
  const to = options.to ?? now;
  const from = options.from ?? (data.trackers.length > 0 ? Math.min(...data.trackers.map((t) => t.startedAt)) : now);
  const periodLimit = resolvePeriodLimit(options.periodLimit);

  const perTracker = computeAllTrackerData(ctx);
  const trackers = perTracker.map((entry) => entry.metrics);
  const activeTrackerCount = data.trackers.filter((tracker) => tracker.status === 'active').length;
  const pausedTrackerCount = data.trackers.filter((tracker) => tracker.status === 'paused').length;
  const archivedTrackerCount = data.trackers.filter((tracker) => tracker.status === 'archived').length;

  const urgeIntensities = data.urges.map((urge) => urge.intensity).filter((value) => Number.isFinite(value));
  const averageUrgeIntensity =
    urgeIntensities.length > 0
      ? urgeIntensities.reduce((sum, value) => sum + value, 0) / urgeIntensities.length
      : null;

  const periods = buildPeriodSeries({
    granularity,
    from,
    to,
    timeZone,
    firstDayOfWeek,
    periodLimit,
    intervalSets: perTracker.map((entry) => entry.activeIntervals),
    lapses: data.lapses,
    urges: data.urges,
    journal: data.journalEntries,
    checkIns: data.checkIns,
  });

  return {
    trackerCount: data.trackers.length,
    activeTrackerCount,
    pausedTrackerCount,
    archivedTrackerCount,
    // Tracker-time: each tracker contributes its own accumulated abstinence.
    totalAccumulatedAbstinenceMs: trackers.reduce((sum, metrics) => sum + metrics.accumulatedAbstinenceMs, 0),
    totalLapseCount: trackers.reduce((sum, metrics) => sum + metrics.lapseCount, 0),
    totalUrgeCount: trackers.reduce((sum, metrics) => sum + metrics.urgeCount, 0),
    averageUrgeIntensity,
    periods,
    lapseTriggers: countLabels(data.lapses.map((lapse) => lapse.trigger)),
    weekdayCounts: buildWeekdayDistribution(data.lapses, timeZone, firstDayOfWeek),
    trackers,
  };
}
