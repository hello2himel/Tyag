import { describe, expect, it } from 'vitest';
import {
  DeUrgeError,
  Temporal,
  MS_PER_DAY,
  MS_PER_HOUR,
} from '../src/index';
import type { Granularity } from '../src/index';
import { createTestCore, type TestCore } from './helpers';

const DAY = MS_PER_DAY;
const HOUR = MS_PER_HOUR;

/** Friday 2026-03-20 12:00 UTC. */
const NOW = Date.UTC(2026, 2, 20, 12, 0, 0);

/**
 * Build the canonical analytics scenario:
 *
 *  - started 10 days ago, paused for 1 day (day -8 .. day -7)
 *  - lapses at -9d, -8.5d, -6d, -2d
 *  - urges at -6.5d (4/10) and -1d (8/10)
 *  - journal entries at -3d and -0.5d, check-in at -1d
 *
 * Active time = 9 days, paused = 1 day, elapsed = 10 days, current streak
 * = 2 days, accumulated = 9 days, longest interval = 4 days.
 */
async function buildScenario(): Promise<{ test: TestCore; trackerId: string }> {
  const test = await createTestCore({ now: NOW, timeZone: 'UTC' });
  const { core, clock } = test;

  clock.set(NOW - 10 * DAY);
  const tracker = await core.trackers.create({ name: 'Smoking', startedAt: NOW - 10 * DAY });

  clock.set(NOW - 9 * DAY);
  await core.lapses.create({ trackerId: tracker.id, occurredAt: NOW - 9 * DAY, trigger: 'Stress', reason: 'Anxious', context: 'Evening' });
  clock.set(NOW - 8.5 * DAY);
  await core.lapses.create({ trackerId: tracker.id, occurredAt: NOW - 8.5 * DAY, trigger: 'Stress', reason: 'Bored' });
  clock.set(NOW - 8 * DAY);
  await core.trackers.pause(tracker.id);
  clock.set(NOW - 7 * DAY);
  await core.trackers.resume(tracker.id);
  clock.set(NOW - 6 * DAY);
  await core.lapses.create({ trackerId: tracker.id, occurredAt: NOW - 6 * DAY, trigger: 'Boredom' });
  clock.set(NOW - 6.5 * DAY);
  await core.urges.create({
    trackerId: tracker.id,
    occurredAt: NOW - 6.5 * DAY,
    intensity: 4,
    trigger: 'Boredom',
    outcome: 'passed',
  });
  clock.set(NOW - 2 * DAY);
  await core.lapses.create({ trackerId: tracker.id, occurredAt: NOW - 2 * DAY, trigger: 'Stress' });
  clock.set(NOW - 1 * DAY);
  await core.urges.create({
    trackerId: tracker.id,
    occurredAt: NOW - 1 * DAY,
    intensity: 8,
    trigger: 'Stress',
    outcome: 'lapse',
  });
  await core.journal.create({ trackerId: tracker.id, occurredAt: NOW - 3 * DAY, title: 'Day 17', body: 'Felt better.' });
  await core.journal.create({ trackerId: tracker.id, occurredAt: NOW - 1 * DAY, body: 'Still going.' });
  await core.checkIns.create({ trackerId: tracker.id, occurredAt: NOW - 1 * DAY, note: 'Calm', mood: 4 });
  clock.set(NOW);

  return { test, trackerId: tracker.id };
}

describe('analytics: tracker metrics', () => {
  it('distinguishes accumulated, current and elapsed time and excludes paused time', async () => {
    const { test, trackerId } = await buildScenario();
    const analytics = test.core.analytics.forTracker(trackerId);
    const metrics = analytics.metrics;

    expect(metrics.elapsedSinceStartMs).toBe(10 * DAY);
    expect(metrics.activeTrackedMs).toBe(9 * DAY);
    expect(metrics.pausedMs).toBe(1 * DAY);
    expect(metrics.accumulatedAbstinenceMs).toBe(9 * DAY);
    expect(metrics.completedAbstinenceMs).toBe(7 * DAY);
    expect(metrics.currentStreakMs).toBe(2 * DAY);
    expect(metrics.currentStreakStartAt).toBe(NOW - 2 * DAY);
    expect(metrics.longestStreakMs).toBe(4 * DAY);
    expect(metrics.lapseCount).toBe(4);
    expect(metrics.urgeCount).toBe(2);
    expect(metrics.averageUrgeIntensity).toBe(6);
    expect(metrics.abstinenceShareOfElapsed).toBeCloseTo(0.9, 10);
    expect(metrics.streakCount).toBe(5);
  });

  it('computes average and median time between lapses differently', async () => {
    const { test, trackerId } = await buildScenario();
    const metrics = test.core.analytics.forTracker(trackerId).metrics;
    // Completed middle intervals: 0.5d, 1.5d, 4d.
    expect(metrics.averageBetweenLapsesMs).toBe(2 * DAY);
    expect(metrics.medianBetweenLapsesMs).toBe(1.5 * DAY);
    // Average over all 5 intervals including the opening and current one.
    expect(metrics.averageStreakMs).toBe((9 * DAY) / 5);
  });
});

describe('analytics: period buckets', () => {
  it('buckets by local day and assigns events to the right bucket', async () => {
    const { test, trackerId } = await buildScenario();
    const analytics = test.core.analytics.forTracker(trackerId);
    const periods = analytics.periods;

    expect(periods.length).toBe(11); // Mar 10 .. Mar 20
    expect(periods[0]!.key).toBe('2026-03-10');
    expect(periods[0]!.startAt).toBe(NOW - 10 * DAY); // clipped to window start
    expect(periods[periods.length - 1]!.key).toBe('2026-03-20');
    expect(periods[periods.length - 1]!.endAt).toBe(NOW); // clipped to window end

    const sum = (pick: (bucket: (typeof periods)[number]) => number): number =>
      periods.reduce((total, bucket) => total + pick(bucket), 0);
    expect(sum((bucket) => bucket.activeMs)).toBe(9 * DAY);
    expect(sum((bucket) => bucket.abstinentMs)).toBe(9 * DAY);
    expect(sum((bucket) => bucket.lapseCount)).toBe(4);
    expect(sum((bucket) => bucket.urgeCount)).toBe(2);
    expect(sum((bucket) => bucket.journalCount)).toBe(2);
    expect(sum((bucket) => bucket.checkInCount)).toBe(1);

    const march14 = periods.find((bucket) => bucket.key === '2026-03-14')!;
    expect(march14.lapseCount).toBe(1);
    expect(march14.urgeCount).toBe(1);
    expect(march14.averageUrgeIntensity).toBe(4);

    // Paused day: only the first 12 hours of Mar 12 are active.
    const march12 = periods.find((bucket) => bucket.key === '2026-03-12')!;
    expect(march12.activeMs).toBe(12 * HOUR);
    const march13 = periods.find((bucket) => bucket.key === '2026-03-13')!;
    expect(march13.activeMs).toBe(12 * HOUR);
  });

  it('clips periods to an explicit window', async () => {
    const { test, trackerId } = await buildScenario();
    const analytics = test.core.analytics.forTracker(trackerId, {
      granularity: 'day',
      from: NOW - 2 * DAY,
      to: NOW,
    });
    expect(analytics.periods.map((bucket) => bucket.key)).toEqual([
      '2026-03-18',
      '2026-03-19',
      '2026-03-20',
    ]);
    expect(analytics.periods.reduce((total, bucket) => total + bucket.activeMs, 0)).toBe(2 * DAY);
    expect(analytics.periods.reduce((total, bucket) => total + bucket.lapseCount, 0)).toBe(1);
    expect(analytics.periods[0]!.startAt).toBe(NOW - 2 * DAY);
    expect(analytics.periods[2]!.endAt).toBe(NOW);
  });

  it('honours periodLimit by keeping the most recent buckets', async () => {
    const { test, trackerId } = await buildScenario();
    const analytics = test.core.analytics.forTracker(trackerId, { granularity: 'day', periodLimit: 3 });
    expect(analytics.periods.map((bucket) => bucket.key)).toEqual([
      '2026-03-18',
      '2026-03-19',
      '2026-03-20',
    ]);
  });

  it('supports every granularity', async () => {
    const { test, trackerId } = await buildScenario();
    for (const granularity of ['day', 'week', 'month', 'quarter', 'year'] as Granularity[]) {
      const analytics = test.core.analytics.forTracker(trackerId, { granularity });
      expect(analytics.periods.length).toBeGreaterThan(0);
      const last = analytics.periods[analytics.periods.length - 1]!;
      expect(last.endAt).toBe(NOW);
    }
  });
});

describe('analytics: distributions', () => {
  it('builds weekday, hour, trigger and outcome distributions', async () => {
    const { test, trackerId } = await buildScenario();
    const analytics = test.core.analytics.forTracker(trackerId);

    // March 2026: Mar 1 is a Sunday, so default firstDayOfWeek 0 = Sunday.
    expect(analytics.weekdayCounts).toHaveLength(7);
    expect(analytics.weekdayCounts.map((entry) => entry.count)).toEqual([0, 0, 0, 2, 1, 0, 1]);
    expect(analytics.weekdayCounts.map((entry) => entry.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(analytics.weekdayCounts[3]!.share).toBeCloseTo(0.5, 10);
    expect(analytics.weekdayCounts.reduce((total, entry) => total + entry.share, 0)).toBeCloseTo(1, 10);

    expect(analytics.hourCounts).toHaveLength(24);
    expect(analytics.hourCounts[0]!.count).toBe(1); // Mar 12 00:00 UTC
    expect(analytics.hourCounts[12]!.count).toBe(3);

    expect(analytics.lapseTriggers).toEqual([
      { label: 'Stress', count: 3 },
      { label: 'Boredom', count: 1 },
    ]);
    expect(analytics.lapseReasons).toEqual([{ label: 'Anxious', count: 1 }, { label: 'Bored', count: 1 }]);
    expect(analytics.lapseContexts).toEqual([{ label: 'Evening', count: 1 }]);

    expect(analytics.urgeTriggers).toEqual([
      { label: 'Boredom', count: 1 },
      { label: 'Stress', count: 1 },
    ]);
    expect(analytics.urgeOutcomes).toEqual([
      { value: 'passed', count: 1, share: 0.5 },
      { value: 'lapse', count: 1, share: 0.5 },
      { value: 'unknown', count: 0, share: 0 },
    ]);

    expect(analytics.journalDays).toEqual(['2026-03-17', '2026-03-19']);
  });

  it('honours firstDayOfWeek for the weekday distribution', async () => {
    const { test, trackerId } = await buildScenario();
    await test.core.settings.update({ firstDayOfWeek: 1 });
    const analytics = test.core.analytics.forTracker(trackerId);
    // Monday-first: Wednesday becomes index 2, Thursday 3, Saturday 5.
    expect(analytics.weekdayCounts.map((entry) => entry.count)).toEqual([0, 0, 2, 1, 0, 1, 0]);
  });

  it('uses the effective timezone for local weekday and hour grouping', async () => {
    const test = await createTestCore({ now: Date.UTC(2026, 0, 5, 12, 0, 0), timeZone: 'America/New_York' });
    const { core, clock } = test;
    clock.set(Date.UTC(2025, 11, 30, 12, 0, 0));
    const tracker = await core.trackers.create({
      name: 'Late nights',
      startedAt: Date.UTC(2025, 11, 30, 12, 0, 0),
    });
    // 2026-01-01T03:30:00Z is 2025-12-31 22:30 in New York (New Year's Eve).
    clock.set(Date.UTC(2026, 0, 1, 5, 0, 0));
    await core.lapses.create({
      trackerId: tracker.id,
      occurredAt: Date.UTC(2026, 0, 1, 3, 30, 0),
      occurredTimeZone: 'America/New_York',
    });
    clock.set(Date.UTC(2026, 0, 5, 12, 0, 0));
    const analytics = core.analytics.forTracker(tracker.id, { granularity: 'day' });
    const wednesday = 3; // 2025-12-31 was a Wednesday (Sunday index 3)
    expect(analytics.weekdayCounts[wednesday]!.count).toBe(1);
    expect(analytics.hourCounts[22]!.count).toBe(1);
    expect(analytics.journalDays).toEqual([]);
  });
});

describe('analytics: combined view', () => {
  it('counts trackers and sums tracker-time across trackers', async () => {
    const { test, trackerId } = await buildScenario();
    const { core, clock } = test;
    clock.set(NOW - 5 * DAY);
    const second = await core.trackers.create({ name: 'Sugar', startedAt: NOW - 5 * DAY });
    clock.set(NOW - 2 * DAY);
    await core.trackers.pause(second.id);
    clock.set(NOW);

    const combined = core.analytics.combined({ granularity: 'day', from: NOW - 10 * DAY, to: NOW });
    expect(combined.trackerCount).toBe(2);
    expect(combined.activeTrackerCount).toBe(1);
    expect(combined.pausedTrackerCount).toBe(1);
    expect(combined.archivedTrackerCount).toBe(0);
    // Tracker-time: 9 days + 3 days even though only 10 days passed.
    expect(combined.totalAccumulatedAbstinenceMs).toBe(12 * DAY);
    expect(combined.totalLapseCount).toBe(4);
    expect(combined.totalUrgeCount).toBe(2);
    expect(combined.averageUrgeIntensity).toBe(6);
    expect(combined.trackers).toHaveLength(2);
    expect(combined.trackers.map((metrics) => metrics.trackerId).sort()).toEqual(
      [trackerId, second.id].sort(),
    );
    const activeSum = combined.periods.reduce((total, bucket) => total + bucket.activeMs, 0);
    expect(activeSum).toBe(12 * DAY);
    expect(combined.lapseTriggers).toEqual([
      { label: 'Stress', count: 3 },
      { label: 'Boredom', count: 1 },
    ]);
  });

  it('returns honest empty values when no trackers exist', async () => {
    const test = await createTestCore({ now: NOW });
    const combined = test.core.analytics.combined();
    expect(combined.trackerCount).toBe(0);
    expect(combined.trackers).toEqual([]);
    expect(combined.periods).toEqual([]);
    expect(combined.totalAccumulatedAbstinenceMs).toBe(0);
    expect(combined.totalLapseCount).toBe(0);
    expect(combined.totalUrgeCount).toBe(0);
    expect(combined.averageUrgeIntensity).toBeNull();
    expect(combined.weekdayCounts).toHaveLength(7);
    expect(combined.weekdayCounts.every((entry) => entry.count === 0)).toBe(true);
  });
});

describe('analytics: insufficient data', () => {
  it('returns zeroed metrics and empty distributions for a brand-new tracker', async () => {
    const test = await createTestCore({ now: NOW });
    const tracker = await test.core.trackers.create({ name: 'New', startedAt: NOW });
    const analytics = test.core.analytics.forTracker(tracker.id);
    expect(analytics.metrics.activeTrackedMs).toBe(0);
    expect(analytics.metrics.accumulatedAbstinenceMs).toBe(0);
    expect(analytics.metrics.currentStreakMs).toBe(0);
    expect(analytics.metrics.averageBetweenLapsesMs).toBeNull();
    expect(analytics.metrics.medianBetweenLapsesMs).toBeNull();
    expect(analytics.metrics.averageUrgeIntensity).toBeNull();
    expect(analytics.metrics.lapsesPerActiveWeek).toBeNull();
    expect(analytics.metrics.abstinenceShareOfElapsed).toBeNull();
    expect(analytics.periods).toEqual([]);
    expect(analytics.lapseTriggers).toEqual([]);
    expect(analytics.urgeTriggers).toEqual([]);
    expect(analytics.journalDays).toEqual([]);
    expect(analytics.weekdayCounts).toHaveLength(7);
    expect(analytics.hourCounts).toHaveLength(24);
    expect(analytics.urgeOutcomes).toEqual([
      { value: 'passed', count: 0, share: 0 },
      { value: 'lapse', count: 0, share: 0 },
      { value: 'unknown', count: 0, share: 0 },
    ]);
  });

  it('rejects unknown trackers and invalid options', async () => {
    const test = await createTestCore({ now: NOW });
    expect(() => test.core.analytics.forTracker('missing-tracker')).toThrow(DeUrgeError);
    try {
      test.core.analytics.forTracker('missing-tracker');
    } catch (error) {
      expect((error as DeUrgeError).code).toBe('NOT_FOUND');
    }
    const tracker = await test.core.trackers.create({ name: 'New', startedAt: NOW });

    expect(() =>
      test.core.analytics.forTracker(tracker.id, { granularity: 'hour' as unknown as Granularity }),
    ).toThrow(DeUrgeError);
    expect(() =>
      test.core.analytics.forTracker(tracker.id, { from: Number.NaN }),
    ).toThrow(DeUrgeError);
    expect(() =>
      test.core.analytics.forTracker(tracker.id, { periodLimit: Number.POSITIVE_INFINITY }),
    ).toThrow(DeUrgeError);
  });
});

describe('analytics: DST-correct local periods', () => {
  const TZ = 'America/New_York';
  const localMidnight = (year: number, month: number, day: number): number =>
    Temporal.ZonedDateTime.from({ timeZone: TZ, year, month, day }).toInstant().epochMilliseconds;

  async function buildDstScenario(): Promise<{ test: TestCore; trackerId: string; oct25: number; nov1: number; nov8: number; nov9: number }> {
    const oct25 = localMidnight(2026, 10, 25);
    const nov1 = localMidnight(2026, 11, 1);
    const nov8 = localMidnight(2026, 11, 8);
    const nov9 = localMidnight(2026, 11, 9);
    const test = await createTestCore({ now: nov9 + 12 * HOUR, timeZone: TZ });
    test.clock.set(nov9 + 12 * HOUR);
    const tracker = await test.core.trackers.create({ name: 'DST tracker', startedAt: oct25 });
    return { test, trackerId: tracker.id, oct25, nov1, nov8, nov9 };
  }

  it('measures the 169-hour week that contains the DST fall-back', async () => {
    const { test, trackerId, oct25, nov1, nov8, nov9 } = await buildDstScenario();
    const analytics = test.core.analytics.forTracker(trackerId, {
      granularity: 'week',
      from: oct25,
      to: nov8,
    });
    expect(analytics.periods).toHaveLength(2);
    expect(analytics.periods[0]!.startAt).toBe(oct25);
    expect(analytics.periods[0]!.endAt).toBe(nov1);
    expect(analytics.periods[0]!.endAt - analytics.periods[0]!.startAt).toBe(7 * 24 * HOUR);
    expect(analytics.periods[1]!.endAt - analytics.periods[1]!.startAt).toBe(7 * 24 * HOUR + HOUR);
    // The tracker is running throughout, so active time equals the bucket span.
    expect(analytics.periods[1]!.activeMs).toBe(7 * 24 * HOUR + HOUR);
    expect(analytics.metrics.activeTrackedMs).toBe(nov9 + 12 * HOUR - oct25);
  });

  it('measures the 25-hour local day of the fall-back', async () => {
    const { test, trackerId, nov1 } = await buildDstScenario();
    const analytics = test.core.analytics.forTracker(trackerId, {
      granularity: 'day',
      from: nov1 - 24 * HOUR,
      to: localMidnight(2026, 11, 3),
    });
    const byKey = new Map(analytics.periods.map((bucket) => [bucket.key, bucket]));
    expect(byKey.get('2026-10-31')!.endAt - byKey.get('2026-10-31')!.startAt).toBe(24 * HOUR);
    expect(byKey.get('2026-11-01')!.endAt - byKey.get('2026-11-01')!.startAt).toBe(25 * HOUR);
    expect(byKey.get('2026-11-02')!.endAt - byKey.get('2026-11-02')!.startAt).toBe(24 * HOUR);
  });

  it('honours firstDayOfWeek when building week buckets', async () => {
    const { test, trackerId, oct25, nov1, nov8, nov9 } = await buildDstScenario();
    await test.core.settings.update({ firstDayOfWeek: 1 });
    const analytics = test.core.analytics.forTracker(trackerId, {
      granularity: 'week',
      from: nov1 - 6 * 24 * HOUR, // Mon Oct 26 00:00 local
      to: nov9,
    });
    void oct25;
    void nov8;
    expect(analytics.periods.map((bucket) => bucket.key)).toEqual(['W2026-10-26', 'W2026-11-02']);
    expect(analytics.periods[0]!.endAt - analytics.periods[0]!.startAt).toBe(7 * 24 * HOUR + HOUR);
    expect(analytics.periods[1]!.endAt - analytics.periods[1]!.startAt).toBe(7 * 24 * HOUR);
  });
});
