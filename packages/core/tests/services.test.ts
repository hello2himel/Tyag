import { describe, expect, it } from 'vitest';
import { TyagError, isTyagError } from '../src/index';
import { createTestCore, reopenTestCore, DAY, HOUR, T0 } from './helpers';

async function expectTyagError(promise: Promise<unknown>, code: string, detail?: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected TyagError to be thrown');
  } catch (error) {
    expect(isTyagError(error)).toBe(true);
    const TyagError = error as TyagError;
    expect(TyagError.code).toBe(code);
    if (detail) expect(TyagError.message).toContain(detail);
  }
}

describe('tracker lifecycle', () => {
  it('creates a tracker with an open session and initial history', async () => {
    const { core } = await createTestCore();
    const tracker = await core.trackers.create({ name: '  Social media  ', description: 'Doomscrolling' });
    expect(tracker.name).toBe('Social media');
    expect(tracker.status).toBe('active');
    expect(tracker.startedAt).toBe(T0);
    expect(tracker.startedUtcOffsetMinutes).toBe(0);
    const sessions = core.db.all<{ started_at: number; ended_at: number | null }>(
      'SELECT started_at, ended_at FROM tracker_sessions WHERE tracker_id = ?',
      [tracker.id],
    );
    expect(sessions).toEqual([{ started_at: T0, ended_at: null }]);
    const history = core.history.list({ trackerId: tracker.id });
    expect(history.map((item) => item.event.type)).toEqual(['tracker_started', 'tracker_created']);
    expect(core.metrics(tracker.id).currentStreakMs).toBe(0);
  });

  it('validates tracker names and backdated starts', async () => {
    const { core } = await createTestCore();
    await expectTyagError(core.trackers.create({ name: '   ' }), 'VALIDATION');
    await expectTyagError(core.trackers.create({ name: 'x', startedAt: T0 + DAY }), 'VALIDATION', 'future');
    const backdated = await core.trackers.create({ name: 'Backdated', startedAt: T0 - 5 * DAY });
    expect(backdated.startedAt).toBe(T0 - 5 * DAY);
    expect(core.metrics(backdated.id).currentStreakMs).toBe(5 * DAY);
  });

  it('pauses and resumes without counting paused time', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'Gaming' });
    clock.advance(5 * DAY);
    const paused = await core.trackers.pause(tracker.id);
    expect(paused.status).toBe('paused');
    clock.advance(10 * DAY);
    expect(core.metrics(tracker.id).currentStreakMs).toBe(5 * DAY);
    expect(core.metrics(tracker.id).pausedMs).toBe(10 * DAY);
    const resumed = await core.trackers.resume(tracker.id);
    expect(resumed.status).toBe('active');
    clock.advance(5 * DAY);
    const metrics = core.metrics(tracker.id);
    expect(metrics.currentStreakMs).toBe(10 * DAY);
    expect(metrics.activeTrackedMs).toBe(10 * DAY);
    expect(metrics.elapsedSinceStartMs).toBe(20 * DAY);
    expect(metrics.pausedMs).toBe(10 * DAY);
    const types = core.history.list({ trackerId: tracker.id }).map((item) => item.event.type);
    expect(types).toEqual(['tracker_resumed', 'tracker_paused', 'tracker_started', 'tracker_created']);
  });

  it('archives, restores paused, and resumes explicitly', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'Browsing' });
    clock.advance(2 * DAY);
    await core.trackers.archive(tracker.id);
    clock.advance(5 * DAY);
    expect(core.trackers.get(tracker.id).status).toBe('archived');
    expect(core.metrics(tracker.id).currentStreakMs).toBe(2 * DAY);
    const restored = await core.trackers.restore(tracker.id);
    expect(restored.status).toBe('paused');
    expect(restored.archivedAt).toBeNull();
    await core.trackers.resume(tracker.id);
    clock.advance(3 * DAY);
    expect(core.metrics(tracker.id).currentStreakMs).toBe(5 * DAY);
  });

  it('rejects invalid status transitions', async () => {
    const { core } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    await expectTyagError(core.trackers.resume(tracker.id), 'CONFLICT');
    await expectTyagError(core.trackers.restore(tracker.id), 'CONFLICT');
    await core.trackers.pause(tracker.id);
    await expectTyagError(core.trackers.pause(tracker.id), 'CONFLICT');
    await expectTyagError(core.trackers.archive(tracker.id).then(() => core.trackers.archive(tracker.id)), 'CONFLICT');
  });

  it('edits tracker details and start time, adjusting active sessions', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'Late night gaming' });
    clock.advance(10 * DAY);
    const updated = await core.trackers.update(tracker.id, {
      name: 'Late-night gaming',
      startedAt: T0 - 5 * DAY,
      description: 'After midnight',
    });
    expect(updated.name).toBe('Late-night gaming');
    expect(updated.startedAt).toBe(T0 - 5 * DAY);
    expect(core.metrics(tracker.id).currentStreakMs).toBe(15 * DAY);
    const shortened = await core.trackers.update(tracker.id, { startedAt: T0 + 1 * DAY });
    expect(shortened.startedAt).toBe(T0 + 1 * DAY);
    expect(core.metrics(tracker.id).currentStreakMs).toBe(9 * DAY);
    const history = core.history.list({ trackerId: tracker.id })
      .filter((item) => item.event.type === 'tracker_updated')
      .map((item) => item.detail);
    expect(history[0]).toContain('startedAt');
  });

  it('will not move the start after a recorded lapse', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(5 * DAY);
    await core.lapses.create({ trackerId: tracker.id, occurredAt: T0 + 2 * DAY });
    await expectTyagError(
      core.trackers.update(tracker.id, { startedAt: T0 + 3 * DAY }),
      'VALIDATION',
      'recorded events',
    );
  });

  it('lists trackers by status with active first', async () => {
    const { core } = await createTestCore();
    const active = await core.trackers.create({ name: 'Active' });
    const paused = await core.trackers.create({ name: 'Paused' });
    const archived = await core.trackers.create({ name: 'Archived' });
    await core.trackers.pause(paused.id);
    await core.trackers.archive(archived.id);
    expect(core.trackers.list().map((tracker) => tracker.name)).toEqual(['Active', 'Paused', 'Archived']);
  });
});

describe('lapses and urges', () => {
  it('records a lapse, ends the streak, and keeps accumulated progress', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'Social media' });
    clock.advance(10 * DAY);
    const lapse = await core.lapses.create({
      trackerId: tracker.id,
      trigger: 'Stress',
      triggerCategoryId: 'default-trigger-stress',
      notes: 'Hard day',
    });
    expect(lapse.occurredAt).toBe(T0 + 10 * DAY);
    expect(lapse.trigger).toBe('Stress');
    expect(lapse.retrospective).toBe(false);
    clock.advance(2 * DAY);
    const metrics = core.metrics(tracker.id);
    expect(metrics.currentStreakMs).toBe(2 * DAY);
    expect(metrics.accumulatedAbstinenceMs).toBe(12 * DAY);
    expect(metrics.lapseCount).toBe(1);
    const record = core.history.list({ trackerId: tracker.id }).find((item) => item.event.type === 'lapse_recorded');
    expect(record?.title).toBe('Lapse');
    expect(record?.detail).toContain('Stress');
  });

  it('validates lapse times and category references', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(1 * DAY);
    await expectTyagError(
      core.lapses.create({ trackerId: tracker.id, occurredAt: T0 - DAY }),
      'VALIDATION',
      'before this tracker started',
    );
    await expectTyagError(
      core.lapses.create({ trackerId: tracker.id, occurredAt: T0 + 5 * DAY }),
      'VALIDATION',
      'future',
    );
    await expectTyagError(
      core.lapses.create({ trackerId: tracker.id, triggerCategoryId: 'does-not-exist' }),
      'VALIDATION',
      'no longer exists',
    );
    await expectTyagError(
      core.urges.create({ trackerId: tracker.id, intensity: 11 }),
      'VALIDATION',
    );
    await expectTyagError(
      core.lapses.create({ trackerId: 'missing' }),
      'NOT_FOUND',
    );
  });

  it('marks events entered later as retrospective', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(2 * DAY);
    const lapse = await core.lapses.create({ trackerId: tracker.id, occurredAt: T0 });
    expect(lapse.retrospective).toBe(true);
    const urgent = await core.urges.create({ trackerId: tracker.id, occurredAt: T0 + HOUR, intensity: 7 });
    expect(urgent.retrospective).toBe(true);
  });

  it('edits and deletes lapses, recalculating and preserving the journal of changes', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(10 * DAY);
    const lapse = await core.lapses.create({ trackerId: tracker.id, occurredAt: T0 + 8 * DAY });
    clock.advance(2 * DAY);
    expect(core.metrics(tracker.id).currentStreakMs).toBe(4 * DAY);
    await core.lapses.update(lapse.id, { occurredAt: T0 + 5 * DAY, notes: 'Moved' });
    expect(core.metrics(tracker.id).currentStreakMs).toBe(7 * DAY);
    const types = core.history.list({ trackerId: tracker.id }).map((item) => item.event.type);
    expect(types).toContain('lapse_updated');
    await core.lapses.delete(lapse.id);
    expect(core.metrics(tracker.id).currentStreakMs).toBe(12 * DAY);
    expect(core.lapses.list(tracker.id)).toHaveLength(0);
    expect(core.history.list({ trackerId: tracker.id }).map((item) => item.event.type)).toContain('lapse_deleted');
  });

  it('recording an urge never changes the streak', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(3 * DAY);
    const before = core.metrics(tracker.id);
    await core.urges.create({
      trackerId: tracker.id,
      intensity: 8,
      trigger: 'Boredom',
      triggerCategoryId: 'default-trigger-boredom',
      outcome: 'passed',
      durationSeconds: 300,
    });
    const after = core.metrics(tracker.id);
    expect(after.currentStreakMs).toBe(before.currentStreakMs);
    expect(after.accumulatedAbstinenceMs).toBe(before.accumulatedAbstinenceMs);
    expect(after.lapseCount).toBe(0);
    expect(after.urgeCount).toBe(1);
    expect(after.averageUrgeIntensity).toBe(8);
  });

  it('edits and deletes urges', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(DAY);
    const urge = await core.urges.create({ trackerId: tracker.id, intensity: 4, outcome: 'passed' });
    await core.urges.update(urge.id, { intensity: 9, outcome: 'lapse', notes: 'Tough' });
    const updated = core.urges.get(urge.id);
    expect(updated.intensity).toBe(9);
    expect(updated.outcome).toBe('lapse');
    await core.urges.delete(urge.id);
    expect(core.urges.list(tracker.id)).toHaveLength(0);
    expect(core.history.list().map((item) => item.event.type)).toEqual(
      expect.arrayContaining(['urge_recorded', 'urge_updated', 'urge_deleted']),
    );
  });
});

describe('journal and history', () => {
  it('creates, edits, deletes and searches journal entries', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'Social media' });
    clock.advance(DAY);
    const entry = await core.journal.create({
      trackerId: tracker.id,
      title: 'Easier evenings',
      body: 'I went for a walk instead of scrolling.',
    });
    expect(entry.body).toContain('walk');
    expect(core.journal.list({ trackerId: tracker.id })).toHaveLength(1);
    expect(core.journal.list({ search: 'scrolling' })).toHaveLength(1);
    expect(core.journal.list({ search: 'nothing-matches' })).toHaveLength(0);
    await core.journal.update(entry.id, { body: 'I went for a longer walk.' });
    expect(core.journal.get(entry.id).body).toContain('longer');
    const history = core.history.list({ trackerId: tracker.id, types: ['journal_entry_created'] });
    expect(history[0]?.detail).toContain('walk');
    await core.journal.delete(entry.id);
    expect(core.journal.list({ trackerId: tracker.id })).toHaveLength(0);
    expect(core.history.list().map((item) => item.event.type)).toContain('journal_entry_deleted');
  });

  it('filters history by tracker, type, date range and search text', async () => {
    const { core, clock } = await createTestCore();
    const a = await core.trackers.create({ name: 'Alpha' });
    const b = await core.trackers.create({ name: 'Beta' });
    clock.advance(DAY);
    await core.lapses.create({ trackerId: a.id, trigger: 'Boredom', notes: 'Sunday afternoon' });
    await core.urges.create({ trackerId: b.id, intensity: 6, notes: 'Restless' });
    const trackersOnly = core.history.list({ trackerId: a.id });
    expect(trackersOnly.every((item) => item.event.trackerId === a.id)).toBe(true);
    const lapseOnly = core.history.list({ types: ['lapse_recorded'] });
    expect(lapseOnly).toHaveLength(1);
    expect(lapseOnly[0]?.trackerName).toBe('Alpha');
    const search = core.history.list({ search: 'restless' });
    expect(search).toHaveLength(1);
    expect(search[0]?.event.type).toBe('urge_recorded');
    const future = core.history.list({ from: T0 + 10 * DAY });
    expect(future).toHaveLength(0);
  });

  it('supports check-ins and records them in history', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(DAY);
    await core.checkIns.create({ trackerId: tracker.id, note: 'Feeling steady', mood: 4 });
    expect(core.checkIns.list(tracker.id)).toHaveLength(1);
    const history = core.history.list({ trackerId: tracker.id });
    const checkin = history.find((item) => item.event.type === 'checkin_recorded');
    expect(checkin?.detail).toBe('Feeling steady');
  });
});

describe('categories and settings', () => {
  it('seeds deterministic default categories once', async () => {
    const { core } = await createTestCore();
    const triggers = core.categories.list('trigger');
    expect(triggers.map((category) => category.name)).toEqual([
      'Stress',
      'Boredom',
      'Social pressure',
      'Loneliness',
      'Emotional distress',
      'Environmental triggers',
      'Habit',
      'Other',
      'Prefer not to say',
    ]);
    expect(triggers[0]?.id).toBe('default-trigger-stress');
    const reasons = core.categories.list('reason');
    expect(reasons.map((category) => category.name)).toEqual([
      'Health',
      'Relationships',
      'Focus',
      'Sleep',
      'Self-respect',
      'Money',
      'Other',
    ]);
    // Tracker categories were removed from the product; nothing seeds them.
    const all = core.categories.list(undefined, true);
    expect(all).toHaveLength(triggers.length + reasons.length);
    expect(all.every((category) => category.kind === 'trigger' || category.kind === 'reason')).toBe(true);
    expect(all.some((category) => category.id.startsWith('default-cat-'))).toBe(false);
  });

  it('accepts only trigger and reason category kinds', async () => {
    const { core } = await createTestCore();
    // Runtime callers (imports, old UI code) cannot create a tracker category.
    await expectTyagError(core.categories.create('tracker_category' as never, 'Digital'), 'VALIDATION');
    expect(core.categories.list('tracker_category' as never)).toEqual([]);
    expect(core.categories.list(undefined, true).some((category) => (category.kind as string) === 'tracker_category')).toBe(false);
  });

  it('creates, renames, archives and deletes custom categories safely', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'X' });
    clock.advance(DAY);
    const lapse = await core.lapses.create({
      trackerId: tracker.id,
      triggerCategoryId: 'default-trigger-stress',
    });
    const custom = await core.categories.create('trigger', 'Commuting');
    expect(custom.isDefault).toBe(false);
    await expectTyagError(core.categories.create('trigger', 'commuting'), 'CONFLICT');
    await core.categories.rename(custom.id, 'Long commute');
    expect(core.categories.get(custom.id).name).toBe('Long commute');
    await core.categories.setArchived(custom.id, true);
    expect(core.categories.list('trigger').some((category) => category.id === custom.id)).toBe(false);
    expect(core.categories.list('trigger', true).some((category) => category.id === custom.id)).toBe(true);
    await expectTyagError(core.categories.delete('default-trigger-stress'), 'CONFLICT');
    await core.categories.delete(custom.id);
    expect(core.categories.get.bind(core.categories, custom.id)).toThrow();
    expect(core.lapses.get(lapse.id).triggerCategoryId).toBe('default-trigger-stress');
    void tracker;
  });

  it('persists validated settings and restores defaults for invalid values', async () => {
    const { core } = await createTestCore();
    expect(core.settings.get().theme).toBe('system');
    await core.settings.update({ theme: 'dark', timeFormat: '24h', firstDayOfWeek: 1 });
    expect(core.settings.get().theme).toBe('dark');
    expect(core.settings.get().timeFormat).toBe('24h');
    await expectTyagError(core.settings.update({ theme: 'neon' } as never), 'VALIDATION');
    await expectTyagError(core.settings.update({ fixedTimeZone: 'Mars/Olympus' } as never), 'VALIDATION');
  });

  it('uses a fixed timezone when configured', async () => {
    const { core } = await createTestCore({ timeZone: 'Asia/Dhaka' });
    expect(core.timeZone()).toBe('Asia/Dhaka');
    await core.settings.update({ timeZoneMode: 'fixed', fixedTimeZone: 'America/New_York' });
    expect(core.timeZone()).toBe('America/New_York');
  });
});

describe('persistence, restart and deletion', () => {
  it('keeps data across a restart (reopening the persisted snapshot)', async () => {
    const test = await createTestCore();
    const tracker = await test.core.trackers.create({ name: 'Persisted' });
    test.clock.advance(DAY);
    await test.core.lapses.create({ trackerId: tracker.id, trigger: 'Stress' });
    await test.core.settings.update({ theme: 'light' });
    test.core.close();
    const reopened = await reopenTestCore(test);
    expect(reopened.core.trackers.list()).toHaveLength(1);
    expect(reopened.core.lapses.list(tracker.id)).toHaveLength(1);
    expect(reopened.core.settings.get().theme).toBe('light');
    expect(reopened.core.checkIntegrity()).toBe('ok');
  });

  it('detects corrupt persisted data instead of silently starting empty', async () => {
    const test = await createTestCore();
    await test.core.trackers.create({ name: 'X' });
    test.core.close();
    (test.persistence as unknown as { corrupt: () => void }).corrupt?.();
    const SQL = await (await import('./helpers')).loadSqlWasm();
    await expect(
      (await import('../src/index')).TyagCore.open({ SQL, persistence: test.persistence, clock: test.clock }),
    ).rejects.toMatchObject({ code: 'DATABASE' });
  });

  it('permanently deletes a tracker but keeps journal writing and a global record', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'Old tracker' });
    clock.advance(DAY);
    await core.lapses.create({ trackerId: tracker.id });
    const journal = await core.journal.create({ trackerId: tracker.id, body: 'A note that should survive.' });
    await core.trackers.delete(tracker.id);
    expect(core.trackers.list()).toHaveLength(0);
    expect(core.lapses.list()).toHaveLength(0);
    const keptJournal = core.journal.get(journal.id);
    expect(keptJournal.trackerId).toBeNull();
    const globalHistory = core.history.list();
    expect(globalHistory.some((item) => item.event.type === 'tracker_deleted')).toBe(true);
    expect(globalHistory.some((item) => item.event.trackerId === null)).toBe(true);
  });

  it('keeps independent trackers fully separate', async () => {
    const { core, clock } = await createTestCore();
    const a = await core.trackers.create({ name: 'A' });
    const b = await core.trackers.create({ name: 'B' });
    clock.advance(5 * DAY);
    await core.lapses.create({ trackerId: a.id, occurredAt: T0 + 2 * DAY });
    expect(core.metrics(a.id).lapseCount).toBe(1);
    expect(core.metrics(b.id).lapseCount).toBe(0);
    expect(core.metrics(b.id).currentStreakMs).toBe(5 * DAY);
    expect(core.urges.list(a.id)).toHaveLength(0);
  });
});
