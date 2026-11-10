import type { Tracker, TrackerStatus } from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import { boolToInt, intToBool, requiredNumber, requiredString, type BoolInt } from './rows';

interface TrackerRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  started_at: number;
  started_time_zone: string;
  started_utc_offset_minutes: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  notes: string | null;
  reasons: string | null;
  reminder_enabled: BoolInt;
  reminder_interval_minutes: number | null;
}

function mapTracker(row: TrackerRow): Tracker {
  return {
    id: requiredString(row.id, 'trackers.id'),
    name: requiredString(row.name, 'trackers.name'),
    description: row.description ?? null,
    status: requiredString(row.status, 'trackers.status') as TrackerStatus,
    startedAt: requiredNumber(row.started_at, 'trackers.started_at'),
    startedTimeZone: requiredString(row.started_time_zone, 'trackers.started_time_zone'),
    startedUtcOffsetMinutes: requiredNumber(row.started_utc_offset_minutes, 'trackers.started_utc_offset_minutes'),
    createdAt: requiredNumber(row.created_at, 'trackers.created_at'),
    updatedAt: requiredNumber(row.updated_at, 'trackers.updated_at'),
    archivedAt: row.archived_at ?? null,
    notes: row.notes ?? null,
    reasons: row.reasons ?? null,
    reminderEnabled: intToBool(row.reminder_enabled),
    reminderIntervalMinutes: row.reminder_interval_minutes ?? null,
  };
}

export const trackerRepo = {
  insert(db: SqlDatabase, tracker: Tracker): void {
    db.run(
      `INSERT INTO trackers (id, name, description, status, started_at, started_time_zone,
        started_utc_offset_minutes, created_at, updated_at, archived_at, notes, reasons,
        reminder_enabled, reminder_interval_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tracker.id,
        tracker.name,
        tracker.description,
        tracker.status,
        tracker.startedAt,
        tracker.startedTimeZone,
        tracker.startedUtcOffsetMinutes,
        tracker.createdAt,
        tracker.updatedAt,
        tracker.archivedAt,
        tracker.notes,
        tracker.reasons,
        boolToInt(tracker.reminderEnabled),
        tracker.reminderIntervalMinutes,
      ],
    );
  },

  update(db: SqlDatabase, tracker: Tracker): void {
    db.run(
      `UPDATE trackers SET name = ?, description = ?, status = ?, started_at = ?,
        started_time_zone = ?, started_utc_offset_minutes = ?, updated_at = ?, archived_at = ?,
        notes = ?, reasons = ?, reminder_enabled = ?, reminder_interval_minutes = ?
       WHERE id = ?`,
      [
        tracker.name,
        tracker.description,
        tracker.status,
        tracker.startedAt,
        tracker.startedTimeZone,
        tracker.startedUtcOffsetMinutes,
        tracker.updatedAt,
        tracker.archivedAt,
        tracker.notes,
        tracker.reasons,
        boolToInt(tracker.reminderEnabled),
        tracker.reminderIntervalMinutes,
        tracker.id,
      ],
    );
  },

  get(db: SqlDatabase, id: string): Tracker | null {
    const row = db.get<TrackerRow>('SELECT * FROM trackers WHERE id = ?', [id]);
    return row ? mapTracker(row) : null;
  },

  list(db: SqlDatabase): Tracker[] {
    return db
      .all<TrackerRow>(
        `SELECT * FROM trackers
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                  created_at ASC, id ASC`,
      )
      .map(mapTracker);
  },

  listByStatus(db: SqlDatabase, status: TrackerStatus): Tracker[] {
    return db.all<TrackerRow>('SELECT * FROM trackers WHERE status = ? ORDER BY created_at ASC, id ASC', [status]).map(mapTracker);
  },

  delete(db: SqlDatabase, id: string): void {
    db.run('DELETE FROM trackers WHERE id = ?', [id]);
  },

  count(db: SqlDatabase): number {
    const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trackers');
    return row ? Number(row.n) : 0;
  },
};
