/**
 * Journal-screen time helpers.
 *
 * Everything persisted is UTC epoch milliseconds; journal input and timeline
 * grouping use the user's *effective* timezone (see store/app), so a backdated
 * entry lands on the local day it was written for.
 */
import {
  Temporal,
  addLocalDaysMs,
  formatDateCompact,
  localDateKey,
  localTimeKey,
  type DateFormat,
} from '@tyag/core';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** Split an instant into local `YYYY-MM-DD` / `HH:MM` input values. */
export function splitLocalDateTime(epochMs: number, timeZone: string): { date: string; time: string } {
  return { date: localDateKey(epochMs, timeZone), time: localTimeKey(epochMs, timeZone) };
}

/** Convert local date/time inputs in `timeZone` into UTC epoch ms. */
export function zonedLocalDateTimeToMs(date: string, time: string, timeZone: string): number | null {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return null;
  try {
    return Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(timeZone).toInstant().epochMilliseconds;
  } catch {
    return null;
  }
}

/** First instant of a local calendar date (optionally shifted by whole days). */
export function startOfLocalDateKeyMs(date: string, timeZone: string, extraDays = 0): number | null {
  if (!DATE_RE.test(date)) return null;
  try {
    const plain = Temporal.PlainDate.from(date).add({ days: extraDays });
    return plain.toZonedDateTime(timeZone).toInstant().epochMilliseconds;
  } catch {
    return null;
  }
}

/**
 * Day header for the timeline: "Today", "Yesterday", or
 * "Monday · Nov 10". Dates are shown in the effective timezone.
 */
export function dayHeaderLabel(
  epochMs: number,
  nowMs: number,
  timeZone: string,
  dateFormat: DateFormat,
): string {
  void dateFormat;
  const day = localDateKey(epochMs, timeZone);
  const today = localDateKey(nowMs, timeZone);
  const yesterday = localDateKey(addLocalDaysMs(nowMs, -1, timeZone), timeZone);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  let weekday = '';
  try {
    weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(new Date(epochMs));
  } catch {
    weekday = '';
  }
  const date = formatDateCompact(epochMs, timeZone, nowMs);
  return weekday ? `${weekday} · ${date}` : date;
}
