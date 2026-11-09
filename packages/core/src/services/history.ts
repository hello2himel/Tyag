import type {
  CheckIn,
  HistoryEvent,
  HistoryEventType,
  HistoryFilter,
  HistoryItem,
  JournalEntry,
  LapseEvent,
  Tracker,
  UrgeEvent,
} from '../domain';
import { historyRepo } from '../repos/history';
import { journalRepo, lapseRepo, urgeRepo, checkInRepo } from '../repos/events';
import { trackerRepo } from '../repos/trackers';
import type { CoreContext } from './context';

function excerpt(value: string, max = 160): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function metadataText(event: HistoryEvent, key: string): string | null {
  const value = event.metadata?.[key];
  return typeof value === 'string' ? value : null;
}

function metadataNumber(event: HistoryEvent, key: string): number | null {
  const value = event.metadata?.[key];
  return typeof value === 'number' ? value : null;
}

function titleFor(event: HistoryEvent): string {
  switch (event.type) {
    case 'tracker_created':
      return 'Tracker created';
    case 'tracker_started':
      return 'Tracker started';
    case 'tracker_updated':
      return 'Tracker updated';
    case 'tracker_paused':
      return 'Tracker paused';
    case 'tracker_resumed':
      return 'Tracker resumed';
    case 'tracker_archived':
      return 'Tracker archived';
    case 'tracker_restored':
      return 'Tracker restored';
    case 'tracker_deleted':
      return 'Tracker deleted';
    case 'lapse_recorded':
      return 'Lapse';
    case 'lapse_updated':
      return 'Lapse updated';
    case 'lapse_deleted':
      return 'Lapse deleted';
    case 'urge_recorded': {
      const intensity = metadataNumber(event, 'intensity');
      return intensity !== null ? `Urge · ${intensity}/10` : 'Urge';
    }
    case 'urge_updated':
      return 'Urge updated';
    case 'urge_deleted':
      return 'Urge deleted';
    case 'journal_entry_created':
      return 'Journal';
    case 'journal_entry_updated':
      return 'Journal updated';
    case 'journal_entry_deleted':
      return 'Journal deleted';
    case 'checkin_recorded':
      return 'Check-in';
    case 'checkin_deleted':
      return 'Check-in deleted';
    case 'categories_updated':
      return 'Categories updated';
    case 'settings_updated':
      return 'Settings updated';
    case 'data_imported':
      return 'Data imported';
    case 'data_exported':
      return 'Data exported';
    case 'backup_restored':
      return 'Backup restored';
  }
}

function detailFor(
  event: HistoryEvent,
  lapse: LapseEvent | null,
  urge: UrgeEvent | null,
  journal: JournalEntry | null,
  checkIn: CheckIn | null,
): string | null {
  switch (event.type) {
    case 'tracker_created':
    case 'tracker_deleted':
      return metadataText(event, 'name');
    case 'tracker_updated': {
      const fields = event.metadata?.['fields'];
      return Array.isArray(fields) && fields.length > 0 ? `Changed ${fields.join(', ')}` : null;
    }
    case 'tracker_paused':
      return 'Paused time is not counted';
    case 'tracker_resumed':
      return 'Paused time not counted';
    case 'lapse_recorded':
    case 'lapse_updated': {
      if (!lapse) return metadataText(event, 'trigger');
      const parts = [lapse.trigger, lapse.reason, lapse.retrospective ? 'Entered retrospectively' : null].filter(
        (value): value is string => Boolean(value),
      );
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    case 'lapse_deleted':
      return metadataText(event, 'trigger');
    case 'urge_recorded':
    case 'urge_updated':
      if (!urge) return null;
      return urge.outcome === 'passed'
        ? 'Passed without a lapse'
        : urge.outcome === 'lapse'
          ? 'Led to a lapse'
          : 'Outcome not recorded';
    case 'urge_deleted':
      return null;
    case 'journal_entry_created':
    case 'journal_entry_updated':
      return journal ? excerpt(journal.body) : metadataText(event, 'preview');
    case 'journal_entry_deleted':
      return metadataText(event, 'preview');
    case 'checkin_recorded':
      return checkIn?.note ? excerpt(checkIn.note) : null;
    case 'checkin_deleted':
      return null;
    case 'settings_updated': {
      const keys = event.metadata?.['keys'];
      return Array.isArray(keys) ? `Changed ${keys.join(', ')}` : null;
    }
    case 'data_imported':
      return metadataText(event, 'summary');
    default:
      return null;
  }
}

interface Refs {
  trackers: Map<string, Tracker>;
  lapses: Map<string, LapseEvent>;
  urges: Map<string, UrgeEvent>;
  journals: Map<string, JournalEntry>;
  checkIns: Map<string, CheckIn>;
}

/** Chronological activity timeline with filtering and text search. */
export class HistoryService {
  constructor(private readonly ctx: CoreContext) {}

  private loadRefs(): Refs {
    const db = this.ctx.db;
    return {
      trackers: new Map(trackerRepo.list(db).map((tracker) => [tracker.id, tracker])),
      lapses: new Map(lapseRepo.listAll(db).map((event) => [event.id, event])),
      urges: new Map(urgeRepo.listAll(db).map((event) => [event.id, event])),
      journals: new Map(journalRepo.listAll(db).map((entry) => [entry.id, entry])),
      checkIns: new Map(checkInRepo.listAll(db).map((checkIn) => [checkIn.id, checkIn])),
    };
  }

  list(filter: HistoryFilter = {}): HistoryItem[] {
    let events = historyRepo.list(this.ctx.db);
    const refs = this.loadRefs();
    const nameFor = (trackerId: string | null): string | null =>
      trackerId ? refs.trackers.get(trackerId)?.name ?? null : null;

    if (filter.trackerId !== undefined) {
      events =
        filter.trackerId === null
          ? events.filter((event) => event.trackerId === null)
          : events.filter((event) => event.trackerId === filter.trackerId);
    }
    if (filter.types && filter.types.length > 0) {
      const allowed = new Set<HistoryEventType>(filter.types);
      events = events.filter((event) => allowed.has(event.type));
    }
    if (filter.from !== undefined) events = events.filter((event) => event.occurredAt >= filter.from!);
    if (filter.to !== undefined) events = events.filter((event) => event.occurredAt < filter.to!);

    if (filter.search && filter.search.trim()) {
      const term = filter.search.trim().toLowerCase();
      const matches = (event: HistoryEvent): boolean => {
        if (nameFor(event.trackerId)?.toLowerCase().includes(term)) return true;
        if ((event.metadata ? JSON.stringify(event.metadata) : '').toLowerCase().includes(term)) return true;
        if (!event.refId) return false;
        const ref =
          refs.lapses.get(event.refId) ??
          refs.urges.get(event.refId) ??
          refs.journals.get(event.refId) ??
          refs.checkIns.get(event.refId);
        if (!ref) return false;
        return JSON.stringify(ref).toLowerCase().includes(term);
      };
      events = events.filter(matches);
    }

    const offset = Math.max(filter.offset ?? 0, 0);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return events.slice(offset, offset + limit).map((event) => {
      const lapse = event.refId ? refs.lapses.get(event.refId) ?? null : null;
      const urge = event.refId ? refs.urges.get(event.refId) ?? null : null;
      const journal = event.refId ? refs.journals.get(event.refId) ?? null : null;
      const checkIn = event.refId ? refs.checkIns.get(event.refId) ?? null : null;
      const refType: HistoryItem['refType'] = lapse
        ? 'lapse'
        : urge
          ? 'urge'
          : journal
            ? 'journal'
            : checkIn
              ? 'checkin'
              : null;
      return {
        event,
        trackerName: nameFor(event.trackerId),
        title: titleFor(event),
        detail: detailFor(event, lapse, urge, journal, checkIn),
        refType,
      };
    });
  }

  count(filter: HistoryFilter = {}): number {
    return this.list({ ...filter, limit: 500, offset: 0 }).length;
  }
}
