import type { HistoryEvent, HistoryEventType } from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import { requiredNumber, requiredString } from './rows';

interface HistoryRow {
  id: string;
  tracker_id: string | null;
  type: string;
  occurred_at: number;
  created_at: number;
  ref_id: string | null;
  metadata: string | null;
}

function mapHistory(row: HistoryRow): HistoryEvent {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = null;
    }
  }
  return {
    id: requiredString(row.id, 'history_events.id'),
    trackerId: row.tracker_id ?? null,
    type: requiredString(row.type, 'history_events.type') as HistoryEventType,
    occurredAt: requiredNumber(row.occurred_at, 'history_events.occurred_at'),
    createdAt: requiredNumber(row.created_at, 'history_events.created_at'),
    refId: row.ref_id ?? null,
    metadata,
  };
}

export const historyRepo = {
  insert(db: SqlDatabase, event: HistoryEvent): void {
    db.run(
      `INSERT INTO history_events (id, tracker_id, type, occurred_at, created_at, ref_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.trackerId,
        event.type,
        event.occurredAt,
        event.createdAt,
        event.refId,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ],
    );
  },
  get(db: SqlDatabase, id: string): HistoryEvent | null {
    const row = db.get<HistoryRow>('SELECT * FROM history_events WHERE id = ?', [id]);
    return row ? mapHistory(row) : null;
  },
  list(db: SqlDatabase): HistoryEvent[] {
    return db
      .all<HistoryRow>('SELECT * FROM history_events ORDER BY occurred_at DESC, created_at DESC, rowid DESC')
      .map(mapHistory);
  },
  listForTracker(db: SqlDatabase, trackerId: string): HistoryEvent[] {
    return db
      .all<HistoryRow>(
        'SELECT * FROM history_events WHERE tracker_id = ? ORDER BY occurred_at DESC, created_at DESC, rowid DESC',
        [trackerId],
      )
      .map(mapHistory);
  },
  deleteForTracker(db: SqlDatabase, trackerId: string): void {
    db.run('DELETE FROM history_events WHERE tracker_id = ?', [trackerId]);
  },
  deleteRef(db: SqlDatabase, refId: string): void {
    // History rows are intentionally kept when their underlying record is
    // deleted: the *_deleted event references the id but not the payload.
    void refId;
  },
  count(db: SqlDatabase): number {
    const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM history_events');
    return row ? Number(row.n) : 0;
  },
};
