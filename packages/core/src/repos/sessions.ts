import type { SessionStartKind, TrackerSession } from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import { requiredNumber, requiredString } from './rows';

interface SessionRow {
  id: string;
  tracker_id: string;
  started_at: number;
  ended_at: number | null;
  start_kind: string;
  created_at: number;
  updated_at: number;
}

function mapSession(row: SessionRow): TrackerSession {
  return {
    id: requiredString(row.id, 'tracker_sessions.id'),
    trackerId: requiredString(row.tracker_id, 'tracker_sessions.tracker_id'),
    startedAt: requiredNumber(row.started_at, 'tracker_sessions.started_at'),
    endedAt: row.ended_at ?? null,
    startKind: requiredString(row.start_kind, 'tracker_sessions.start_kind') as SessionStartKind,
    createdAt: requiredNumber(row.created_at, 'tracker_sessions.created_at'),
    updatedAt: requiredNumber(row.updated_at, 'tracker_sessions.updated_at'),
  };
}

export const sessionRepo = {
  insert(db: SqlDatabase, session: TrackerSession): void {
    db.run(
      `INSERT INTO tracker_sessions (id, tracker_id, started_at, ended_at, start_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.trackerId,
        session.startedAt,
        session.endedAt,
        session.startKind,
        session.createdAt,
        session.updatedAt,
      ],
    );
  },

  update(db: SqlDatabase, session: TrackerSession): void {
    db.run('UPDATE tracker_sessions SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?', [
      session.startedAt,
      session.endedAt,
      session.updatedAt,
      session.id,
    ]);
  },

  listForTracker(db: SqlDatabase, trackerId: string): TrackerSession[] {
    return db
      .all<SessionRow>('SELECT * FROM tracker_sessions WHERE tracker_id = ? ORDER BY started_at ASC, id ASC', [trackerId])
      .map(mapSession);
  },

  listAll(db: SqlDatabase): TrackerSession[] {
    return db
      .all<SessionRow>('SELECT * FROM tracker_sessions ORDER BY tracker_id ASC, started_at ASC, id ASC')
      .map(mapSession);
  },

  openForTracker(db: SqlDatabase, trackerId: string): TrackerSession | null {
    const row = db.get<SessionRow>(
      'SELECT * FROM tracker_sessions WHERE tracker_id = ? AND ended_at IS NULL LIMIT 1',
      [trackerId],
    );
    return row ? mapSession(row) : null;
  },

  deleteForTracker(db: SqlDatabase, trackerId: string): void {
    db.run('DELETE FROM tracker_sessions WHERE tracker_id = ?', [trackerId]);
  },
};
