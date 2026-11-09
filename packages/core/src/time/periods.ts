/**
 * Calendar period enumeration in a local timezone.
 *
 * Used by analytics to produce daily/weekly/monthly/quarterly/yearly buckets.
 * Boundaries are computed with Temporal so DST shifts never create missing or
 * duplicated days, and month/year boundaries do not rely on fixed 30-day
 * arithmetic. Period keys are stable and reproducible from stored records.
 */
import type { Granularity } from '../domain';
import { formatMonthShort } from './format';
import {
  addLocalDaysMs,
  addLocalMonthsMs,
  localDateKey,
  startOfLocalDayMs,
  startOfLocalMonthMs,
  startOfLocalQuarterMs,
  startOfLocalWeekMs,
  startOfLocalYearMs,
  zonedAt,
} from './temporal';

export interface PeriodRange {
  key: string;
  startAt: number;
  /** Exclusive end. */
  endAt: number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function periodKeyFor(
  granularity: Granularity,
  epochMs: number,
  timeZone: string,
  firstDayOfWeek: 0 | 1 = 1,
): string {
  const zdt = zonedAt(epochMs, timeZone);
  switch (granularity) {
    case 'day':
      return localDateKey(epochMs, timeZone);
    case 'week': {
      const start = startOfLocalWeekMs(epochMs, timeZone, firstDayOfWeek);
      return `W${localDateKey(start, timeZone)}`;
    }
    case 'month':
      return `${zdt.year}-${pad(zdt.month)}`;
    case 'quarter':
      return `${zdt.year}-Q${Math.floor((zdt.month - 1) / 3) + 1}`;
    case 'year':
      return `${zdt.year}`;
  }
}

export function startOfPeriodMs(
  granularity: Granularity,
  epochMs: number,
  timeZone: string,
  firstDayOfWeek: 0 | 1,
): number {
  switch (granularity) {
    case 'day':
      return startOfLocalDayMs(epochMs, timeZone);
    case 'week':
      return startOfLocalWeekMs(epochMs, timeZone, firstDayOfWeek);
    case 'month':
      return startOfLocalMonthMs(epochMs, timeZone);
    case 'quarter':
      return startOfLocalQuarterMs(epochMs, timeZone);
    case 'year':
      return startOfLocalYearMs(epochMs, timeZone);
  }
}

export function addPeriodsMs(
  granularity: Granularity,
  startMs: number,
  count: number,
  timeZone: string,
): number {
  switch (granularity) {
    case 'day':
      return addLocalDaysMs(startMs, count, timeZone);
    case 'week':
      return addLocalDaysMs(startMs, count * 7, timeZone);
    case 'month':
      return addLocalMonthsMs(startMs, count, timeZone);
    case 'quarter':
      return addLocalMonthsMs(startMs, count * 3, timeZone);
    case 'year':
      return addLocalMonthsMs(startMs, count * 12, timeZone);
  }
}

export function periodRange(
  granularity: Granularity,
  epochMs: number,
  timeZone: string,
  firstDayOfWeek: 0 | 1,
): PeriodRange {
  const startAt = startOfPeriodMs(granularity, epochMs, timeZone, firstDayOfWeek);
  const endAt = addPeriodsMs(granularity, startAt, 1, timeZone);
  return {
    key: periodKeyFor(granularity, epochMs, timeZone, firstDayOfWeek),
    startAt,
    endAt,
  };
}

/**
 * Enumerate the calendar periods that overlap `[fromMs, toMs)`. Ranges are
 * true period boundaries (the first/last may extend beyond the query window,
 * which lets charts show a complete bucket). Bounded by `maxPeriods`.
 */
export function enumeratePeriods(
  granularity: Granularity,
  fromMs: number,
  toMs: number,
  timeZone: string,
  firstDayOfWeek: 0 | 1,
  maxPeriods = 400,
): PeriodRange[] {
  if (!(toMs > fromMs)) return [];
  const result: PeriodRange[] = [];
  let start = startOfPeriodMs(granularity, fromMs, timeZone, firstDayOfWeek);
  let guard = 0;
  while (start < toMs && guard < maxPeriods) {
    const next = addPeriodsMs(granularity, start, 1, timeZone);
    const outOfRange = next <= fromMs || start >= toMs;
    if (!outOfRange) {
      result.push({
        key: periodKeyFor(granularity, start + 1, timeZone, firstDayOfWeek),
        startAt: start,
        endAt: next,
      });
    }
    start = next;
    guard += 1;
  }
  return result;
}

/** Short chart label for a period start instant. */
export function formatPeriodLabel(
  granularity: Granularity,
  startMs: number,
  timeZone: string,
): string {
  const zdt = zonedAt(startMs, timeZone);
  switch (granularity) {
    case 'day':
      return `${formatMonthShort(zdt.month)} ${zdt.day}`;
    case 'week':
      return `${formatMonthShort(zdt.month)} ${zdt.day}`;
    case 'month':
      return formatMonthShort(zdt.month);
    case 'quarter':
      return `Q${Math.floor((zdt.month - 1) / 3) + 1}`;
    case 'year':
      return `${zdt.year}`;
  }
}
