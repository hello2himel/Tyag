/**
 * Read-only data loading helpers shared by analytics, insights and backup.
 * These keep the engines independent of SQL details and easy to test.
 */
import type {
  AppSettings,
  ApplicationSettingRow,
  CheckIn,
  CustomCategory,
  HistoryEvent,
  JournalEntry,
  LapseEvent,
  Tracker,
  TrackerSession,
  UrgeEvent,
} from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import { trackerRepo } from '../repos/trackers';
import { sessionRepo } from '../repos/sessions';
import { checkInRepo, journalRepo, lapseRepo, urgeRepo } from '../repos/events';
import { categoryRepo } from '../repos/categories';
import { historyRepo } from '../repos/history';
import { settingsRepo } from '../repos/settings';
import { hydrateSettings, SETTINGS_KEYS } from '../settings/defaults';

export interface TrackerBundle {
  tracker: Tracker;
  sessions: TrackerSession[];
  lapses: LapseEvent[];
  urges: UrgeEvent[];
  journal: JournalEntry[];
  checkIns: CheckIn[];
}

export interface AllData {
  trackers: Tracker[];
  sessions: TrackerSession[];
  lapses: LapseEvent[];
  urges: UrgeEvent[];
  journalEntries: JournalEntry[];
  checkIns: CheckIn[];
  categories: CustomCategory[];
  settings: AppSettings;
  settingsRows: ApplicationSettingRow[];
  historyEvents: HistoryEvent[];
}

export function loadTrackerBundle(db: SqlDatabase, trackerId: string): TrackerBundle {
  const tracker = trackerRepo.get(db, trackerId);
  if (!tracker) throw new Error(`Tracker not found: ${trackerId}`);
  return {
    tracker,
    sessions: sessionRepo.listForTracker(db, trackerId),
    lapses: lapseRepo.listForTracker(db, trackerId),
    urges: urgeRepo.listForTracker(db, trackerId),
    journal: journalRepo.listAll(db, trackerId),
    checkIns: checkInRepo.listAll(db).filter((checkIn) => checkIn.trackerId === trackerId),
  };
}

export function loadAllData(db: SqlDatabase): AllData {
  return {
    trackers: trackerRepo.list(db),
    sessions: sessionRepo.listAll(db),
    lapses: lapseRepo.listAll(db),
    urges: urgeRepo.listAll(db),
    journalEntries: journalRepo.listAll(db),
    checkIns: checkInRepo.listAll(db),
    categories: categoryRepo.list(db, undefined),
    settings: hydrateSettings(settingsRepo.loadSettings(db, SETTINGS_KEYS)),
    settingsRows: settingsRepo.rows(db),
    historyEvents: historyRepo.list(db),
  };
}

export function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
