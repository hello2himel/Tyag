import { describe, expect, it } from 'vitest';
import { computeTrackerMetrics, type LapseEvent, type Tracker, type TrackerSession } from '../src/index';
import { DAY, HOUR, MINUTE, T0 } from './helpers';

function makeTracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 'tracker-1',
    name: 'Social media',
    description: null,
    status: 'active',
    startedAt: T0,
    startedTimeZone: 'UTC',
    startedUtcOffsetMinutes: 0,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    notes: null,
    reasons: null,
    reminderEnabled: false,
    reminderIntervalMinutes: null,
    ...overrides,
  };
}

function makeSession(trackerId: string, startedAt: number, endedAt: number | null): TrackerSession {
  return {
    id: `session-${startedAt}-${endedAt}`,
    trackerId,
    startedAt,
    endedAt,
    startKind: 'created',
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

function makeLapse(id: string, trackerId: string, occurredAt: number): LapseEvent {
  return {
    id,
    trackerId,
    occurredAt,
    occurredTimeZone: 'UTC',
    occurredUtcOffsetMinutes: 0,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    reason: null,
    trigger: null,
    triggerCategoryId: null,
    description: null,
    notes: null,
    context: null,
    retrospective: false,
  };
}

function compute(options: {
  tracker?: Partial<Tracker>;
  sessions?: TrackerSession[];
  lapses?: LapseEvent[];
  now: number;
  urges?: never[];
}) {
  const tracker = makeTracker(options.tracker);
  return computeTrackerMetrics({
    tracker,
    sessions: options.sessions ?? [makeSession(tracker.id, tracker.startedAt, null)],
    lapses: options.lapses ?? [],
    urges: [],
    journal: [],
    now: options.now,
  });
}

describe('streak engine, core definitions', () => {
  it('uses real elapsed time, not calendar-day differences', () => {
    const start = Date.UTC(2026, 10, 9, 20, 30); // 8:30 PM
    const now = Date.UTC(2026, 10, 10, 20, 0); // 8:00 PM next day
    const metrics = compute({ tracker: { startedAt: start }, now });
    expect(metrics.currentStreakMs).toBe(23 * HOUR + 30 * MINUTE);
    expect(metrics.accumulatedAbstinenceMs).toBe(23 * HOUR + 30 * MINUTE);
    expect(metrics.elapsedSinceStartMs).toBe(23 * HOUR + 30 * MINUTE);
  });

  it('resets the current streak at a lapse but keeps accumulated progress', () => {
    const lapse = makeLapse('l1', 'tracker-1', T0 + 10 * DAY);
    const metrics = compute({ lapses: [lapse], now: T0 + 12.5 * DAY });
    expect(metrics.currentStreakMs).toBe(2.5 * DAY);
    expect(metrics.accumulatedAbstinenceMs).toBe(12.5 * DAY);
    expect(metrics.completedAbstinenceMs).toBe(10 * DAY);
    expect(metrics.longestStreakMs).toBe(10 * DAY);
    expect(metrics.lapseCount).toBe(1);
    expect(metrics.streakCount).toBe(2);
    expect(metrics.averageBetweenLapsesMs).toBeNull();
    expect(metrics.timeSinceLastLapseMs).toBe(2.5 * DAY);
    expect(metrics.elapsedSinceStartMs).toBe(12.5 * DAY);
  });

  it('sorts events chronologically even when entered out of order', () => {
    const start = Date.UTC(2026, 0, 1);
    const lapses = [
      makeLapse('l3', 'tracker-1', start + 40 * DAY),
      makeLapse('l1', 'tracker-1', start + 10 * DAY),
      makeLapse('l2', 'tracker-1', start + 25 * DAY),
    ];
    const metrics = compute({ tracker: { startedAt: start }, lapses, now: start + 60 * DAY });
    expect(metrics.lapseCount).toBe(3);
    expect(metrics.currentStreakMs).toBe(20 * DAY);
    expect(metrics.longestStreakMs).toBe(20 * DAY);
    expect(metrics.accumulatedAbstinenceMs).toBe(60 * DAY);
    expect(metrics.averageBetweenLapsesMs).toBe(15 * DAY);
    expect(metrics.medianBetweenLapsesMs).toBe(15 * DAY);
    expect(metrics.averageStreakMs).toBe(15 * DAY);
    expect(metrics.lapsesPerActiveWeek).toBeCloseTo(3 / (60 / 7), 10);
  });

  it('computes average and median between lapses from the chronological record', () => {
    const start = Date.UTC(2026, 0, 1);
    const lapses = [10, 20, 40, 70].map((day) => makeLapse(`l${day}`, 'tracker-1', start + day * DAY));
    const metrics = compute({ tracker: { startedAt: start }, lapses, now: start + 80 * DAY });
    expect(metrics.currentStreakMs).toBe(10 * DAY);
    expect(metrics.longestStreakMs).toBe(30 * DAY);
    expect(metrics.averageBetweenLapsesMs).toBe(20 * DAY);
    expect(metrics.medianBetweenLapsesMs).toBe(20 * DAY);
    expect(metrics.accumulatedAbstinenceMs).toBe(80 * DAY);
  });

  it('updates every derived value after a backdated lapse is edited', () => {
    const before = compute({
      lapses: [makeLapse('l1', 'tracker-1', T0 + 10 * DAY)],
      now: T0 + 20 * DAY,
    });
    const after = compute({
      lapses: [makeLapse('l1', 'tracker-1', T0 + 5 * DAY)],
      now: T0 + 20 * DAY,
    });
    expect(before.currentStreakMs).toBe(10 * DAY);
    expect(after.currentStreakMs).toBe(15 * DAY);
    expect(before.longestStreakMs).toBe(10 * DAY);
    expect(after.longestStreakMs).toBe(15 * DAY);
    expect(before.accumulatedAbstinenceMs).toBe(after.accumulatedAbstinenceMs);
  });

  it('recomputes when a lapse is deleted', () => {
    const lapses = [
      makeLapse('l1', 'tracker-1', T0 + 10 * DAY),
      makeLapse('l2', 'tracker-1', T0 + 20 * DAY),
    ];
    const withBoth = compute({ lapses, now: T0 + 30 * DAY });
    const withOne = compute({ lapses: [lapses[0]!], now: T0 + 30 * DAY });
    expect(withBoth.currentStreakMs).toBe(10 * DAY);
    expect(withOne.currentStreakMs).toBe(20 * DAY);
    expect(withBoth.accumulatedAbstinenceMs).toBe(withOne.accumulatedAbstinenceMs);
  });

  it('never counts paused intervals as abstinence', () => {
    const start = Date.UTC(2026, 0, 1);
    const sessions = [
      makeSession('tracker-1', start, start + 5 * DAY),
      makeSession('tracker-1', start + 10 * DAY, start + 30 * DAY),
    ];
    const lapse = makeLapse('l1', 'tracker-1', start + 20 * DAY);
    const metrics = compute({ tracker: { startedAt: start }, sessions, lapses: [lapse], now: start + 30 * DAY });
    expect(metrics.activeTrackedMs).toBe(25 * DAY);
    expect(metrics.pausedMs).toBe(5 * DAY);
    expect(metrics.elapsedSinceStartMs).toBe(30 * DAY);
    expect(metrics.currentStreakMs).toBe(10 * DAY);
    expect(metrics.longestStreakMs).toBe(15 * DAY);
    expect(metrics.accumulatedAbstinenceMs).toBe(25 * DAY);
    expect(metrics.abstinenceShareOfElapsed).toBeCloseTo(25 / 30, 10);
    expect(metrics.activeShareOfElapsed).toBeCloseTo(25 / 30, 10);
  });

  it('freezes the streak clock while paused', () => {
    const start = Date.UTC(2026, 0, 1);
    const sessions = [makeSession('tracker-1', start, start + 5 * DAY)];
    const metrics = compute({ tracker: { startedAt: start, status: 'paused' }, sessions, now: start + 20 * DAY });
    expect(metrics.currentStreakMs).toBe(5 * DAY);
    expect(metrics.elapsedSinceStartMs).toBe(20 * DAY);
    expect(metrics.pausedMs).toBe(15 * DAY);
    expect(metrics.isRunning).toBe(false);
  });

  it('handles clock changes: a clock moved backwards never yields negative time', () => {
    const metrics = compute({ tracker: { startedAt: T0 }, now: T0 - 5 * DAY });
    expect(metrics.currentStreakMs).toBe(0);
    expect(metrics.elapsedSinceStartMs).toBe(0);
    expect(metrics.accumulatedAbstinenceMs).toBe(0);
    expect(metrics.abstinenceShareOfElapsed).toBeNull();
  });

  it('treats a lapse at the current instant as a zero-length current streak', () => {
    const metrics = compute({ lapses: [makeLapse('l1', 'tracker-1', T0 + 10 * DAY)], now: T0 + 10 * DAY });
    expect(metrics.currentStreakMs).toBe(0);
    expect(metrics.accumulatedAbstinenceMs).toBe(10 * DAY);
    expect(metrics.longestStreakMs).toBe(10 * DAY);
  });

  it('ignores impossible lapses recorded before the commitment start', () => {
    const metrics = compute({ lapses: [makeLapse('l1', 'tracker-1', T0 - DAY)], now: T0 + 10 * DAY });
    expect(metrics.lapseCount).toBe(0);
    expect(metrics.currentStreakMs).toBe(10 * DAY);
  });

  it('is independent of the device timezone', () => {
    const lapse = makeLapse('l1', 'tracker-1', T0 + 10 * DAY);
    const utc = compute({ tracker: { startedTimeZone: 'UTC', startedUtcOffsetMinutes: 0 }, lapses: [lapse], now: T0 + 12 * DAY });
    const dhaka = compute({
      tracker: { startedTimeZone: 'Asia/Dhaka', startedUtcOffsetMinutes: 360 },
      lapses: [lapse],
      now: T0 + 12 * DAY,
    });
    expect(dhaka.currentStreakMs).toBe(utc.currentStreakMs);
    expect(dhaka.accumulatedAbstinenceMs).toBe(utc.accumulatedAbstinenceMs);
    expect(dhaka.longestStreakMs).toBe(utc.longestStreakMs);
  });

  it('handles leap years and month boundaries with real elapsed time', () => {
    const start = Date.UTC(2028, 1, 28, 12); // Feb 28 2028 (leap year)
    const metrics = compute({ tracker: { startedAt: start }, now: Date.UTC(2028, 2, 1, 12) });
    expect(metrics.currentStreakMs).toBe(2 * DAY); // Feb 29 exists
    const nonLeapStart = Date.UTC(2026, 1, 28, 12);
    const nonLeap = compute({ tracker: { startedAt: nonLeapStart }, now: Date.UTC(2026, 2, 1, 12) });
    expect(nonLeap.currentStreakMs).toBe(1 * DAY);
  });

  it('merges overlapping sessions defensively instead of double counting', () => {
    const start = Date.UTC(2026, 0, 1);
    const sessions = [
      makeSession('tracker-1', start, start + 10 * DAY),
      makeSession('tracker-1', start + 5 * DAY, start + 15 * DAY),
    ];
    const metrics = compute({ tracker: { startedAt: start }, sessions, now: start + 20 * DAY });
    expect(metrics.activeTrackedMs).toBe(15 * DAY);
  });

  it('keeps separate trackers fully independent', () => {
    const a = compute({ tracker: { id: 'a', startedAt: T0 }, now: T0 + 10 * DAY });
    const b = compute({
      tracker: { id: 'b', startedAt: T0 + 5 * DAY },
      sessions: [makeSession('b', T0 + 5 * DAY, null)],
      lapses: [makeLapse('lb', 'b', T0 + 7 * DAY)],
      now: T0 + 10 * DAY,
    });
    expect(a.currentStreakMs).toBe(10 * DAY);
    expect(b.currentStreakMs).toBe(3 * DAY);
    expect(b.accumulatedAbstinenceMs).toBe(5 * DAY);
  });

  it('keeps accumulated abstinence and total elapsed time distinct', () => {
    const lapse = makeLapse('l1', 'tracker-1', T0 + 10 * DAY);
    const sessions = [
      makeSession('tracker-1', T0, T0 + 10 * DAY),
      makeSession('tracker-1', T0 + 20 * DAY, T0 + 30 * DAY),
    ];
    const metrics = compute({ sessions, lapses: [lapse], now: T0 + 30 * DAY });
    expect(metrics.elapsedSinceStartMs).toBe(30 * DAY);
    expect(metrics.accumulatedAbstinenceMs).toBe(20 * DAY);
    expect(metrics.currentStreakMs).toBe(10 * DAY);
    expect(metrics.pausedMs).toBe(10 * DAY);
  });
});
