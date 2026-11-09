import type { CheckIn, CreateCheckInInput, CreateJournalEntryInput, JournalEntry, UpdateJournalEntryInput } from '../domain';
import { fail } from '../util/errors';
import { newId } from '../util/ids';
import { LIMITS, optionalText, requireIntegerInRange, requireText, requireTimestamp, requireTimeZone } from '../validation';
import { utcOffsetMinutesAt } from '../time/temporal';
import { checkInRepo, journalRepo } from '../repos/events';
import { appendHistory, requireTracker, write, type CoreContext } from './context';

export interface JournalFilter {
  trackerId?: string | null;
  from?: number;
  to?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

function excerpt(value: string, max = 160): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

export class JournalService {
  constructor(private readonly ctx: CoreContext) {}

  list(filter: JournalFilter = {}): JournalEntry[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filter.trackerId !== undefined) {
      if (filter.trackerId === null) {
        conditions.push('tracker_id IS NULL');
      } else {
        conditions.push('tracker_id = ?');
        params.push(filter.trackerId);
      }
    }
    if (filter.from !== undefined) {
      conditions.push('occurred_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('occurred_at < ?');
      params.push(filter.to);
    }
    if (filter.search && filter.search.trim()) {
      conditions.push('(lower(coalesce(title, \'\')) LIKE ? OR lower(body) LIKE ?)');
      const term = `%${filter.search.trim().toLowerCase()}%`;
      params.push(term, term);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.ctx.db.all<{ id: string }>(
      `SELECT id FROM journal_entries ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows
      .map((row) => journalRepo.get(this.ctx.db, row.id))
      .filter((entry): entry is JournalEntry => entry !== null);
  }

  get(id: string): JournalEntry {
    const entry = journalRepo.get(this.ctx.db, id);
    if (!entry) fail('NOT_FOUND', 'That journal entry could not be found.');
    return entry;
  }

  async create(input: CreateJournalEntryInput): Promise<JournalEntry> {
    const now = this.ctx.clock.now();
    const body = requireText(input.body, 'body', LIMITS.journalBody, 'Journal entry');
    if (input.trackerId) requireTracker(this.ctx, input.trackerId);
    const occurredAt =
      input.occurredAt === undefined ? now : requireTimestamp(input.occurredAt, 'occurredAt', 'Entry date', now);
    const occurredTimeZone = requireTimeZone(
      input.occurredTimeZone,
      'occurredTimeZone',
      this.ctx.getEffectiveTimeZone(),
    );
    const entry: JournalEntry = {
      id: newId(),
      trackerId: input.trackerId ?? null,
      occurredAt,
      occurredTimeZone,
      occurredUtcOffsetMinutes: utcOffsetMinutesAt(occurredAt, occurredTimeZone),
      createdAt: now,
      updatedAt: now,
      title: optionalText(input.title, 'title', LIMITS.journalTitle, 'Title'),
      body,
    };
    return write(this.ctx, () => {
      journalRepo.insert(this.ctx.db, entry);
      appendHistory(this.ctx, {
        trackerId: entry.trackerId,
        type: 'journal_entry_created',
        occurredAt,
        refId: entry.id,
        metadata: { preview: excerpt(body) },
      });
      return entry;
    });
  }

  async update(id: string, patch: UpdateJournalEntryInput): Promise<JournalEntry> {
    const entry = this.get(id);
    const now = this.ctx.clock.now();
    const next: JournalEntry = { ...entry };
    if (patch.body !== undefined) next.body = requireText(patch.body, 'body', LIMITS.journalBody, 'Journal entry');
    if (patch.title !== undefined) next.title = optionalText(patch.title, 'title', LIMITS.journalTitle, 'Title');
    if (patch.trackerId !== undefined) {
      if (patch.trackerId !== null) requireTracker(this.ctx, patch.trackerId);
      next.trackerId = patch.trackerId;
    }
    if (patch.occurredAt !== undefined) {
      next.occurredAt = requireTimestamp(patch.occurredAt, 'occurredAt', 'Entry date', now);
    }
    if (patch.occurredTimeZone !== undefined) {
      next.occurredTimeZone = requireTimeZone(
        patch.occurredTimeZone,
        'occurredTimeZone',
        entry.occurredTimeZone,
      );
    }
    next.occurredUtcOffsetMinutes = utcOffsetMinutesAt(next.occurredAt, next.occurredTimeZone);
    next.updatedAt = now;
    return write(this.ctx, () => {
      journalRepo.update(this.ctx.db, next);
      appendHistory(this.ctx, {
        trackerId: next.trackerId,
        type: 'journal_entry_updated',
        occurredAt: next.occurredAt,
        refId: next.id,
        metadata: { preview: excerpt(next.body) },
      });
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    const entry = this.get(id);
    await write(this.ctx, () => {
      appendHistory(this.ctx, {
        trackerId: entry.trackerId,
        type: 'journal_entry_deleted',
        occurredAt: entry.occurredAt,
        refId: entry.id,
        metadata: { preview: excerpt(entry.body) },
      });
      journalRepo.delete(this.ctx.db, id);
    });
  }
}

export class CheckInService {
  constructor(private readonly ctx: CoreContext) {}

  list(trackerId?: string): CheckIn[] {
    const rows = trackerId
      ? this.ctx.db.all<{ id: string }>(
          'SELECT id FROM check_ins WHERE tracker_id = ? ORDER BY occurred_at DESC, id DESC',
          [trackerId],
        )
      : this.ctx.db.all<{ id: string }>('SELECT id FROM check_ins ORDER BY occurred_at DESC, id DESC');
    return rows
      .map((row) => checkInRepo.get(this.ctx.db, row.id))
      .filter((checkIn): checkIn is CheckIn => checkIn !== null);
  }

  async create(input: CreateCheckInInput): Promise<CheckIn> {
    const tracker = requireTracker(this.ctx, input.trackerId);
    const now = this.ctx.clock.now();
    const occurredAt =
      input.occurredAt === undefined ? now : requireTimestamp(input.occurredAt, 'occurredAt', 'Check-in time', now);
    if (occurredAt < tracker.startedAt) {
      fail('VALIDATION', 'That time is before this tracker started.', { occurredAt: 'before-start' });
    }
    const occurredTimeZone = requireTimeZone(
      input.occurredTimeZone,
      'occurredTimeZone',
      this.ctx.getEffectiveTimeZone(),
    );
    const mood =
      input.mood === undefined || input.mood === null
        ? null
        : requireIntegerInRange(input.mood, 'mood', 'Mood', 1, 5);
    const checkIn: CheckIn = {
      id: newId(),
      trackerId: tracker.id,
      occurredAt,
      occurredTimeZone,
      occurredUtcOffsetMinutes: utcOffsetMinutesAt(occurredAt, occurredTimeZone),
      createdAt: now,
      note: optionalText(input.note, 'note', LIMITS.notes, 'Note'),
      mood,
    };
    return write(this.ctx, () => {
      checkInRepo.insert(this.ctx.db, checkIn);
      appendHistory(this.ctx, {
        trackerId: tracker.id,
        type: 'checkin_recorded',
        occurredAt,
        refId: checkIn.id,
        metadata: { note: checkIn.note ? excerpt(checkIn.note) : null, mood },
      });
      return checkIn;
    });
  }

  async delete(id: string): Promise<void> {
    const checkIn = checkInRepo.get(this.ctx.db, id);
    if (!checkIn) fail('NOT_FOUND', 'That check-in could not be found.');
    await write(this.ctx, () => {
      appendHistory(this.ctx, {
        trackerId: checkIn.trackerId,
        type: 'checkin_deleted',
        occurredAt: checkIn.occurredAt,
        refId: checkIn.id,
        metadata: { note: checkIn.note ? excerpt(checkIn.note) : null },
      });
      checkInRepo.delete(this.ctx.db, id);
    });
  }
}
