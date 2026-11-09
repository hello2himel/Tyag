import type { HistoryEventType, Tracker } from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import type { Clock } from '../util/clock';
import { fail } from '../util/errors';
import { newId } from '../util/ids';
import { trackerRepo } from '../repos/trackers';
import { historyRepo } from '../repos/history';

export interface CoreContext {
  db: SqlDatabase;
  clock: Clock;
  appVersion: string;
  /** Timezone used for calendar grouping, from settings (device or fixed). */
  getEffectiveTimeZone: () => string;
  /** Persist the in-memory database snapshot. */
  persist: () => Promise<void>;
}

/** Run a mutation in a transaction, then persist the new snapshot. */
export async function write<T>(ctx: CoreContext, fn: () => T): Promise<T> {
  const result = ctx.db.transaction(fn);
  await ctx.persist();
  return result;
}

export function requireTracker(ctx: CoreContext, id: string): Tracker {
  if (!id) fail('VALIDATION', 'Choose a tracker.', { trackerId: 'required' });
  const tracker = trackerRepo.get(ctx.db, id);
  if (!tracker) fail('NOT_FOUND', 'That tracker could not be found.');
  return tracker;
}

export interface HistoryInput {
  trackerId: string | null;
  type: HistoryEventType;
  occurredAt: number;
  refId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Append one activity-log entry. Call inside the same transaction as the change. */
export function appendHistory(ctx: CoreContext, input: HistoryInput): void {
  const createdAt = ctx.clock.now();
  historyRepo.insert(ctx.db, {
    id: newId(),
    trackerId: input.trackerId,
    type: input.type,
    occurredAt: input.occurredAt,
    createdAt,
    refId: input.refId ?? null,
    metadata: input.metadata ?? null,
  });
}
