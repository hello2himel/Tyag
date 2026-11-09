/**
 * Timezone-aware calendar helpers built on Temporal.
 *
 * All persisted instants are UTC epoch milliseconds. Calendar grouping
 * (days, weeks, months, quarters, years) must be done in a *local* timezone so
 * that a lapse at 23:30 local time belongs to that local day even when UTC has
 * already rolled over. Temporal handles DST transitions and leap years
 * correctly, which hand-rolled offsets do not.
 */
import { Temporal } from '@js-temporal/polyfill';

export { Temporal };

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Temporal.Now.instant().toZonedDateTimeISO(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function zonedAt(epochMs: number, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
}

/** UTC offset of the zone at that instant, in minutes east of UTC. */
export function utcOffsetMinutesAt(epochMs: number, timeZone: string): number {
  const zdt = zonedAt(epochMs, timeZone);
  return Math.round(zdt.offsetNanoseconds / 60_000_000_000);
}

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(epochMs: number, timeZone: string): string {
  const zdt = zonedAt(epochMs, timeZone);
  return `${String(zdt.year).padStart(4, '0')}-${String(zdt.month).padStart(2, '0')}-${String(zdt.day).padStart(2, '0')}`;
}

/** Local time as HH:MM (24h). */
export function localTimeKey(epochMs: number, timeZone: string): string {
  const zdt = zonedAt(epochMs, timeZone);
  return `${String(zdt.hour).padStart(2, '0')}:${String(zdt.minute).padStart(2, '0')}`;
}

/** Local hour (0-23). */
export function localHour(epochMs: number, timeZone: string): number {
  return zonedAt(epochMs, timeZone).hour;
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(epochMs: number, timeZone: string): number {
  return zonedAt(epochMs, timeZone).dayOfWeek;
}

/**
 * Weekday index in display order. `firstDayOfWeek` is 0 for Sunday, 1 for
 * Monday. Result 0 is the first day of the week.
 */
export function weekdayIndex(epochMs: number, timeZone: string, firstDayOfWeek: 0 | 1): number {
  const iso = isoWeekday(epochMs, timeZone); // 1..7, Monday=1
  const sundayZero = iso % 7; // Sunday=0
  return (sundayZero - firstDayOfWeek + 7) % 7;
}

export function startOfLocalDayMs(epochMs: number, timeZone: string): number {
  return zonedAt(epochMs, timeZone).startOfDay().toInstant().epochMilliseconds;
}

export function addLocalDaysMs(epochMs: number, days: number, timeZone: string): number {
  return zonedAt(epochMs, timeZone)
    .add({ days })
    .toInstant().epochMilliseconds;
}

export function addLocalMonthsMs(epochMs: number, months: number, timeZone: string): number {
  return zonedAt(epochMs, timeZone)
    .add({ months })
    .toInstant().epochMilliseconds;
}

/** First instant of the week containing `epochMs` (local, DST safe). */
export function startOfLocalWeekMs(epochMs: number, timeZone: string, firstDayOfWeek: 0 | 1): number {
  const zdt = zonedAt(epochMs, timeZone);
  const idx = weekdayIndex(epochMs, timeZone, firstDayOfWeek);
  return zdt.subtract({ days: idx }).startOfDay().toInstant().epochMilliseconds;
}

export function startOfLocalMonthMs(epochMs: number, timeZone: string): number {
  const zdt = zonedAt(epochMs, timeZone);
  return zdt.with({ day: 1 }).startOfDay().toInstant().epochMilliseconds;
}

export function startOfLocalQuarterMs(epochMs: number, timeZone: string): number {
  const zdt = zonedAt(epochMs, timeZone);
  const qStartMonth = Math.floor((zdt.month - 1) / 3) * 3 + 1;
  return zdt.with({ month: qStartMonth, day: 1 }).startOfDay().toInstant().epochMilliseconds;
}

export function startOfLocalYearMs(epochMs: number, timeZone: string): number {
  const zdt = zonedAt(epochMs, timeZone);
  return zdt.with({ month: 1, day: 1 }).startOfDay().toInstant().epochMilliseconds;
}

/** ISO-8601 UTC timestamp with milliseconds, used in exports. */
export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Parse ISO timestamps (any offset) into epoch ms; throws for invalid input. */
export function fromIsoUtc(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid ISO timestamp: ${value}`);
  return ms;
}
