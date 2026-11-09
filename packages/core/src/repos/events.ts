import type { CheckIn, JournalEntry, LapseEvent, UrgeEvent, UrgeOutcome } from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import { boolToInt, intToBool, requiredNumber, requiredString, type BoolInt } from './rows';

/* ------------------------------- lapses --------------------------------- */

interface LapseRow {
  id: string;
  tracker_id: string;
  occurred_at: number;
  occurred_time_zone: string;
  occurred_utc_offset_minutes: number;
  created_at: number;
  updated_at: number;
  reason: string | null;
  trigger: string | null;
  trigger_category_id: string | null;
  description: string | null;
  notes: string | null;
  context: string | null;
  retrospective: BoolInt;
}

function mapLapse(row: LapseRow): LapseEvent {
  return {
    id: requiredString(row.id, 'lapse_events.id'),
    trackerId: requiredString(row.tracker_id, 'lapse_events.tracker_id'),
    occurredAt: requiredNumber(row.occurred_at, 'lapse_events.occurred_at'),
    occurredTimeZone: requiredString(row.occurred_time_zone, 'lapse_events.occurred_time_zone'),
    occurredUtcOffsetMinutes: requiredNumber(row.occurred_utc_offset_minutes, 'lapse_events.occurred_utc_offset_minutes'),
    createdAt: requiredNumber(row.created_at, 'lapse_events.created_at'),
    updatedAt: requiredNumber(row.updated_at, 'lapse_events.updated_at'),
    reason: row.reason ?? null,
    trigger: row.trigger ?? null,
    triggerCategoryId: row.trigger_category_id ?? null,
    description: row.description ?? null,
    notes: row.notes ?? null,
    context: row.context ?? null,
    retrospective: intToBool(row.retrospective),
  };
}

export const lapseRepo = {
  insert(db: SqlDatabase, lapse: LapseEvent): void {
    db.run(
      `INSERT INTO lapse_events (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
        created_at, updated_at, reason, trigger, trigger_category_id, description, notes, context, retrospective)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lapse.id,
        lapse.trackerId,
        lapse.occurredAt,
        lapse.occurredTimeZone,
        lapse.occurredUtcOffsetMinutes,
        lapse.createdAt,
        lapse.updatedAt,
        lapse.reason,
        lapse.trigger,
        lapse.triggerCategoryId,
        lapse.description,
        lapse.notes,
        lapse.context,
        boolToInt(lapse.retrospective),
      ],
    );
  },
  update(db: SqlDatabase, lapse: LapseEvent): void {
    db.run(
      `UPDATE lapse_events SET occurred_at = ?, occurred_time_zone = ?, occurred_utc_offset_minutes = ?,
        updated_at = ?, reason = ?, trigger = ?, trigger_category_id = ?, description = ?, notes = ?, context = ?
       WHERE id = ?`,
      [
        lapse.occurredAt,
        lapse.occurredTimeZone,
        lapse.occurredUtcOffsetMinutes,
        lapse.updatedAt,
        lapse.reason,
        lapse.trigger,
        lapse.triggerCategoryId,
        lapse.description,
        lapse.notes,
        lapse.context,
        lapse.id,
      ],
    );
  },
  get(db: SqlDatabase, id: string): LapseEvent | null {
    const row = db.get<LapseRow>('SELECT * FROM lapse_events WHERE id = ?', [id]);
    return row ? mapLapse(row) : null;
  },
  listForTracker(db: SqlDatabase, trackerId: string): LapseEvent[] {
    return db
      .all<LapseRow>('SELECT * FROM lapse_events WHERE tracker_id = ? ORDER BY occurred_at ASC, id ASC', [trackerId])
      .map(mapLapse);
  },
  listAll(db: SqlDatabase): LapseEvent[] {
    return db
      .all<LapseRow>('SELECT * FROM lapse_events ORDER BY occurred_at ASC, id ASC')
      .map(mapLapse);
  },
  delete(db: SqlDatabase, id: string): void {
    db.run('DELETE FROM lapse_events WHERE id = ?', [id]);
  },
};

/* -------------------------------- urges --------------------------------- */

interface UrgeRow {
  id: string;
  tracker_id: string;
  occurred_at: number;
  occurred_time_zone: string;
  occurred_utc_offset_minutes: number;
  created_at: number;
  updated_at: number;
  intensity: number;
  duration_seconds: number | null;
  trigger: string | null;
  trigger_category_id: string | null;
  context: string | null;
  notes: string | null;
  outcome: string;
  retrospective: BoolInt;
}

function mapUrge(row: UrgeRow): UrgeEvent {
  return {
    id: requiredString(row.id, 'urge_events.id'),
    trackerId: requiredString(row.tracker_id, 'urge_events.tracker_id'),
    occurredAt: requiredNumber(row.occurred_at, 'urge_events.occurred_at'),
    occurredTimeZone: requiredString(row.occurred_time_zone, 'urge_events.occurred_time_zone'),
    occurredUtcOffsetMinutes: requiredNumber(row.occurred_utc_offset_minutes, 'urge_events.occurred_utc_offset_minutes'),
    createdAt: requiredNumber(row.created_at, 'urge_events.created_at'),
    updatedAt: requiredNumber(row.updated_at, 'urge_events.updated_at'),
    intensity: requiredNumber(row.intensity, 'urge_events.intensity'),
    durationSeconds: row.duration_seconds ?? null,
    trigger: row.trigger ?? null,
    triggerCategoryId: row.trigger_category_id ?? null,
    context: row.context ?? null,
    notes: row.notes ?? null,
    outcome: requiredString(row.outcome, 'urge_events.outcome') as UrgeOutcome,
    retrospective: intToBool(row.retrospective),
  };
}

export const urgeRepo = {
  insert(db: SqlDatabase, urge: UrgeEvent): void {
    db.run(
      `INSERT INTO urge_events (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
        created_at, updated_at, intensity, duration_seconds, trigger, trigger_category_id, context, notes,
        outcome, retrospective)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        urge.id,
        urge.trackerId,
        urge.occurredAt,
        urge.occurredTimeZone,
        urge.occurredUtcOffsetMinutes,
        urge.createdAt,
        urge.updatedAt,
        urge.intensity,
        urge.durationSeconds,
        urge.trigger,
        urge.triggerCategoryId,
        urge.context,
        urge.notes,
        urge.outcome,
        boolToInt(urge.retrospective),
      ],
    );
  },
  update(db: SqlDatabase, urge: UrgeEvent): void {
    db.run(
      `UPDATE urge_events SET occurred_at = ?, occurred_time_zone = ?, occurred_utc_offset_minutes = ?,
        updated_at = ?, intensity = ?, duration_seconds = ?, trigger = ?, trigger_category_id = ?,
        context = ?, notes = ?, outcome = ?
       WHERE id = ?`,
      [
        urge.occurredAt,
        urge.occurredTimeZone,
        urge.occurredUtcOffsetMinutes,
        urge.updatedAt,
        urge.intensity,
        urge.durationSeconds,
        urge.trigger,
        urge.triggerCategoryId,
        urge.context,
        urge.notes,
        urge.outcome,
        urge.id,
      ],
    );
  },
  get(db: SqlDatabase, id: string): UrgeEvent | null {
    const row = db.get<UrgeRow>('SELECT * FROM urge_events WHERE id = ?', [id]);
    return row ? mapUrge(row) : null;
  },
  listForTracker(db: SqlDatabase, trackerId: string): UrgeEvent[] {
    return db
      .all<UrgeRow>('SELECT * FROM urge_events WHERE tracker_id = ? ORDER BY occurred_at ASC, id ASC', [trackerId])
      .map(mapUrge);
  },
  listAll(db: SqlDatabase): UrgeEvent[] {
    return db.all<UrgeRow>('SELECT * FROM urge_events ORDER BY occurred_at ASC, id ASC').map(mapUrge);
  },
  delete(db: SqlDatabase, id: string): void {
    db.run('DELETE FROM urge_events WHERE id = ?', [id]);
  },
};

/* ------------------------------- journal -------------------------------- */

interface JournalRow {
  id: string;
  tracker_id: string | null;
  occurred_at: number;
  occurred_time_zone: string;
  occurred_utc_offset_minutes: number;
  created_at: number;
  updated_at: number;
  title: string | null;
  body: string;
}

function mapJournal(row: JournalRow): JournalEntry {
  return {
    id: requiredString(row.id, 'journal_entries.id'),
    trackerId: row.tracker_id ?? null,
    occurredAt: requiredNumber(row.occurred_at, 'journal_entries.occurred_at'),
    occurredTimeZone: requiredString(row.occurred_time_zone, 'journal_entries.occurred_time_zone'),
    occurredUtcOffsetMinutes: requiredNumber(row.occurred_utc_offset_minutes, 'journal_entries.occurred_utc_offset_minutes'),
    createdAt: requiredNumber(row.created_at, 'journal_entries.created_at'),
    updatedAt: requiredNumber(row.updated_at, 'journal_entries.updated_at'),
    title: row.title ?? null,
    body: requiredString(row.body, 'journal_entries.body'),
  };
}

export const journalRepo = {
  insert(db: SqlDatabase, entry: JournalEntry): void {
    db.run(
      `INSERT INTO journal_entries (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
        created_at, updated_at, title, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.trackerId,
        entry.occurredAt,
        entry.occurredTimeZone,
        entry.occurredUtcOffsetMinutes,
        entry.createdAt,
        entry.updatedAt,
        entry.title,
        entry.body,
      ],
    );
  },
  update(db: SqlDatabase, entry: JournalEntry): void {
    db.run(
      `UPDATE journal_entries SET tracker_id = ?, occurred_at = ?, occurred_time_zone = ?,
        occurred_utc_offset_minutes = ?, updated_at = ?, title = ?, body = ? WHERE id = ?`,
      [
        entry.trackerId,
        entry.occurredAt,
        entry.occurredTimeZone,
        entry.occurredUtcOffsetMinutes,
        entry.updatedAt,
        entry.title,
        entry.body,
        entry.id,
      ],
    );
  },
  get(db: SqlDatabase, id: string): JournalEntry | null {
    const row = db.get<JournalRow>('SELECT * FROM journal_entries WHERE id = ?', [id]);
    return row ? mapJournal(row) : null;
  },
  listAll(db: SqlDatabase, trackerId?: string | null): JournalEntry[] {
    if (trackerId === undefined) {
      return db.all<JournalRow>('SELECT * FROM journal_entries ORDER BY occurred_at DESC, id DESC').map(mapJournal);
    }
    if (trackerId === null) {
      return db
        .all<JournalRow>('SELECT * FROM journal_entries WHERE tracker_id IS NULL ORDER BY occurred_at DESC, id DESC')
        .map(mapJournal);
    }
    return db
      .all<JournalRow>('SELECT * FROM journal_entries WHERE tracker_id = ? ORDER BY occurred_at DESC, id DESC', [trackerId])
      .map(mapJournal);
  },
  delete(db: SqlDatabase, id: string): void {
    db.run('DELETE FROM journal_entries WHERE id = ?', [id]);
  },
};

/* ------------------------------- check-ins ------------------------------ */

interface CheckInRow {
  id: string;
  tracker_id: string | null;
  occurred_at: number;
  occurred_time_zone: string;
  occurred_utc_offset_minutes: number;
  created_at: number;
  note: string | null;
  mood: number | null;
}

function mapCheckIn(row: CheckInRow): CheckIn {
  return {
    id: requiredString(row.id, 'check_ins.id'),
    trackerId: row.tracker_id ?? null,
    occurredAt: requiredNumber(row.occurred_at, 'check_ins.occurred_at'),
    occurredTimeZone: requiredString(row.occurred_time_zone, 'check_ins.occurred_time_zone'),
    occurredUtcOffsetMinutes: requiredNumber(row.occurred_utc_offset_minutes, 'check_ins.occurred_utc_offset_minutes'),
    createdAt: requiredNumber(row.created_at, 'check_ins.created_at'),
    note: row.note ?? null,
    mood: row.mood ?? null,
  };
}

export const checkInRepo = {
  insert(db: SqlDatabase, checkIn: CheckIn): void {
    db.run(
      `INSERT INTO check_ins (id, tracker_id, occurred_at, occurred_time_zone, occurred_utc_offset_minutes,
        created_at, note, mood)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        checkIn.id,
        checkIn.trackerId,
        checkIn.occurredAt,
        checkIn.occurredTimeZone,
        checkIn.occurredUtcOffsetMinutes,
        checkIn.createdAt,
        checkIn.note,
        checkIn.mood,
      ],
    );
  },
  get(db: SqlDatabase, id: string): CheckIn | null {
    const row = db.get<CheckInRow>('SELECT * FROM check_ins WHERE id = ?', [id]);
    return row ? mapCheckIn(row) : null;
  },
  listAll(db: SqlDatabase): CheckIn[] {
    return db.all<CheckInRow>('SELECT * FROM check_ins ORDER BY occurred_at DESC, id DESC').map(mapCheckIn);
  },
  delete(db: SqlDatabase, id: string): void {
    db.run('DELETE FROM check_ins WHERE id = ?', [id]);
  },
};
