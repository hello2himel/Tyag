/**
 * Shared fixtures for the analytics/insights/backup/import/CSV test suites.
 * (The Lead owns `tests/helpers.ts`; engine-specific fixtures live here.)
 */
import { createTestCore, type TestCore } from '../helpers';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/**
 * A deterministic, reasonably rich database used by export/import/CSV tests:
 *
 *  - "Smoking" (active) started 20 days ago with 3 lapses, 2 urges,
 *    1 journal entry and 1 check-in.
 *  - "Sugar" started 5 days ago with 1 lapse, then paused 2 days ago.
 *
 * All records use explicit timestamps relative to the clock's `now`, so tests
 * can assert exact milliseconds.
 */
export interface SeedRecordIds {
  trackerId: string;
  secondTrackerId: string;
  lapseIds: string[];
  urgeIds: string[];
  journalIds: string[];
  checkInIds: string[];
}

export type SeededCore = TestCore & SeedRecordIds;

export async function seedRichCore(
  options: { now?: number; timeZone?: string } = {},
): Promise<SeededCore> {
  const test = await createTestCore(options);
  const { core, clock } = test;
  const now = clock.now();

  const lapseIds: string[] = [];
  const urgeIds: string[] = [];
  const journalIds: string[] = [];
  const checkInIds: string[] = [];

  clock.set(now - 20 * DAY);
  const primary = await core.trackers.create({
    name: 'Smoking',
    description: 'Daily habit',
    startedAt: now - 20 * DAY,
    notes: 'Morning and evening',
    reasons: 'Health',
  });
  const trackerId = primary.id;

  clock.set(now - 18 * DAY);
  lapseIds.push(
    (
      await core.lapses.create({
        trackerId,
        occurredAt: now - 18 * DAY,
        trigger: 'Stress',
        reason: 'Anxious',
        context: 'Evening',
        description: 'A hard day',
      })
    ).id,
  );
  clock.set(now - 15 * DAY);
  lapseIds.push(
    (await core.lapses.create({ trackerId, occurredAt: now - 15 * DAY, trigger: 'Stress', reason: 'Bored' })).id,
  );
  clock.set(now - 12 * DAY);
  lapseIds.push(
    (await core.lapses.create({ trackerId, occurredAt: now - 12 * DAY, trigger: 'Boredom' })).id,
  );

  clock.set(now - 9 * DAY);
  urgeIds.push(
    (
      await core.urges.create({
        trackerId,
        occurredAt: now - 9 * DAY,
        intensity: 6,
        trigger: 'Stress',
        outcome: 'passed',
        durationSeconds: 300,
      })
    ).id,
  );
  clock.set(now - 6 * DAY);
  urgeIds.push(
    (
      await core.urges.create({
        trackerId,
        occurredAt: now - 6 * DAY,
        intensity: 8,
        outcome: 'lapse',
        trigger: 'Boredom',
      })
    ).id,
  );

  clock.set(now - 3 * DAY);
  journalIds.push(
    (
      await core.journal.create({
        trackerId,
        occurredAt: now - 3 * DAY,
        title: 'Day 17',
        body: 'Felt better today.',
      })
    ).id,
  );

  clock.set(now - 2 * DAY);
  checkInIds.push(
    (
      await core.checkIns.create({
        trackerId,
        occurredAt: now - 2 * DAY,
        note: 'Calm evening',
        mood: 4,
      })
    ).id,
  );

  clock.set(now - 5 * DAY);
  const second = await core.trackers.create({ name: 'Sugar', startedAt: now - 5 * DAY });
  const secondTrackerId = second.id;
  clock.set(now - 3 * DAY);
  lapseIds.push((await core.lapses.create({ trackerId: secondTrackerId, occurredAt: now - 3 * DAY, trigger: 'Boredom' })).id);
  clock.set(now - 2 * DAY);
  await core.trackers.pause(secondTrackerId);

  clock.set(now);
  return { ...test, trackerId, secondTrackerId, lapseIds, urgeIds, journalIds, checkInIds };
}

/** Deep-clone JSON data through a string, mirroring a real export/import. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
