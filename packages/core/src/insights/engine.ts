/**
 * Deterministic rule-based insights.
 *
 * Ground rules for every sentence produced here:
 *
 *  - It only describes records stored on this device. There is no network, no
 *    model and no external data source.
 *  - It always names the period it refers to, the sample size behind it and,
 *    where relevant, a caveat ("descriptive only", "self-reported", ...).
 *  - It never makes a medical claim, a diagnosis, a prediction or a causal
 *    statement. Words like "caused" or "because" are not used.
 *  - When a rule does not have enough data it is simply not shown. If *no*
 *    rule has enough data, a single explicit "not enough data yet" insight is
 *    returned instead, so the user always knows why the list is empty.
 *  - Insights are ordered by a fixed rule list and use only deterministic
 *    arithmetic and formatting, so the same database always produces the same
 *    insights in the same order.
 */
import type {
  DateFormat,
  Distribution,
  Insight,
  JournalEntry,
  LapseEvent,
  Tracker,
  TrackerAnalytics,
  TrackerMetrics,
  UrgeEvent,
} from '../domain';
import type { CoreContext } from '../services/context';
import { requireTracker } from '../services/context';
import type { SettingsService } from '../services/settings';
import type { AnalyticsService } from '../analytics/service';
import { activeOverlapMs, computeAllTrackerData, type ActiveIntervalLike } from '../analytics/engine';
import { buildActiveIntervals } from '../engine/streak';
import { loadAllData, loadTrackerBundle } from '../services/data';
import {
  MS_PER_DAY,
  addLocalMonthsMs,
  startOfLocalMonthMs,
  weekdayIndex,
  zonedAt,
} from '../time/temporal';
import { formatDate } from '../time/format';
import { formatDurationLong } from '../time/duration';

/** Minimum sample sizes. Exposed for tests and documentation. */
export const INSIGHT_MINIMUMS = {
  /** Recorded lapses needed before a trigger pattern is described. */
  triggerSample: 3,
  /** Recorded lapses needed before weekday concentration is described. */
  weekdaySample: 5,
  /** Completed periods needed in *each* month for a streak comparison. */
  streakChangePerMonth: 2,
  /** Recorded urges needed in *each* month for a frequency comparison. */
  urgeFrequencyPerMonth: 3,
  /** Recorded urges needed in *each* of the last three months for intensity. */
  urgeIntensityPerMonth: 3,
} as const;

/** Window (days) used by the journal-activity rule. */
export const JOURNAL_WINDOW_DAYS = 30;

const LAPSE_CAVEAT = 'Descriptive only: based on the lapses you chose to record, not a cause or medical finding.';
const URGE_CAVEAT = 'Descriptive only: based on urges you chose to record; recording habits can change counts.';
const JOURNAL_CAVEAT = 'Journal entries are self-reported and never required for progress.';
const STREAK_CAVEAT = 'Measured from tracked time only; paused time is excluded.';
const COMPARISON_CAVEAT =
  'A descriptive comparison of your own records. It does not show cause and does not predict future progress.';

interface CompletedInterval {
  trackerId: string;
  /** When the interval ended (a lapse). */
  endAt: number;
  activeMs: number;
}

interface MonthWindow {
  /** Local key, e.g. 2026-11. */
  key: string;
  /** Human readable, e.g. "November 2026". */
  label: string;
  startAt: number;
  endAt: number;
}

interface ScopeData {
  /** Stable id used to build insight ids: tracker id or "combined". */
  scopeId: string;
  /** Human readable scope snippet used inside sentences, e.g. " across all trackers". */
  scopePhrase: string;
  windowStart: number;
  windowEnd: number;
  trackerCount: number;
  metrics: TrackerMetrics[];
  trackerNames: Map<string, string>;
  totalAccumulatedMs: number;
  totalLongestStreakMs: number;
  longestStreakTrackerId: string | null;
  totalStreakCount: number;
  lapseCount: number;
  urgeCount: number;
  journalCount: number;
  lapses: LapseEvent[];
  urges: UrgeEvent[];
  journal: JournalEntry[];
  completedIntervals: CompletedInterval[];
  timeZone: string;
  dateFormat: DateFormat;
  firstDayOfWeek: 0 | 1;
  now: number;
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatAverage(value: number): string {
  return roundToTenth(value).toFixed(1);
}

function percent(part: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatMonthsLabel(months: MonthWindow[]): string {
  if (months.length === 0) return '';
  if (months.length === 1) return months[0]!.label;
  return `${months[0]!.label} – ${months[months.length - 1]!.label}`;
}

function localMonthKey(at: number, timeZone: string): string {
  const zdt = zonedAt(at, timeZone);
  return `${zdt.year}-${String(zdt.month).padStart(2, '0')}`;
}

function localMonthLabel(at: number, timeZone: string): string {
  const zdt = zonedAt(at, timeZone);
  return `${MONTH_NAMES[zdt.month - 1] ?? ''} ${zdt.year}`;
}

/** English month names (deterministic; no locale dependence). */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Current month and the two months before it, oldest first. */
export function lastThreeMonths(now: number, timeZone: string): MonthWindow[] {
  const ranges: MonthWindow[] = [];
  const currentStart = startOfLocalMonthMs(now, timeZone);
  for (let offset = 2; offset >= 0; offset -= 1) {
    const startAt = offset === 0 ? currentStart : addLocalMonthsMs(currentStart, -offset, timeZone);
    const endAt = addLocalMonthsMs(startAt, 1, timeZone);
    ranges.push({
      key: localMonthKey(startAt, timeZone),
      label: localMonthLabel(startAt, timeZone),
      startAt,
      endAt,
    });
  }
  return ranges;
}

function within(month: MonthWindow, at: number): boolean {
  return at >= month.startAt && at < month.endAt;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeInsight(input: {
  scopeId: string;
  rule: string;
  text: string;
  periodLabel: string;
  sampleSize: number;
  caveat: string | null;
  meaningful: boolean;
}): Insight {
  return {
    id: `${input.scopeId}:${input.rule}`,
    rule: input.rule,
    text: input.text,
    periodLabel: input.periodLabel,
    sampleSize: input.sampleSize,
    caveat: input.caveat,
    meaningful: input.meaningful,
  };
}

/** Completed intervals (each ended by a recorded lapse) with their active time. */
export function completedIntervals(
  trackers: Tracker[],
  lapsesByTracker: Map<string, LapseEvent[]>,
  intervalsByTracker: Map<string, ActiveIntervalLike[]>,
): CompletedInterval[] {
  const completed: CompletedInterval[] = [];
  for (const tracker of trackers) {
    const lapses = lapsesByTracker.get(tracker.id) ?? [];
    const intervals = intervalsByTracker.get(tracker.id) ?? [];
    const sorted = [...lapses]
      .filter((lapse) => lapse.occurredAt >= tracker.startedAt)
      .sort((a, b) => a.occurredAt - b.occurredAt || compareIds(a.id, b.id));
    let previousBoundary = tracker.startedAt;
    for (const lapse of sorted) {
      const activeMs = activeOverlapMs(intervals, previousBoundary, lapse.occurredAt);
      if (activeMs > 0) {
        completed.push({ trackerId: tracker.id, endAt: lapse.occurredAt, activeMs });
      }
      previousBoundary = lapse.occurredAt;
    }
  }
  completed.sort((a, b) => a.endAt - b.endAt || compareIds(a.trackerId, b.trackerId));
  return completed;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------------- */
/* Rules                                                                     */
/* ------------------------------------------------------------------------- */

function longestStreakRule(scope: ScopeData): Insight | null {
  if (scope.totalLongestStreakMs <= 0) return null;
  const trackerName = scope.longestStreakTrackerId
    ? scope.trackerNames.get(scope.longestStreakTrackerId) ?? null
    : null;
  const duration = formatDurationLong(scope.totalLongestStreakMs, { maxUnits: 2 });
  const attribution = scope.trackerCount > 1 && trackerName ? `, on "${trackerName}"` : '';
  const stillRunning = scope.metrics.some(
    (metrics) =>
      metrics.longestStreak !== null &&
      metrics.currentStreakMs === metrics.longestStreakMs &&
      metrics.currentStreakMs > 0 &&
      metrics.isRunning,
  );
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'longest-streak',
    text: `Your longest recorded uninterrupted period${scope.scopePhrase} was ${duration}${attribution}.`,
    periodLabel: `Since ${formatDate(scope.windowStart, scope.timeZone, scope.dateFormat)}`,
    sampleSize: scope.totalStreakCount,
    caveat: stillRunning
      ? `${STREAK_CAVEAT} Your current streak is still running, so this record may keep growing.`
      : STREAK_CAVEAT,
    meaningful: true,
  });
}

function accumulatedRule(scope: ScopeData): Insight | null {
  if (scope.totalAccumulatedMs <= 0) return null;
  const duration = formatDurationLong(scope.totalAccumulatedMs, { maxUnits: 2 });
  const trackersPhrase =
    scope.trackerCount > 1 ? `, summed across ${plural(scope.trackerCount, 'tracker')}` : '';
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'accumulated',
    text: `You have accumulated ${duration} of tracked abstinence${scope.scopePhrase}${trackersPhrase}, across ${plural(scope.totalStreakCount, 'tracked period')}.`,
    periodLabel: `Since ${formatDate(scope.windowStart, scope.timeZone, scope.dateFormat)}`,
    sampleSize: scope.totalStreakCount,
    caveat: 'Accumulated time is tracker-time and excludes paused time; it is not wall-clock time.',
    meaningful: true,
  });
}

function mostCommonTriggerRule(scope: ScopeData): Insight | null {
  const total = scope.lapses.length;
  if (total < INSIGHT_MINIMUMS.triggerSample) return null;
  const counts = new Map<string, number>();
  for (const lapse of scope.lapses) {
    const label = lapse.trigger?.trim();
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]));
  const top = entries[0];
  if (!top || top[1] < 2) return null;
  const withTrigger = entries.reduce((sum, [, count]) => sum + count, 0);
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'lapse-trigger',
    text: `"${top[0]}" appears most often in your recorded lapses${scope.scopePhrase}: ${top[1]} of ${withTrigger} lapses with a trigger (${percent(top[1], withTrigger)}).`,
    periodLabel: `Since ${formatDate(scope.windowStart, scope.timeZone, scope.dateFormat)}`,
    sampleSize: total,
    caveat: LAPSE_CAVEAT,
    meaningful: true,
  });
}

function isWeekendDisplayIndex(index: number, firstDayOfWeek: 0 | 1): boolean {
  // Display index 0 is the configured first day; convert back to Sunday = 0.
  const sundayZero = (index + firstDayOfWeek) % 7;
  return sundayZero === 0 || sundayZero === 6;
}

function weekdayConcentrationRule(scope: ScopeData, weekdayCounts: Distribution<number>[]): Insight | null {
  const total = weekdayCounts.reduce((sum, entry) => sum + entry.count, 0);
  if (total < INSIGHT_MINIMUMS.weekdaySample) return null;
  const weekend = weekdayCounts
    .filter((entry) => isWeekendDisplayIndex(entry.value, scope.firstDayOfWeek))
    .reduce((sum, entry) => sum + entry.count, 0);
  const direction =
    weekend * 2 > total ? ' Most fell on weekends.' : weekend * 2 < total ? ' Most fell on weekdays.' : '';
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'weekday-pattern',
    text: `${weekend} of your ${plural(total, 'recorded lapse')}${scope.scopePhrase} happened on a weekend (${percent(weekend, total)}).${direction}`,
    periodLabel: `Since ${formatDate(scope.windowStart, scope.timeZone, scope.dateFormat)}`,
    sampleSize: total,
    caveat: 'Descriptive only: a day can look busier simply because you recorded more then; it is not a cause.',
    meaningful: true,
  });
}

function streakChangeRule(scope: ScopeData): Insight | null {
  const months = lastThreeMonths(scope.now, scope.timeZone);
  const current = months[2]!;
  const previous = months[1]!;
  const inMonth = (month: MonthWindow): number[] =>
    scope.completedIntervals.filter((interval) => within(month, interval.endAt)).map((interval) => interval.activeMs);
  const currentValues = inMonth(current);
  const previousValues = inMonth(previous);
  if (currentValues.length < INSIGHT_MINIMUMS.streakChangePerMonth) return null;
  if (previousValues.length < INSIGHT_MINIMUMS.streakChangePerMonth) return null;
  const currentAverage = average(currentValues)!;
  const previousAverage = average(previousValues)!;
  const direction =
    currentAverage > previousAverage * 1.05
      ? 'longer'
      : currentAverage < previousAverage * 0.95
        ? 'shorter'
        : 'about the same';
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'streak-change',
    text: `Completed abstinence periods this month averaged ${formatDurationLong(currentAverage, { maxUnits: 2 })}, compared with ${formatDurationLong(previousAverage, { maxUnits: 2 })} last month (${plural(currentValues.length, 'completed period')} and ${plural(previousValues.length, 'completed period')}). That is ${direction} than last month.`,
    periodLabel: `${current.label} vs ${previous.label}`,
    sampleSize: currentValues.length + previousValues.length,
    caveat: COMPARISON_CAVEAT,
    meaningful: true,
  });
}

function urgeFrequencyRule(scope: ScopeData): Insight | null {
  const months = lastThreeMonths(scope.now, scope.timeZone);
  const current = months[2]!;
  const previous = months[1]!;
  const currentCount = scope.urges.filter((urge) => within(current, urge.occurredAt)).length;
  const previousCount = scope.urges.filter((urge) => within(previous, urge.occurredAt)).length;
  if (currentCount < INSIGHT_MINIMUMS.urgeFrequencyPerMonth) return null;
  if (previousCount < INSIGHT_MINIMUMS.urgeFrequencyPerMonth) return null;
  const direction =
    currentCount > previousCount ? 'more' : currentCount < previousCount ? 'fewer' : 'the same number of';
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'urge-frequency',
    text: `You recorded ${plural(currentCount, 'urge')} this month and ${plural(previousCount, 'urge')} last month, ${direction} than last month (${currentCount + previousCount} in total).`,
    periodLabel: `${current.label} vs ${previous.label}`,
    sampleSize: currentCount + previousCount,
    caveat: URGE_CAVEAT,
    meaningful: true,
  });
}

function urgeIntensityTrendRule(scope: ScopeData): Insight | null {
  const months = lastThreeMonths(scope.now, scope.timeZone);
  const buckets = months.map((month) => {
    const values = scope.urges.filter((urge) => within(month, urge.occurredAt)).map((urge) => urge.intensity);
    return { month, count: values.length, average: average(values) };
  });
  if (buckets.some((bucket) => bucket.count < INSIGHT_MINIMUMS.urgeIntensityPerMonth || bucket.average === null)) {
    return null;
  }
  const [first, second, third] = buckets as [
    (typeof buckets)[number],
    (typeof buckets)[number],
    (typeof buckets)[number],
  ];
  const sampleSize = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'urge-intensity-trend',
    text: `Average recorded urge intensity over the last three months was ${formatAverage(first.average!)} (${first.month.label}), ${formatAverage(second.average!)} (${second.month.label}) and ${formatAverage(third.average!)} (${third.month.label}), from ${plural(sampleSize, 'urge')}.`,
    periodLabel: formatMonthsLabel(months),
    sampleSize,
    caveat: 'Self-reported intensity on a 1–10 scale; descriptive only, not a medical measure.',
    meaningful: true,
  });
}

function journalActivityRule(scope: ScopeData): Insight | null {
  const since = scope.now - JOURNAL_WINDOW_DAYS * MS_PER_DAY;
  const recent = scope.journal.filter((entry) => entry.occurredAt >= since && entry.occurredAt <= scope.now);
  if (recent.length === 0) return null;
  const linked = recent.filter((entry) => entry.trackerId !== null).length;
  const linkedPhrase =
    scope.trackerCount === 1 && linked > 0 ? `, ${linked} of them linked to this tracker` : '';
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'journal-activity',
    text: `You wrote ${plural(recent.length, 'journal entry')} in the last ${JOURNAL_WINDOW_DAYS} days${linkedPhrase}.`,
    periodLabel: `Last ${JOURNAL_WINDOW_DAYS} days`,
    sampleSize: recent.length,
    caveat: JOURNAL_CAVEAT,
    meaningful: true,
  });
}

function insufficientDataInsight(scope: ScopeData): Insight {
  const records = scope.lapseCount + scope.urgeCount + scope.journalCount;
  const scopeName = scope.trackerCount === 1 ? 'this tracker' : 'your trackers';
  return makeInsight({
    scopeId: scope.scopeId,
    rule: 'insufficient-data',
    text: `Not enough data yet to generate insights for ${scopeName}. You have ${records} recorded ${records === 1 ? 'event' : 'events'} so far; insights appear once there is enough to describe a pattern.`,
    periodLabel: `Since ${formatDate(scope.windowStart, scope.timeZone, scope.dateFormat)}`,
    sampleSize: records,
    caveat: 'Insights only use records stored on this device. Nothing is sent anywhere.',
    meaningful: false,
  });
}

/* ------------------------------------------------------------------------- */
/* Scope builders                                                            */
/* ------------------------------------------------------------------------- */

function trackerScopeData(
  ctx: CoreContext,
  settings: SettingsService,
  trackerAnalytics: TrackerAnalytics,
): ScopeData {
  const tracker = requireTracker(ctx, trackerAnalytics.metrics.trackerId);
  const bundle = loadTrackerBundle(ctx.db, tracker.id);
  const now = ctx.clock.now();
  const timeZone = settings.effectiveTimeZone();
  const firstDayOfWeek = settings.get().firstDayOfWeek;
  const dateFormat = settings.get().dateFormat;
  // The analytics service already computed this metrics snapshot with the same
  // streak engine; reuse it instead of recomputing divergent numbers.
  const metrics = trackerAnalytics.metrics;
  return {
    scopeId: tracker.id,
    scopePhrase: '',
    windowStart: tracker.startedAt,
    windowEnd: now,
    trackerCount: 1,
    metrics: [metrics],
    trackerNames: new Map([[tracker.id, tracker.name]]),
    totalAccumulatedMs: metrics.accumulatedAbstinenceMs,
    totalLongestStreakMs: metrics.longestStreakMs,
    longestStreakTrackerId: metrics.longestStreakMs > 0 ? tracker.id : null,
    totalStreakCount: metrics.streakCount,
    lapseCount: metrics.lapseCount,
    urgeCount: metrics.urgeCount,
    journalCount: metrics.journalCount,
    lapses: bundle.lapses,
    urges: bundle.urges,
    journal: bundle.journal,
    completedIntervals: completedIntervals(
      [tracker],
      new Map([[tracker.id, bundle.lapses]]),
      new Map([[tracker.id, buildActiveIntervals(tracker, bundle.sessions, now)]]),
    ),
    timeZone,
    dateFormat,
    firstDayOfWeek,
    now,
  };
}

function combinedScopeData(ctx: CoreContext, settings: SettingsService): ScopeData {
  const data = loadAllData(ctx.db);
  const now = ctx.clock.now();
  const timeZone = settings.effectiveTimeZone();
  const firstDayOfWeek = settings.get().firstDayOfWeek;
  const dateFormat = settings.get().dateFormat;
  const perTracker = computeAllTrackerData(ctx);
  const trackerNames = new Map(data.trackers.map((tracker) => [tracker.id, tracker.name]));
  const longest = perTracker.reduce<TrackerMetrics | null>(
    (best, entry) => (!best || entry.metrics.longestStreakMs > best.longestStreakMs ? entry.metrics : best),
    null,
  );
  const windowStart =
    data.trackers.length > 0 ? Math.min(...data.trackers.map((tracker) => tracker.startedAt)) : now;
  const longestTracker = longest
    ? data.trackers.find((tracker) => tracker.id === longest.trackerId) ?? null
    : null;
  return {
    scopeId: 'combined',
    scopePhrase: data.trackers.length > 1 ? ' across all trackers' : '',
    windowStart,
    windowEnd: now,
    trackerCount: data.trackers.length,
    metrics: perTracker.map((entry) => entry.metrics),
    trackerNames,
    totalAccumulatedMs: perTracker.reduce((sum, entry) => sum + entry.metrics.accumulatedAbstinenceMs, 0),
    totalLongestStreakMs: longest?.longestStreakMs ?? 0,
    longestStreakTrackerId: longestTracker?.id ?? null,
    totalStreakCount: perTracker.reduce((sum, entry) => sum + entry.metrics.streakCount, 0),
    lapseCount: data.lapses.length,
    urgeCount: data.urges.length,
    journalCount: data.journalEntries.length,
    lapses: data.lapses,
    urges: data.urges,
    journal: data.journalEntries,
    completedIntervals: completedIntervals(
      data.trackers,
      new Map(perTracker.map((entry) => [entry.tracker.id, entry.lapses] as [string, LapseEvent[]])),
      new Map(
        perTracker.map((entry) => [entry.tracker.id, entry.activeIntervals] as [string, ActiveIntervalLike[]]),
      ),
    ),
    timeZone,
    dateFormat,
    firstDayOfWeek,
    now,
  };
}

function weekdayDistributionFor(scope: ScopeData): Distribution<number>[] {
  const counts = new Map<number, number>();
  for (const lapse of scope.lapses) {
    const index = weekdayIndex(lapse.occurredAt, scope.timeZone, scope.firstDayOfWeek);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return Array.from({ length: 7 }, (_, value) => {
    const count = counts.get(value) ?? 0;
    return { value, count, share: total > 0 ? count / total : 0 };
  });
}

/** Stable ordering of rules in the returned list. */
const RULE_ORDER: readonly string[] = [
  'longest-streak',
  'accumulated',
  'lapse-trigger',
  'weekday-pattern',
  'streak-change',
  'urge-frequency',
  'urge-intensity-trend',
  'journal-activity',
  'insufficient-data',
];

function finalise(candidates: (Insight | null)[], scope: ScopeData): Insight[] {
  const meaningful = candidates.filter((insight): insight is Insight => insight !== null && insight.meaningful);
  const ordered = [...meaningful].sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
  if (ordered.length > 0) return ordered;
  return [insufficientDataInsight(scope)];
}

/** Insights for one tracker. */
export function buildTrackerInsights(
  ctx: CoreContext,
  settings: SettingsService,
  analytics: AnalyticsService,
  trackerId: string,
): Insight[] {
  const trackerAnalytics = analytics.forTracker(trackerId);
  const scope = trackerScopeData(ctx, settings, trackerAnalytics);
  return finalise(
    [
      longestStreakRule(scope),
      accumulatedRule(scope),
      mostCommonTriggerRule(scope),
      weekdayConcentrationRule(scope, trackerAnalytics.weekdayCounts),
      streakChangeRule(scope),
      urgeFrequencyRule(scope),
      urgeIntensityTrendRule(scope),
      journalActivityRule(scope),
    ],
    scope,
  );
}

/** Insights across all trackers. */
export function buildCombinedInsights(ctx: CoreContext, settings: SettingsService): Insight[] {
  const scope = combinedScopeData(ctx, settings);
  return finalise(
    [
      longestStreakRule(scope),
      accumulatedRule(scope),
      mostCommonTriggerRule(scope),
      weekdayConcentrationRule(scope, weekdayDistributionFor(scope)),
      streakChangeRule(scope),
      urgeFrequencyRule(scope),
      urgeIntensityTrendRule(scope),
      journalActivityRule(scope),
    ],
    scope,
  );
}
