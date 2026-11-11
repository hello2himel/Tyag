/**
 * Insights screen calculations.
 *
 * Everything here is derived from the analytics engine response, the screen
 * never estimates or fabricates a number. Windows are aligned to local calendar
 * periods in the user's effective timezone so week/month/quarter/year charts
 * match the statistics and exports.
 */
import {
  addPeriodsMs,
  formatPeriodLabel,
  startOfPeriodMs,
  type CombinedAnalytics,
  type Granularity,
  type PeriodBucket,
  type TrackerMetrics,
} from '@tyag/core';
import type { Formatters } from '../../ui/format';
import type { BarDatum } from '../../ui/components';

const MS_PER_WEEK = 7 * 86_400_000;
/** Rates are only shown once there is at least a day of active tracking time. */
const MIN_ACTIVE_FOR_RATE_MS = 86_400_000;

/** How many calendar periods the charts show for each granularity. */
export const WINDOW_PERIODS: Record<Granularity, number> = {
  day: 14,
  week: 8,
  month: 6,
  quarter: 6,
  year: 5,
};

export const WINDOW_UNIT: Record<Granularity, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
};

export interface AnalyticsWindow {
  granularity: Granularity;
  from: number;
  to: number;
  periodLimit: number;
}

/** Local-calendar window ending with the period that contains `nowMs`. */
export function analyticsWindow(
  granularity: Granularity,
  nowMs: number,
  timeZone: string,
  firstDayOfWeek: 0 | 1,
): AnalyticsWindow {
  const count = WINDOW_PERIODS[granularity];
  const currentStart = startOfPeriodMs(granularity, nowMs, timeZone, firstDayOfWeek);
  const from = addPeriodsMs(granularity, currentStart, -(count - 1), timeZone);
  const to = addPeriodsMs(granularity, currentStart, 1, timeZone);
  return { granularity, from, to, periodLimit: count };
}

export function lapseBars(periods: PeriodBucket[], granularity: Granularity, timeZone: string): BarDatum[] {
  return periods.map((period) => ({
    label: formatPeriodLabel(granularity, period.startAt, timeZone),
    value: period.lapseCount,
    displayValue: `${period.lapseCount} lapse${period.lapseCount === 1 ? '' : 's'}`,
  }));
}

export function urgeBars(periods: PeriodBucket[], granularity: Granularity, timeZone: string): BarDatum[] {
  return periods.map((period) => ({
    label: formatPeriodLabel(granularity, period.startAt, timeZone),
    value: period.averageUrgeIntensity ?? 0,
    displayValue:
      period.averageUrgeIntensity === null ? 'No urges recorded' : `${period.averageUrgeIntensity.toFixed(1)}/10 average`,
  }));
}

export interface PeriodTotals {
  lapses: number;
  urges: number;
  journal: number;
  checkIns: number;
}

export function periodTotals(periods: PeriodBucket[]): PeriodTotals {
  return periods.reduce<PeriodTotals>(
    (totals, period) => ({
      lapses: totals.lapses + period.lapseCount,
      urges: totals.urges + period.urgeCount,
      journal: totals.journal + period.journalCount,
      checkIns: totals.checkIns + period.checkInCount,
    }),
    { lapses: 0, urges: 0, journal: 0, checkIns: 0 },
  );
}

export interface StatSpec {
  label: string;
  value: string;
  hint?: string;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '–';
  return `${Math.round(value * 100)}%`;
}

function ratioPerWeek(count: number, activeMs: number): number | null {
  if (!(activeMs >= MIN_ACTIVE_FOR_RATE_MS)) return null;
  return count / (activeMs / MS_PER_WEEK);
}

function rateHint(activeMs: number, enough: string): string {
  return activeMs >= MIN_ACTIVE_FOR_RATE_MS ? enough : 'Needs a day of active tracking time';
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (sorted.length % 2 === 1) return upper ?? null;
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

function intervalHint(count: number, unit: string): string {
  return count === 0 ? `Needs at least two ${unit}s` : `n = ${count} ${unit}${count === 1 ? '' : 's'}`;
}

function durationOrDash(value: number | null, fmt: Formatters): string {
  return value === null ? '–' : fmt.duration(value);
}

/** All-time statistics for one tracker. */
export function trackerStats(metrics: TrackerMetrics, fmt: Formatters): StatSpec[] {
  const betweenCount = Math.max(metrics.lapseCount - 1, 0);
  const activeWeekLabel = metrics.status === 'paused' ? 'Paused; active time is frozen' : 'Active tracking time only';
  return [
    {
      label: 'Current streak',
      value: fmt.duration(metrics.currentStreakMs),
      hint: metrics.status === 'active' ? 'Running now' : `${metrics.status}`,
    },
    { label: 'Longest streak', value: fmt.duration(metrics.longestStreakMs) },
    {
      label: 'Average streak',
      value: durationOrDash(metrics.averageStreakMs, fmt),
      hint: metrics.streakCount > 0 ? `n = ${metrics.streakCount} interval${metrics.streakCount === 1 ? '' : 's'}` : 'No intervals yet',
    },
    {
      label: 'Accumulated',
      value: fmt.duration(metrics.accumulatedAbstinenceMs),
      hint: 'Paused time excluded',
    },
    { label: 'Since start', value: fmt.duration(metrics.elapsedSinceStartMs) },
    { label: 'Lapses', value: String(metrics.lapseCount) },
    {
      label: 'Average between lapses',
      value: durationOrDash(metrics.averageBetweenLapsesMs, fmt),
      hint: intervalHint(betweenCount, 'interval'),
    },
    {
      label: 'Median between lapses',
      value: durationOrDash(metrics.medianBetweenLapsesMs, fmt),
      hint: intervalHint(betweenCount, 'interval'),
    },
    { label: 'Urges recorded', value: String(metrics.urgeCount) },
    {
      label: 'Lapses per active week',
      value:
        metrics.lapseCount > 0
          ? formatAverage(ratioPerWeek(metrics.lapseCount, metrics.activeTrackedMs))
          : '–',
      hint: rateHint(metrics.activeTrackedMs, activeWeekLabel),
    },
    {
      label: 'Urges per active week',
      value: metrics.urgeCount > 0 ? formatAverage(ratioPerWeek(metrics.urgeCount, metrics.activeTrackedMs)) : '–',
      hint: rateHint(metrics.activeTrackedMs, activeWeekLabel),
    },
    {
      label: 'Avg urge intensity',
      value: metrics.averageUrgeIntensity === null ? '–' : `${metrics.averageUrgeIntensity.toFixed(1)}/10`,
      hint: metrics.urgeCount > 0 ? `n = ${metrics.urgeCount} urges` : 'No urges recorded',
    },
    {
      label: 'Abstinent share',
      value: formatPercent(metrics.abstinenceShareOfElapsed),
      hint: 'Accumulated ÷ time since start',
    },
  ];
}

/** All-time statistics across every tracker (tracker-time where summed). */
export function combinedStats(data: CombinedAnalytics, fmt: Formatters): StatSpec[] {
  const metrics = data.trackers;
  const currentMax = metrics.length > 0 ? Math.max(...metrics.map((entry) => entry.currentStreakMs)) : 0;
  const longestMax = metrics.length > 0 ? Math.max(...metrics.map((entry) => entry.longestStreakMs)) : 0;
  const averageStreaks = metrics
    .map((entry) => entry.averageStreakMs)
    .filter((value): value is number => value !== null);
  const betweenAverages = metrics
    .map((entry) => entry.averageBetweenLapsesMs)
    .filter((value): value is number => value !== null);
  const betweenMedians = metrics
    .map((entry) => entry.medianBetweenLapsesMs)
    .filter((value): value is number => value !== null);
  const elapsedSum = metrics.reduce((sum, entry) => sum + entry.elapsedSinceStartMs, 0);
  const abstinentShare = elapsedSum > 0 ? data.totalAccumulatedAbstinenceMs / elapsedSum : null;
  return [
    {
      label: 'Active trackers',
      value: `${data.activeTrackerCount}/${data.trackerCount}`,
      hint: `${data.pausedTrackerCount} paused · ${data.archivedTrackerCount} archived`,
    },
    {
      label: 'Longest current streak',
      value: fmt.duration(currentMax),
      hint: 'Best running streak across trackers',
    },
    { label: 'Longest streak', value: fmt.duration(longestMax), hint: 'Best recorded on any tracker' },
    {
      label: 'Average streak',
      value: durationOrDash(mean(averageStreaks), fmt),
      hint: averageStreaks.length > 0 ? `n = ${averageStreaks.length} tracker${averageStreaks.length === 1 ? '' : 's'}` : 'No intervals yet',
    },
    {
      label: 'Longest since start',
      value: fmt.duration(metrics.length > 0 ? Math.max(...metrics.map((entry) => entry.elapsedSinceStartMs)) : 0),
      hint: 'Wall-clock age of the longest-running tracker',
    },
    {
      label: 'Accumulated',
      value: fmt.duration(data.totalAccumulatedAbstinenceMs),
      hint: 'Tracker-time: parallel trackers both count',
    },
    { label: 'Lapses', value: String(data.totalLapseCount), hint: 'Across all trackers' },
    {
      label: 'Average between lapses',
      value: durationOrDash(mean(betweenAverages), fmt),
      hint:
        betweenAverages.length > 0
          ? `Mean of per-tracker averages · n = ${betweenAverages.length} tracker${betweenAverages.length === 1 ? '' : 's'}`
          : 'Needs two lapses on one tracker',
    },
    {
      label: 'Median between lapses',
      value: durationOrDash(median(betweenMedians), fmt),
      hint:
        betweenMedians.length > 0
          ? `Median of per-tracker medians · n = ${betweenMedians.length} tracker${betweenMedians.length === 1 ? '' : 's'}`
          : 'Needs two lapses on one tracker',
    },
    { label: 'Urges recorded', value: String(data.totalUrgeCount), hint: 'Across all trackers' },
    {
      label: 'Lapses per active week',
      value:
        data.totalLapseCount > 0
          ? formatAverage(ratioPerWeek(data.totalLapseCount, data.totalAccumulatedAbstinenceMs))
          : '–',
      hint: rateHint(data.totalAccumulatedAbstinenceMs, 'Tracker-time; paused time excluded'),
    },
    {
      label: 'Urges per active week',
      value: data.totalUrgeCount > 0 ? formatAverage(ratioPerWeek(data.totalUrgeCount, data.totalAccumulatedAbstinenceMs)) : '–',
      hint: rateHint(data.totalAccumulatedAbstinenceMs, 'Tracker-time; paused time excluded'),
    },
    {
      label: 'Avg urge intensity',
      value: data.averageUrgeIntensity === null ? '–' : `${data.averageUrgeIntensity.toFixed(1)}/10`,
      hint: data.totalUrgeCount > 0 ? `n = ${data.totalUrgeCount} urges` : 'No urges recorded',
    },
    {
      label: 'Abstinent share',
      value: formatPercent(abstinentShare),
      hint: 'Accumulated ÷ summed time since start',
    },
  ];
}

export function formatAverage(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '–';
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}
