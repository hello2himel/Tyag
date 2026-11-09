import { describe, expect, it } from 'vitest';
import {
  enumeratePeriods,
  formatDate,
  formatDateTime,
  formatDurationCompact,
  formatDurationIso,
  formatDurationLong,
  formatDurationShort,
  formatRelativeDateTime,
  formatTimeOfDay,
  localDateKey,
  startOfLocalDayMs,
  startOfLocalMonthMs,
  startOfLocalWeekMs,
  startOfLocalYearMs,
  utcOffsetMinutesAt,
  weekdayIndex,
} from '../src/index';
import { DAY, MINUTE, HOUR } from './helpers';

describe('duration formatting', () => {
  it('formats seconds, minutes, hours and days deterministically', () => {
    expect(formatDurationShort(0)).toBe('0s');
    expect(formatDurationShort(42_000)).toBe('42s');
    expect(formatDurationShort(4 * MINUTE + 12_000)).toBe('4m');
    expect(formatDurationShort(3 * HOUR + 24 * MINUTE)).toBe('3h 24m');
    expect(formatDurationShort(12 * DAY + 7 * HOUR + 34 * MINUTE)).toBe('12d 7h 34m');
    expect(formatDurationCompact(12 * DAY + 7 * HOUR)).toBe('12d');
    expect(formatDurationCompact(3 * HOUR + 24 * MINUTE)).toBe('3h');
  });

  it('formats human sentences with the requested number of units', () => {
    expect(formatDurationLong(3 * HOUR + 24 * MINUTE)).toBe('3 hours and 24 minutes');
    expect(formatDurationLong(1 * HOUR + 1 * MINUTE)).toBe('1 hour and 1 minute');
    expect(formatDurationLong(12 * DAY + 7 * HOUR + 34 * MINUTE, { maxUnits: 2 })).toBe('12 days and 7 hours');
    expect(formatDurationLong(12 * DAY + 7 * HOUR + 34 * MINUTE, { maxUnits: 3 })).toBe(
      '12 days, 7 hours and 34 minutes',
    );
    expect(formatDurationLong(0)).toBe('0 seconds');
  });

  it('formats ISO durations', () => {
    expect(formatDurationIso(0)).toBe('PT0S');
    expect(formatDurationIso(12 * DAY + 7 * HOUR + 34 * MINUTE)).toBe('P12DT7H34M');
  });
});

describe('timezone and calendar helpers', () => {
  it('computes UTC offsets, including daylight saving time', () => {
    expect(utcOffsetMinutesAt(Date.UTC(2026, 0, 15, 12), 'America/New_York')).toBe(-300);
    expect(utcOffsetMinutesAt(Date.UTC(2026, 6, 15, 12), 'America/New_York')).toBe(-240);
    expect(utcOffsetMinutesAt(Date.UTC(2026, 0, 15, 12), 'Asia/Dhaka')).toBe(360);
    expect(utcOffsetMinutesAt(Date.UTC(2026, 0, 15, 12), 'UTC')).toBe(0);
  });

  it('assigns instants to the correct local calendar day', () => {
    const instant = Date.UTC(2026, 0, 1, 0, 30); // 00:30 UTC
    expect(localDateKey(instant, 'UTC')).toBe('2026-01-01');
    expect(localDateKey(instant, 'Asia/Dhaka')).toBe('2026-01-01');
    expect(localDateKey(instant, 'America/New_York')).toBe('2025-12-31');
  });

  it('handles DST days: 23 and 25 hours long', () => {
    const springNoon = Date.UTC(2026, 2, 8, 17, 0); // 2026-03-08 12:00 EST (UTC-5); DST starts 02:00
    const springStart = startOfLocalDayMs(springNoon, 'America/New_York');
    expect(springStart).toBe(Date.UTC(2026, 2, 8, 5, 0));
    const springNext = startOfLocalDayMs(springStart + 25 * HOUR, 'America/New_York');
    expect(springNext).toBe(Date.UTC(2026, 2, 9, 4, 0));
    expect(springNext - springStart).toBe(23 * HOUR);

    const fallNoon = Date.UTC(2026, 10, 1, 17, 0); // 2026-11-01 12:00 EST after fall-back
    const fallStart = startOfLocalDayMs(fallNoon, 'America/New_York');
    const fallNext = startOfLocalDayMs(fallStart + 26 * HOUR, 'America/New_York');
    expect(fallNext - fallStart).toBe(25 * HOUR);
  });

  it('starts weeks on the configured first day', () => {
    const tuesday = Date.UTC(2026, 10, 10, 12); // Tuesday 2026-11-10
    expect(startOfLocalWeekMs(tuesday, 'UTC', 1)).toBe(Date.UTC(2026, 10, 9));
    expect(startOfLocalWeekMs(tuesday, 'UTC', 0)).toBe(Date.UTC(2026, 10, 8));
    expect(weekdayIndex(tuesday, 'UTC', 0)).toBe(2);
    expect(weekdayIndex(tuesday, 'UTC', 1)).toBe(1);
  });

  it('handles month and year boundaries', () => {
    const instant = Date.UTC(2026, 11, 31, 23, 30);
    expect(startOfLocalMonthMs(instant, 'UTC')).toBe(Date.UTC(2026, 11, 1));
    expect(startOfLocalYearMs(instant, 'UTC')).toBe(Date.UTC(2026, 0, 1));
    expect(localDateKey(instant, 'UTC')).toBe('2026-12-31');
    expect(localDateKey(instant, 'Asia/Dhaka')).toBe('2027-01-01');
  });

  it('enumerates period buckets reproducibly', () => {
    const buckets = enumeratePeriods(
      'month',
      Date.UTC(2026, 0, 15),
      Date.UTC(2026, 3, 10),
      'UTC',
      0,
    );
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(buckets[0]!.startAt).toBe(Date.UTC(2026, 0, 1));
    expect(buckets[3]!.endAt).toBe(Date.UTC(2026, 4, 1));
  });
});

describe('display formatting', () => {
  it('formats dates and times in every configured style', () => {
    const ms = Date.UTC(2026, 9, 29, 20, 30); // Oct 29, 2026 20:30 UTC
    expect(formatDate(ms, 'UTC', 'MMM d, yyyy')).toBe('Oct 29, 2026');
    expect(formatDate(ms, 'UTC', 'd MMM yyyy')).toBe('29 Oct 2026');
    expect(formatDate(ms, 'UTC', 'MM/dd/yyyy')).toBe('10/29/2026');
    expect(formatDate(ms, 'UTC', 'dd/MM/yyyy')).toBe('29/10/2026');
    expect(formatDate(ms, 'UTC', 'yyyy-MM-dd')).toBe('2026-10-29');
    expect(formatTimeOfDay(ms, 'UTC', '12h')).toBe('8:30 PM');
    expect(formatTimeOfDay(ms, 'UTC', '24h')).toBe('20:30');
    expect(formatDateTime(ms, 'UTC', 'MMM d, yyyy', '12h')).toBe('Oct 29, 2026, 8:30 PM');
  });

  it('formats relative days', () => {
    const now = Date.UTC(2026, 10, 10, 15);
    const today = Date.UTC(2026, 10, 10, 9, 42);
    const yesterday = Date.UTC(2026, 10, 9, 21, 10);
    const older = Date.UTC(2026, 9, 29, 20, 30);
    expect(formatRelativeDateTime(today, now, 'UTC', 'MMM d, yyyy', '12h')).toBe('Today, 9:42 AM');
    expect(formatRelativeDateTime(yesterday, now, 'UTC', 'MMM d, yyyy', '12h')).toBe('Yesterday, 9:10 PM');
    expect(formatRelativeDateTime(older, now, 'UTC', 'MMM d, yyyy', '12h')).toBe('Oct 29, 8:30 PM');
  });
});
