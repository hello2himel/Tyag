/**
 * Localized display helpers. Every formatter takes an explicit IANA timezone
 * and (optionally) a locale so the same stored timestamp can be rendered in a
 * fixed zone regardless of the device, and so tests are deterministic.
 */
import type { DateFormat, TimeFormat } from '../domain';
import { MS_PER_MINUTE, localDateKey, toIsoUtc, zonedAt } from './temporal';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
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
];
export const WEEKDAY_SHORT_SUNDAY_FIRST = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG_SUNDAY_FIRST = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function formatTimeOfDay(epochMs: number, timeZone: string, timeFormat: TimeFormat): string {
  const zdt = zonedAt(epochMs, timeZone);
  const minutes = String(zdt.minute).padStart(2, '0');
  if (timeFormat === '24h') {
    return `${String(zdt.hour).padStart(2, '0')}:${minutes}`;
  }
  const period = zdt.hour < 12 ? 'AM' : 'PM';
  const hour12 = zdt.hour % 12 === 0 ? 12 : zdt.hour % 12;
  return `${hour12}:${minutes} ${period}`;
}

export function formatDateParts(epochMs: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekdaySundayFirst: number;
} {
  const zdt = zonedAt(epochMs, timeZone);
  return {
    year: zdt.year,
    month: zdt.month,
    day: zdt.day,
    weekdaySundayFirst: zdt.dayOfWeek % 7,
  };
}

/** Format a calendar date according to the user's chosen pattern. */
export function formatDate(epochMs: number, timeZone: string, dateFormat: DateFormat): string {
  const { year, month, day } = formatDateParts(epochMs, timeZone);
  switch (dateFormat) {
    case 'MMM d, yyyy':
      return `${MONTH_SHORT[month - 1]} ${day}, ${year}`;
    case 'd MMM yyyy':
      return `${day} ${MONTH_SHORT[month - 1]} ${year}`;
    case 'MM/dd/yyyy':
      return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
    case 'dd/MM/yyyy':
      return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    case 'yyyy-MM-dd':
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
}

/** Compact date without the year when the year is the current local year. */
export function formatDateCompact(epochMs: number, timeZone: string, nowMs: number): string {
  const target = formatDateParts(epochMs, timeZone);
  const now = formatDateParts(nowMs, timeZone);
  if (target.year === now.year) return `${MONTH_SHORT[target.month - 1]} ${target.day}`;
  return `${MONTH_SHORT[target.month - 1]} ${target.day}, ${target.year}`;
}

export function formatDateTime(
  epochMs: number,
  timeZone: string,
  dateFormat: DateFormat,
  timeFormat: TimeFormat,
): string {
  return `${formatDate(epochMs, timeZone, dateFormat)}, ${formatTimeOfDay(epochMs, timeZone, timeFormat)}`;
}

export function isSameLocalDay(a: number, b: number, timeZone: string): boolean {
  return localDateKey(a, timeZone) === localDateKey(b, timeZone);
}

function localDayOffset(a: number, b: number, timeZone: string): number {
  const dayA = zonedAt(a, timeZone).startOfDay().toInstant().epochMilliseconds;
  const dayB = zonedAt(b, timeZone).startOfDay().toInstant().epochMilliseconds;
  return Math.round((dayA - dayB) / 86_400_000);
}

/**
 * "Today, 3:42 PM" / "Yesterday, 9:10 AM" / "Oct 29, 8:30 PM".
 */
export function formatRelativeDateTime(
  epochMs: number,
  nowMs: number,
  timeZone: string,
  dateFormat: DateFormat,
  timeFormat: TimeFormat,
): string {
  const diff = localDayOffset(epochMs, nowMs, timeZone);
  const time = formatTimeOfDay(epochMs, timeZone, timeFormat);
  if (diff === 0) return `Today, ${time}`;
  if (diff === -1) return `Yesterday, ${time}`;
  if (diff === 1) return `Tomorrow, ${time}`;
  return `${formatDateCompact(epochMs, timeZone, nowMs)}, ${time}`;
}

/** "Oct 29" style label for timelines. */
export function formatTimelineDate(epochMs: number, nowMs: number, timeZone: string): string {
  return formatDateCompact(epochMs, timeZone, nowMs);
}

export function formatMonthShort(month: number): string {
  return MONTH_SHORT[month - 1] ?? '';
}

export function formatMonthLong(month: number): string {
  return MONTH_LONG[month - 1] ?? '';
}

export function formatWeekdayShort(indexSundayFirst: number): string {
  return WEEKDAY_SHORT_SUNDAY_FIRST[((indexSundayFirst % 7) + 7) % 7] ?? '';
}

export function formatWeekdayLong(indexSundayFirst: number): string {
  return WEEKDAY_LONG_SUNDAY_FIRST[((indexSundayFirst % 7) + 7) % 7] ?? '';
}

/** Display label for a weekday index (0 = first day of week). */
export function formatWeekdayForFirstDay(index: number, firstDayOfWeek: 0 | 1): string {
  return formatWeekdayShort((index + firstDayOfWeek) % 7);
}

export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

/** ISO-8601 UTC string, used in CSV/JSON exports and diagnostics. */
export { toIsoUtc };

export function nowOffsetMs(nowMs: number, epochMs: number, timeZone: string): number {
  void timeZone;
  return nowMs - epochMs;
}

export const MINUTE_MS = MS_PER_MINUTE;
