import type {
  CreateLapseInput,
  CreateUrgeInput,
  LapseEvent,
  Tracker,
  UpdateLapseInput,
  UpdateUrgeInput,
  UrgeEvent,
  UrgeOutcome,
} from '../domain';
import { fail } from '../util/errors';
import { newId } from '../util/ids';
import { LIMITS, optionalText, requireIntegerInRange, requireOneOf, requireText, requireTimestamp, requireTimeZone } from '../validation';
import { utcOffsetMinutesAt } from '../time/temporal';
import { lapseRepo, urgeRepo } from '../repos/events';
import { categoryRepo } from '../repos/categories';
import { appendHistory, requireTracker, write, type CoreContext } from './context';

const RETROSPECTIVE_THRESHOLD_MS = 60 * 60_000;

function resolveTrigger(
  ctx: CoreContext,
  categoryId: string | null | undefined,
  trigger: string | null | undefined,
): { trigger: string | null; triggerCategoryId: string | null } {
  let resolvedCategoryId: string | null = categoryId ?? null;
  let resolvedTrigger = optionalText(trigger, 'trigger', LIMITS.trigger, 'Trigger');
  if (resolvedCategoryId !== null) {
    if (typeof resolvedCategoryId !== 'string') fail('VALIDATION', 'Trigger category is invalid.');
    const category = categoryRepo.get(ctx.db, resolvedCategoryId);
    if (!category) fail('VALIDATION', 'That trigger category no longer exists.', { triggerCategoryId: 'missing' });
    if (category.kind !== 'trigger') {
      fail('VALIDATION', 'That category is not a trigger category.', { triggerCategoryId: 'kind' });
    }
    if (!resolvedTrigger) resolvedTrigger = category.name;
  }
  return { trigger: resolvedTrigger, triggerCategoryId: resolvedCategoryId };
}

function assertOccurredAt(tracker: Tracker, occurredAt: number): void {
  if (occurredAt < tracker.startedAt) {
    fail('VALIDATION', 'That time is before this tracker started. Edit the start date first.', {
      occurredAt: 'before-start',
    });
  }
}

export class LapseService {
  constructor(private readonly ctx: CoreContext) {}

  list(trackerId?: string): LapseEvent[] {
    if (trackerId === undefined) return lapseRepo.listAll(this.ctx.db);
    if (!trackerRepoExists(this.ctx, trackerId)) fail('NOT_FOUND', 'That tracker could not be found.');
    return lapseRepo.listForTracker(this.ctx.db, trackerId).sort((a, b) => b.occurredAt - a.occurredAt);
  }

  get(id: string): LapseEvent {
    const lapse = lapseRepo.get(this.ctx.db, id);
    if (!lapse) fail('NOT_FOUND', 'That lapse could not be found.');
    return lapse;
  }

  async create(input: CreateLapseInput): Promise<LapseEvent> {
    const tracker = requireTracker(this.ctx, input.trackerId);
    const now = this.ctx.clock.now();
    const occurredAt =
      input.occurredAt === undefined
        ? now
        : requireTimestamp(input.occurredAt, 'occurredAt', 'Lapse time', now);
    assertOccurredAt(tracker, occurredAt);
    const occurredTimeZone = requireTimeZone(
      input.occurredTimeZone,
      'occurredTimeZone',
      this.ctx.getEffectiveTimeZone(),
    );
    const { trigger, triggerCategoryId } = resolveTrigger(this.ctx, input.triggerCategoryId, input.trigger);
    const lapse: LapseEvent = {
      id: newId(),
      trackerId: tracker.id,
      occurredAt,
      occurredTimeZone,
      occurredUtcOffsetMinutes: utcOffsetMinutesAt(occurredAt, occurredTimeZone),
      createdAt: now,
      updatedAt: now,
      reason: optionalText(input.reason, 'reason', LIMITS.reason, 'Reason'),
      trigger,
      triggerCategoryId,
      description: optionalText(input.description, 'description', LIMITS.description, 'Description'),
      notes: optionalText(input.notes, 'notes', LIMITS.notes, 'Notes'),
      context: optionalText(input.context, 'context', LIMITS.context, 'Context'),
      retrospective: input.retrospective ?? now - occurredAt > RETROSPECTIVE_THRESHOLD_MS,
    };
    return write(this.ctx, () => {
      lapseRepo.insert(this.ctx.db, lapse);
      appendHistory(this.ctx, {
        trackerId: tracker.id,
        type: 'lapse_recorded',
        occurredAt,
        refId: lapse.id,
        metadata: {
          trigger: lapse.trigger,
          reason: lapse.reason,
          retrospective: lapse.retrospective,
        },
      });
      return lapse;
    });
  }

  async update(id: string, patch: UpdateLapseInput): Promise<LapseEvent> {
    const lapse = this.get(id);
    const tracker = requireTracker(this.ctx, lapse.trackerId);
    const now = this.ctx.clock.now();
    const next: LapseEvent = { ...lapse };
    if (patch.occurredAt !== undefined && patch.occurredAt !== lapse.occurredAt) {
      next.occurredAt = requireTimestamp(patch.occurredAt, 'occurredAt', 'Lapse time', now);
      assertOccurredAt(tracker, next.occurredAt);
      next.retrospective = now - next.occurredAt > RETROSPECTIVE_THRESHOLD_MS;
    }
    if (patch.occurredTimeZone !== undefined) {
      next.occurredTimeZone = requireTimeZone(patch.occurredTimeZone, 'occurredTimeZone', lapse.occurredTimeZone);
    }
    next.occurredUtcOffsetMinutes = utcOffsetMinutesAt(next.occurredAt, next.occurredTimeZone);
    if (patch.reason !== undefined) next.reason = optionalText(patch.reason, 'reason', LIMITS.reason, 'Reason');
    if (patch.description !== undefined) {
      next.description = optionalText(patch.description, 'description', LIMITS.description, 'Description');
    }
    if (patch.notes !== undefined) next.notes = optionalText(patch.notes, 'notes', LIMITS.notes, 'Notes');
    if (patch.context !== undefined) next.context = optionalText(patch.context, 'context', LIMITS.context, 'Context');
    if (patch.trigger !== undefined || patch.triggerCategoryId !== undefined) {
      const resolved = resolveTrigger(
        this.ctx,
        patch.triggerCategoryId !== undefined ? patch.triggerCategoryId : lapse.triggerCategoryId,
        patch.trigger !== undefined ? patch.trigger : lapse.trigger,
      );
      next.trigger = resolved.trigger;
      next.triggerCategoryId = resolved.triggerCategoryId;
    }
    next.updatedAt = now;
    return write(this.ctx, () => {
      lapseRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, {
        trackerId: lapse.trackerId,
        type: 'lapse_updated',
        occurredAt: next.occurredAt,
        refId: next.id,
        metadata: { trigger: next.trigger },
      });
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    const lapse = this.get(id);
    const now = this.ctx.clock.now();
    await write(this.ctx, () => {
      appendHistory(this.ctx, {
        trackerId: lapse.trackerId,
        type: 'lapse_deleted',
        occurredAt: lapse.occurredAt,
        refId: lapse.id,
        metadata: { occurredAt: lapse.occurredAt, trigger: lapse.trigger },
      });
      lapseRepo.delete(this.ctx.db, id);
      void now;
    });
  }
}

export class UrgeService {
  constructor(private readonly ctx: CoreContext) {}

  list(trackerId?: string): UrgeEvent[] {
    if (trackerId === undefined) return urgeRepo.listAll(this.ctx.db).sort((a, b) => b.occurredAt - a.occurredAt);
    if (!trackerRepoExists(this.ctx, trackerId)) fail('NOT_FOUND', 'That tracker could not be found.');
    return urgeRepo.listForTracker(this.ctx.db, trackerId).sort((a, b) => b.occurredAt - a.occurredAt);
  }

  get(id: string): UrgeEvent {
    const urge = urgeRepo.get(this.ctx.db, id);
    if (!urge) fail('NOT_FOUND', 'That urge could not be found.');
    return urge;
  }

  async create(input: CreateUrgeInput): Promise<UrgeEvent> {
    const tracker = requireTracker(this.ctx, input.trackerId);
    const now = this.ctx.clock.now();
    const occurredAt =
      input.occurredAt === undefined ? now : requireTimestamp(input.occurredAt, 'occurredAt', 'Urge time', now);
    assertOccurredAt(tracker, occurredAt);
    const occurredTimeZone = requireTimeZone(
      input.occurredTimeZone,
      'occurredTimeZone',
      this.ctx.getEffectiveTimeZone(),
    );
    const { trigger, triggerCategoryId } = resolveTrigger(this.ctx, input.triggerCategoryId, input.trigger);
    const intensity = requireIntegerInRange(input.intensity ?? 5, 'intensity', 'Urge intensity', 1, 10);
    const durationSeconds = this.validateDuration(input.durationSeconds);
    const outcome = requireOneOf<UrgeOutcome>(input.outcome ?? 'passed', 'outcome', 'Outcome', [
      'passed',
      'lapse',
      'unknown',
    ]);
    const urge: UrgeEvent = {
      id: newId(),
      trackerId: tracker.id,
      occurredAt,
      occurredTimeZone,
      occurredUtcOffsetMinutes: utcOffsetMinutesAt(occurredAt, occurredTimeZone),
      createdAt: now,
      updatedAt: now,
      intensity,
      durationSeconds,
      trigger,
      triggerCategoryId,
      context: optionalText(input.context, 'context', LIMITS.context, 'Context'),
      notes: optionalText(input.notes, 'notes', LIMITS.notes, 'Notes'),
      outcome,
      retrospective: input.retrospective ?? now - occurredAt > RETROSPECTIVE_THRESHOLD_MS,
    };
    return write(this.ctx, () => {
      urgeRepo.insert(this.ctx.db, urge);
      appendHistory(this.ctx, {
        trackerId: tracker.id,
        type: 'urge_recorded',
        occurredAt,
        refId: urge.id,
        metadata: { trigger: urge.trigger, intensity: urge.intensity, outcome: urge.outcome },
      });
      return urge;
    });
  }

  async update(id: string, patch: UpdateUrgeInput): Promise<UrgeEvent> {
    const urge = this.get(id);
    const tracker = requireTracker(this.ctx, urge.trackerId);
    const now = this.ctx.clock.now();
    const next: UrgeEvent = { ...urge };
    if (patch.occurredAt !== undefined && patch.occurredAt !== urge.occurredAt) {
      next.occurredAt = requireTimestamp(patch.occurredAt, 'occurredAt', 'Urge time', now);
      assertOccurredAt(tracker, next.occurredAt);
      next.retrospective = now - next.occurredAt > RETROSPECTIVE_THRESHOLD_MS;
    }
    if (patch.occurredTimeZone !== undefined) {
      next.occurredTimeZone = requireTimeZone(patch.occurredTimeZone, 'occurredTimeZone', urge.occurredTimeZone);
    }
    next.occurredUtcOffsetMinutes = utcOffsetMinutesAt(next.occurredAt, next.occurredTimeZone);
    if (patch.intensity !== undefined) {
      next.intensity = requireIntegerInRange(patch.intensity, 'intensity', 'Urge intensity', 1, 10);
    }
    if (patch.durationSeconds !== undefined) next.durationSeconds = this.validateDuration(patch.durationSeconds);
    if (patch.context !== undefined) next.context = optionalText(patch.context, 'context', LIMITS.context, 'Context');
    if (patch.notes !== undefined) next.notes = optionalText(patch.notes, 'notes', LIMITS.notes, 'Notes');
    if (patch.outcome !== undefined) {
      next.outcome = requireOneOf<UrgeOutcome>(patch.outcome, 'outcome', 'Outcome', ['passed', 'lapse', 'unknown']);
    }
    if (patch.trigger !== undefined || patch.triggerCategoryId !== undefined) {
      const resolved = resolveTrigger(
        this.ctx,
        patch.triggerCategoryId !== undefined ? patch.triggerCategoryId : urge.triggerCategoryId,
        patch.trigger !== undefined ? patch.trigger : urge.trigger,
      );
      next.trigger = resolved.trigger;
      next.triggerCategoryId = resolved.triggerCategoryId;
    }
    next.updatedAt = now;
    return write(this.ctx, () => {
      urgeRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, {
        trackerId: urge.trackerId,
        type: 'urge_updated',
        occurredAt: next.occurredAt,
        refId: next.id,
        metadata: { trigger: next.trigger, intensity: next.intensity, outcome: next.outcome },
      });
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    const urge = this.get(id);
    await write(this.ctx, () => {
      appendHistory(this.ctx, {
        trackerId: urge.trackerId,
        type: 'urge_deleted',
        occurredAt: urge.occurredAt,
        refId: urge.id,
        metadata: { occurredAt: urge.occurredAt, intensity: urge.intensity, trigger: urge.trigger },
      });
      urgeRepo.delete(this.ctx.db, id);
    });
  }

  private validateDuration(value: number | null | undefined): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 7 * 24 * 3600) {
      fail('VALIDATION', 'Urge duration must be between 0 and 7 days.', { durationSeconds: 'range' });
    }
    return Math.round(value);
  }
}

function trackerRepoExists(ctx: CoreContext, trackerId: string): boolean {
  return ctx.db.get<{ id: string }>('SELECT id FROM trackers WHERE id = ?', [trackerId]) !== undefined;
}
