/** Formatting helpers bound to the user's settings and effective timezone. */
import { useMemo } from 'react';
import {
  formatDate,
  formatDateCompact,
  formatDateTime,
  formatDurationCompact,
  formatDurationLong,
  formatDurationShort,
  formatRelativeDateTime,
  formatTimeOfDay,
  formatTimelineDate,
  formatWeekdayForFirstDay,
  formatWeekdayShort,
  type AppSettings,
} from '@deurge/core';
import { useApp } from '../store/app';

export function formatDurationFor(settings: AppSettings, ms: number, style?: 'short' | 'long' | 'compact'): string {
  const mode = style ?? settings.durationFormat;
  if (mode === 'long') return formatDurationLong(ms, { maxUnits: 3 });
  if (mode === 'compact') return formatDurationCompact(ms);
  return formatDurationShort(ms);
}

export interface Formatters {
  duration: (ms: number, style?: 'short' | 'long' | 'compact') => string;
  durationLong: (ms: number) => string;
  date: (epochMs: number) => string;
  dateCompact: (epochMs: number) => string;
  time: (epochMs: number) => string;
  dateTime: (epochMs: number) => string;
  relative: (epochMs: number) => string;
  timelineDate: (epochMs: number) => string;
  weekdayShort: (indexSundayFirst: number) => string;
  weekdayForFirstDay: (index: number) => string;
  monthShort: (month: number) => string;
}

export function useFormatters(): Formatters {
  const { settings, timeZone } = useApp();
  return useMemo<Formatters>(() => {
    const { dateFormat, timeFormat, firstDayOfWeek } = settings;
    return {
      duration: (ms, style) => formatDurationFor(settings, ms, style),
      durationLong: (ms) => formatDurationLong(ms, { maxUnits: 3 }),
      date: (epochMs) => formatDate(epochMs, timeZone, dateFormat),
      dateCompact: (epochMs) => formatDateCompact(epochMs, timeZone, Date.now()),
      time: (epochMs) => formatTimeOfDay(epochMs, timeZone, timeFormat),
      dateTime: (epochMs) => formatDateTime(epochMs, timeZone, dateFormat, timeFormat),
      relative: (epochMs) => formatRelativeDateTime(epochMs, Date.now(), timeZone, dateFormat, timeFormat),
      timelineDate: (epochMs) => formatTimelineDate(epochMs, Date.now(), timeZone),
      weekdayShort: (indexSundayFirst) => formatWeekdayShort(indexSundayFirst),
      weekdayForFirstDay: (index) => formatWeekdayForFirstDay(index, firstDayOfWeek),
      monthShort: (month) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month - 1] ?? '',
    };
  }, [settings, timeZone]);
}
