import type { CreateTrackerInput, HistoryEventType, Tracker, UpdateTrackerInput } from '../domain';
import { fail } from '../util/errors';
import { newId } from '../util/ids';
import { LIMITS, optionalText, requireText, requireTimestamp, requireTimeZone } from '../validation';
import { utcOffsetMinutesAt } from '../time/temporal';
import { sessionRepo } from '../repos/sessions';
import { trackerRepo } from '../repos/trackers';
import { appendHistory, requireTracker, write, type CoreContext } from './context';

function validateName(value: unknown): string {
  return requireText(value, 'name', LIMITS.trackerName, 'Tracker name');
}

export class TrackerService {
  constructor(private readonly ctx: CoreContext) {}

  list(): Tracker[] {
    return trackerRepo.list(this.ctx.db);
  }

  listActive(): Tracker[] {
    return this.list().filter((tracker) => tracker.status === 'active');
  }

  get(id: string): Tracker {
    return requireTracker(this.ctx, id);
  }

  async create(input: CreateTrackerInput): Promise<Tracker> {
    const now = this.ctx.clock.now();
    const name = validateName(input.name);
    const startedAt =
      input.startedAt === undefined ? now : requireTimestamp(input.startedAt, 'startedAt', 'Start date and time', now);
    const startedTimeZone = requireTimeZone(
      input.startedTimeZone ?? undefined,
      'startedTimeZone',
      this.ctx.getEffectiveTimeZone(),
    );
    const tracker: Tracker = {
      id: newId(),
      name,
      description: optionalText(input.description, 'description', LIMITS.description, 'Description'),
      status: 'active',
      startedAt,
      startedTimeZone,
      startedUtcOffsetMinutes: utcOffsetMinutesAt(startedAt, startedTimeZone),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      notes: optionalText(input.notes, 'notes', LIMITS.notes, 'Notes'),
      reasons: optionalText(input.reasons, 'reasons', LIMITS.description, 'Reasons'),
      reminderEnabled: input.reminderEnabled ?? false,
      reminderIntervalMinutes: input.reminderIntervalMinutes ?? null,
    };
    return write(this.ctx, () => {
      trackerRepo.insert(this.ctx.db, tracker);
      sessionRepo.insert(this.ctx.db, {
        id: newId(),
        trackerId: tracker.id,
        startedAt,
        endedAt: null,
        startKind: 'created',
        createdAt: now,
        updatedAt: now,
      });
      appendHistory(this.ctx, { trackerId: tracker.id, type: 'tracker_created', occurredAt: now, metadata: { name } });
      appendHistory(this.ctx, { trackerId: tracker.id, type: 'tracker_started', occurredAt: startedAt });
      return tracker;
    });
  }

  async update(id: string, patch: UpdateTrackerInput): Promise<Tracker> {
    const tracker = requireTracker(this.ctx, id);
    const now = this.ctx.clock.now();
    const next: Tracker = { ...tracker };
    const changed: string[] = [];

    if (patch.name !== undefined && patch.name !== tracker.name) {
      next.name = validateName(patch.name);
      changed.push('name');
    }
    if (patch.description !== undefined) {
      const description = optionalText(patch.description, 'description', LIMITS.description, 'Description');
      if (description !== tracker.description) changed.push('description');
      next.description = description;
    }
    if (patch.notes !== undefined) {
      const notes = optionalText(patch.notes, 'notes', LIMITS.notes, 'Notes');
      if (notes !== tracker.notes) changed.push('notes');
      next.notes = notes;
    }
    if (patch.reasons !== undefined) {
      const reasons = optionalText(patch.reasons, 'reasons', LIMITS.description, 'Reasons');
      if (reasons !== tracker.reasons) changed.push('reasons');
      next.reasons = reasons;
    }
    if (patch.reminderEnabled !== undefined) {
      if (typeof patch.reminderEnabled !== 'boolean') fail('VALIDATION', 'Invalid reminder setting.');
      if (patch.reminderEnabled !== tracker.reminderEnabled) changed.push('reminderEnabled');
      next.reminderEnabled = patch.reminderEnabled;
    }
    if (patch.reminderIntervalMinutes !== undefined) {
      const value = patch.reminderIntervalMinutes;
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 60)) {
        fail('VALIDATION', 'Reminder interval must be at least 60 minutes.', { reminderIntervalMinutes: 'range' });
      }
      if (value !== tracker.reminderIntervalMinutes) changed.push('reminderIntervalMinutes');
      next.reminderIntervalMinutes = value;
    }

    let startedAtChanged = false;
    if (patch.startedAt !== undefined && patch.startedAt !== tracker.startedAt) {
      const startedAt = requireTimestamp(patch.startedAt, 'startedAt', 'Start date and time', now);
      const startedTimeZone = requireTimeZone(
        patch.startedTimeZone ?? undefined,
        'startedTimeZone',
        tracker.startedTimeZone,
      );
      this.assertNoEventsBefore(tracker.id, startedAt);
      next.startedAt = startedAt;
      next.startedTimeZone = startedTimeZone;
      next.startedUtcOffsetMinutes = utcOffsetMinutesAt(startedAt, startedTimeZone);
      startedAtChanged = true;
      changed.push('startedAt');
    } else if (patch.startedTimeZone !== undefined && patch.startedTimeZone !== tracker.startedTimeZone) {
      const startedTimeZone = requireTimeZone(patch.startedTimeZone, 'startedTimeZone', tracker.startedTimeZone);
      next.startedTimeZone = startedTimeZone;
      next.startedUtcOffsetMinutes = utcOffsetMinutesAt(tracker.startedAt, startedTimeZone);
      changed.push('startedTimeZone');
    }

    if (changed.length === 0) return tracker;
    next.updatedAt = now;

    return write(this.ctx, () => {
      trackerRepo.update(this.ctx.db, next);
      if (startedAtChanged) {
        this.adjustSessionsForNewStart(next, tracker.startedAt);
      }
      appendHistory(this.ctx, {
        trackerId: next.id,
        type: 'tracker_updated',
        occurredAt: now,
        metadata: { fields: changed },
      });
      return next;
    });
  }

  /**
   * Move sessions so they match the (possibly edited) commitment start.
   * Backdating the start extends the first session back to the new start;
   * moving it forward trims or removes active time before it.
   */
  private adjustSessionsForNewStart(tracker: Tracker, previousStartedAt: number): void {
    const now = this.ctx.clock.now();
    const sessions = sessionRepo.listForTracker(this.ctx.db, tracker.id);
    if (sessions.length > 0 && tracker.startedAt < previousStartedAt) {
      const earliest = sessions[0]!;
      earliest.startedAt = tracker.startedAt;
      earliest.updatedAt = now;
      sessionRepo.update(this.ctx.db, earliest);
    }
    for (const session of sessions) {
      if (session.endedAt !== null && session.endedAt <= tracker.startedAt) {
        this.ctx.db.run('DELETE FROM tracker_sessions WHERE id = ?', [session.id]);
        continue;
      }
      if (session.startedAt < tracker.startedAt) {
        session.startedAt = tracker.startedAt;
        session.updatedAt = now;
        sessionRepo.update(this.ctx.db, session);
      }
    }
    const open = sessionRepo.openForTracker(this.ctx.db, tracker.id);
    if (tracker.status === 'active' && !open) {
      sessionRepo.insert(this.ctx.db, {
        id: newId(),
        trackerId: tracker.id,
        startedAt: tracker.startedAt,
        endedAt: null,
        startKind: 'imported',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private assertNoEventsBefore(trackerId: string, startedAt: number): void {
    const lapse = this.ctx.db.get<{ occurred_at: number }>(
      'SELECT occurred_at FROM lapse_events WHERE tracker_id = ? AND occurred_at < ? LIMIT 1',
      [trackerId, startedAt],
    );
    if (lapse) {
      fail(
        'VALIDATION',
        'The new start is after one of your recorded events. Move or edit those events first.',
        { startedAt: 'events-before-start' },
      );
    }
  }

  async pause(id: string): Promise<Tracker> {
    const tracker = requireTracker(this.ctx, id);
    if (tracker.status !== 'active') fail('CONFLICT', 'Only an active tracker can be paused.');
    const now = this.ctx.clock.now();
    return write(this.ctx, () => {
      const open = sessionRepo.openForTracker(this.ctx.db, tracker.id);
      if (open) {
        open.endedAt = now;
        open.updatedAt = now;
        sessionRepo.update(this.ctx.db, open);
      }
      const next: Tracker = { ...tracker, status: 'paused', updatedAt: now };
      trackerRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, { trackerId: id, type: 'tracker_paused', occurredAt: now });
      return next;
    });
  }

  async resume(id: string): Promise<Tracker> {
    const tracker = requireTracker(this.ctx, id);
    if (tracker.status !== 'paused') fail('CONFLICT', 'Only a paused tracker can be resumed.');
    const now = this.ctx.clock.now();
    return write(this.ctx, () => {
      sessionRepo.insert(this.ctx.db, {
        id: newId(),
        trackerId: id,
        startedAt: now,
        endedAt: null,
        startKind: 'resumed',
        createdAt: now,
        updatedAt: now,
      });
      const next: Tracker = { ...tracker, status: 'active', updatedAt: now };
      trackerRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, { trackerId: id, type: 'tracker_resumed', occurredAt: now });
      return next;
    });
  }

  async archive(id: string): Promise<Tracker> {
    const tracker = requireTracker(this.ctx, id);
    if (tracker.status === 'archived') fail('CONFLICT', 'That tracker is already archived.');
    const now = this.ctx.clock.now();
    return write(this.ctx, () => {
      const open = sessionRepo.openForTracker(this.ctx.db, tracker.id);
      if (open) {
        open.endedAt = now;
        open.updatedAt = now;
        sessionRepo.update(this.ctx.db, open);
      }
      const next: Tracker = { ...tracker, status: 'archived', archivedAt: now, updatedAt: now };
      trackerRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, { trackerId: id, type: 'tracker_archived', occurredAt: now });
      return next;
    });
  }

  async restore(id: string): Promise<Tracker> {
    const tracker = requireTracker(this.ctx, id);
    if (tracker.status !== 'archived') fail('CONFLICT', 'Only an archived tracker can be restored.');
    const now = this.ctx.clock.now();
    return write(this.ctx, () => {
      // Restored trackers come back paused: paused time is never counted, and
      // the user explicitly chooses when to resume.
      const next: Tracker = { ...tracker, status: 'paused', archivedAt: null, updatedAt: now };
      trackerRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, { trackerId: id, type: 'tracker_restored', occurredAt: now });
      return next;
    });
  }

  /**
   * Permanently delete a tracker and its events. Journal entries and check-ins
   * are kept (detached) because they are user writing, not tracker math. A
   * global "tracker deleted" history record survives the deletion.
   */
  async delete(id: string): Promise<void> {
    const tracker = requireTracker(this.ctx, id);
    const now = this.ctx.clock.now();
    await write(this.ctx, () => {
      appendHistory(this.ctx, {
        trackerId: null,
        type: 'tracker_deleted',
        occurredAt: now,
        metadata: { name: tracker.name, startedAt: tracker.startedAt, status: tracker.status },
      });
      this.ctx.db.run('UPDATE journal_entries SET tracker_id = NULL WHERE tracker_id = ?', [id]);
      this.ctx.db.run('UPDATE check_ins SET tracker_id = NULL WHERE tracker_id = ?', [id]);
      this.ctx.db.run('DELETE FROM tracker_sessions WHERE tracker_id = ?', [id]);
      this.ctx.db.run('DELETE FROM lapse_events WHERE tracker_id = ?', [id]);
      this.ctx.db.run('DELETE FROM urge_events WHERE tracker_id = ?', [id]);
      this.ctx.db.run('DELETE FROM history_events WHERE tracker_id = ?', [id]);
      trackerRepo.delete(this.ctx.db, id);
    });
  }
}

export type { HistoryEventType };
