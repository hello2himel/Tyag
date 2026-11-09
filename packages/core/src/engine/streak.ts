/**
 * Deterministic streak and abstinence calculation engine.
 *
 * Definitions (see docs/CALCULATION_RULES.md for the user-facing version):
 *
 *  - An *active interval* is a tracker session clipped to `[startedAt, now]`.
 *    Paused time is therefore never counted.
 *  - An *uninterrupted interval* starts at the commitment start (or right
 *    after a lapse) and ends at the next lapse, or at `now` for the current
 *    interval.
 *  - `currentStreakMs` is the active time inside the current interval.
 *  - `longestStreakMs` is the largest active time of any interval.
 *  - `accumulatedAbstinenceMs` is the sum of active time over all intervals,
 *    which equals all non-paused time since `startedAt` — every previous
 *    streak stays counted after a lapse.
 *  - `elapsedSinceStartMs` is wall-clock time and is *not* abstinence.
 *
 * Everything is recomputed from stored timestamps, so identical records always
 * produce identical numbers regardless of timers, time zones, DST or restarts.
 */
import type { JournalEntry, LapseEvent, StreakInterval, Tracker, TrackerMetrics, TrackerSession, UrgeEvent } from '../domain';
import { MS_PER_DAY } from '../time/temporal';

export interface TrackerMetricsInput {
  tracker: Tracker;
  sessions: TrackerSession[];
  lapses: LapseEvent[];
  urges: UrgeEvent[];
  journal: JournalEntry[];
  now: number;
}

interface ActiveInterval {
  start: number;
  end: number;
}

const MS_PER_WEEK = MS_PER_DAY * 7;
/** Average Gregorian month length (365.2425 / 12 days). */
const MS_PER_MONTH = 30.436875 * MS_PER_DAY;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Build a defensively normalised union of active intervals. */
export function buildActiveIntervals(
  tracker: Tracker,
  sessions: TrackerSession[],
  now: number,
): ActiveInterval[] {
  const startLimit = tracker.startedAt;
  const endLimit = Math.max(now, startLimit);
  const raw: ActiveInterval[] = [];
  for (const session of sessions) {
    const start = Math.max(session.startedAt, startLimit);
    const end = Math.min(session.endedAt === null ? now : session.endedAt, endLimit);
    if (end > start) raw.push({ start, end });
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ActiveInterval[] = [];
  for (const interval of raw) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/** Active time inside `[from, to)` for sorted, disjoint intervals. */
function activeOverlap(intervals: ActiveInterval[], from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  for (const interval of intervals) {
    if (interval.end <= from) continue;
    if (interval.start >= to) break;
    total += Math.min(interval.end, to) - Math.max(interval.start, from);
  }
  return total;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeTrackerMetrics(input: TrackerMetricsInput): TrackerMetrics {
  const { tracker, sessions, lapses, urges, journal, now } = input;
  const clampedNow = Math.max(now, 0);
  const elapsedSinceStartMs = Math.max(0, clampedNow - tracker.startedAt);
  const elapsedSinceCreatedMs = Math.max(0, clampedNow - tracker.createdAt);
  const activeIntervals = buildActiveIntervals(tracker, sessions, clampedNow);
  const activeTrackedMs = activeIntervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0);

  // Lapses are always evaluated chronologically, never in entry order. Lapses
  // before the commitment start cannot end an interval that never began.
  const sortedLapses = [...lapses]
    .filter((lapse) => lapse.occurredAt >= tracker.startedAt)
    .sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));

  const boundaries: { at: number; lapse: LapseEvent | null }[] = [
    { at: tracker.startedAt, lapse: null },
    ...sortedLapses.map((lapse) => ({ at: lapse.occurredAt, lapse })),
  ];

  const intervals: StreakInterval[] = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const startAt = boundaries[i]!.at;
    const isCurrent = i === boundaries.length - 1;
    const endAt = isCurrent ? Math.max(clampedNow, startAt) : boundaries[i + 1]!.at;
    const activeMs = activeOverlap(activeIntervals, startAt, endAt);
    intervals.push({
      startAt,
      endAt,
      activeMs,
      isCurrent,
      endedByLapseId: isCurrent ? null : boundaries[i + 1]!.lapse?.id ?? null,
    });
  }

  const longestStreak = intervals.reduce<StreakInterval | null>((best, interval) => {
    if (!best) return interval.activeMs > 0 ? interval : best;
    if (interval.activeMs > best.activeMs) return interval;
    return best;
  }, null);

  const current = intervals[intervals.length - 1] ?? {
    startAt: tracker.startedAt,
    endAt: clampedNow,
    activeMs: 0,
    isCurrent: true,
    endedByLapseId: null,
  };

  // Active time between consecutive lapses (excludes the interval that began
  // at the commitment start, and the still-running interval).
  const betweenIntervals: number[] = [];
  for (let i = 1; i < intervals.length - 1; i += 1) {
    betweenIntervals.push(intervals[i]!.activeMs);
  }
  const lastLapse = sortedLapses.length > 0 ? sortedLapses[sortedLapses.length - 1]! : null;

  const urgeIntensities = urges.map((urge) => urge.intensity).filter((value) => Number.isFinite(value));
  const journalCount = journal.filter((entry) => entry.trackerId === tracker.id).length;

  const accumulatedAbstinenceMs = activeTrackedMs;
  const completedAbstinenceMs = Math.max(0, accumulatedAbstinenceMs - current.activeMs);
  const streakCount = intervals.length;

  return {
    trackerId: tracker.id,
    status: tracker.status,
    now: clampedNow,
    elapsedSinceStartMs,
    elapsedSinceCreatedMs,
    activeTrackedMs,
    pausedMs: Math.max(0, elapsedSinceStartMs - activeTrackedMs),
    currentStreakMs: current.activeMs,
    currentStreakStartAt: current.startAt,
    longestStreakMs: longestStreak?.activeMs ?? 0,
    longestStreak,
    accumulatedAbstinenceMs,
    completedAbstinenceMs,
    lapseCount: sortedLapses.length,
    urgeCount: urges.length,
    journalCount,
    lastLapseAt: lastLapse ? lastLapse.occurredAt : null,
    timeSinceLastLapseMs: lastLapse ? Math.max(0, clampedNow - lastLapse.occurredAt) : null,
    intervals,
    streakCount,
    averageStreakMs: streakCount > 0 ? accumulatedAbstinenceMs / streakCount : null,
    averageBetweenLapsesMs: mean(betweenIntervals),
    medianBetweenLapsesMs: median(betweenIntervals),
    abstinenceShareOfElapsed:
      elapsedSinceStartMs > 0 ? clamp(accumulatedAbstinenceMs / elapsedSinceStartMs, 0, 1) : null,
    activeShareOfElapsed: elapsedSinceStartMs > 0 ? clamp(activeTrackedMs / elapsedSinceStartMs, 0, 1) : null,
    lapsesPerActiveWeek: activeTrackedMs > 0 ? sortedLapses.length / (activeTrackedMs / MS_PER_WEEK) : null,
    lapsesPerActiveMonth: activeTrackedMs > 0 ? sortedLapses.length / (activeTrackedMs / MS_PER_MONTH) : null,
    averageUrgeIntensity: mean(urgeIntensities),
    isRunning: tracker.status === 'active',
  };
}

/** Convenience: current streak for a tracker with its loaded history. */
export function currentStreakMs(
  tracker: Tracker,
  sessions: TrackerSession[],
  lapses: LapseEvent[],
  now: number,
): number {
  return computeTrackerMetrics({ tracker, sessions, lapses, urges: [], journal: [], now }).currentStreakMs;
}
