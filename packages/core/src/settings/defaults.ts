import type { AppSettings, CategoryKind, CustomCategory } from '../domain';
import type { SqlDatabase } from '../db/sqlite';
import { categoryRepo } from '../repos/categories';

export const DEFAULT_SETTINGS: AppSettings = {
  onboarded: false,
  theme: 'system',
  timeFormat: '12h',
  dateFormat: 'MMM d, yyyy',
  firstDayOfWeek: 0,
  timeZoneMode: 'device',
  fixedTimeZone: null,
  durationFormat: 'short',
  notificationsEnabled: false,
  notificationIntervalMinutes: 1440,
  exportPreference: 'json',
  defaultTriggerCategoryIds: [],
  confirmDestructiveImports: true,
  lastExportAt: null,
  lastBackupAt: null,
};

interface SeedCategory {
  id: string;
  kind: CategoryKind;
  name: string;
  sortOrder: number;
}

/**
 * Default categories use deterministic ids so that re-seeding, importing and
 * merging recognise the same category across installs (no duplicate "Stress").
 */
export const DEFAULT_CATEGORIES: SeedCategory[] = [
  { id: 'default-trigger-stress', kind: 'trigger', name: 'Stress', sortOrder: 10 },
  { id: 'default-trigger-boredom', kind: 'trigger', name: 'Boredom', sortOrder: 20 },
  { id: 'default-trigger-social-pressure', kind: 'trigger', name: 'Social pressure', sortOrder: 30 },
  { id: 'default-trigger-loneliness', kind: 'trigger', name: 'Loneliness', sortOrder: 40 },
  { id: 'default-trigger-emotional-distress', kind: 'trigger', name: 'Emotional distress', sortOrder: 50 },
  { id: 'default-trigger-environmental', kind: 'trigger', name: 'Environmental triggers', sortOrder: 60 },
  { id: 'default-trigger-habit', kind: 'trigger', name: 'Habit', sortOrder: 70 },
  { id: 'default-trigger-other', kind: 'trigger', name: 'Other', sortOrder: 80 },
  { id: 'default-trigger-prefer-not-to-say', kind: 'trigger', name: 'Prefer not to say', sortOrder: 90 },
  { id: 'default-reason-health', kind: 'reason', name: 'Health', sortOrder: 10 },
  { id: 'default-reason-relationships', kind: 'reason', name: 'Relationships', sortOrder: 20 },
  { id: 'default-reason-focus', kind: 'reason', name: 'Focus', sortOrder: 30 },
  { id: 'default-reason-sleep', kind: 'reason', name: 'Sleep', sortOrder: 40 },
  { id: 'default-reason-self-respect', kind: 'reason', name: 'Self-respect', sortOrder: 50 },
  { id: 'default-reason-money', kind: 'reason', name: 'Money', sortOrder: 60 },
  { id: 'default-reason-other', kind: 'reason', name: 'Other', sortOrder: 70 },
];

/** Insert any missing default category. Safe to call on every startup. */
export function seedDefaultCategories(db: SqlDatabase, now: number): void {
  for (const seed of DEFAULT_CATEGORIES) {
    if (categoryRepo.get(db, seed.id)) continue;
    const existingByName = categoryRepo.findByName(db, seed.kind, seed.name);
    if (existingByName) continue;
    const category: CustomCategory = {
      id: seed.id,
      kind: seed.kind,
      name: seed.name,
      sortOrder: seed.sortOrder,
      isDefault: true,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    categoryRepo.insert(db, category);
  }
}

/** Merge stored values over defaults and reject invalid stored values. */
export function hydrateSettings(stored: Partial<AppSettings>): AppSettings {
  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  const assign = <K extends keyof AppSettings>(key: K, value: unknown): void => {
    if (value === undefined) return;
    (settings as Record<keyof AppSettings, unknown>)[key] = value;
  };
  assign('onboarded', typeof stored.onboarded === 'boolean' ? stored.onboarded : undefined);
  if (stored.theme === 'system' || stored.theme === 'light' || stored.theme === 'dark') settings.theme = stored.theme;
  if (stored.timeFormat === '12h' || stored.timeFormat === '24h') settings.timeFormat = stored.timeFormat;
  if (
    stored.dateFormat === 'MMM d, yyyy' ||
    stored.dateFormat === 'd MMM yyyy' ||
    stored.dateFormat === 'MM/dd/yyyy' ||
    stored.dateFormat === 'dd/MM/yyyy' ||
    stored.dateFormat === 'yyyy-MM-dd'
  ) {
    settings.dateFormat = stored.dateFormat;
  }
  if (stored.firstDayOfWeek === 0 || stored.firstDayOfWeek === 1) settings.firstDayOfWeek = stored.firstDayOfWeek;
  if (stored.timeZoneMode === 'device' || stored.timeZoneMode === 'fixed') settings.timeZoneMode = stored.timeZoneMode;
  if (stored.fixedTimeZone === null || typeof stored.fixedTimeZone === 'string') settings.fixedTimeZone = stored.fixedTimeZone;
  if (stored.durationFormat === 'short' || stored.durationFormat === 'long' || stored.durationFormat === 'compact') {
    settings.durationFormat = stored.durationFormat;
  }
  if (typeof stored.notificationsEnabled === 'boolean') settings.notificationsEnabled = stored.notificationsEnabled;
  if (
    typeof stored.notificationIntervalMinutes === 'number' &&
    Number.isFinite(stored.notificationIntervalMinutes) &&
    stored.notificationIntervalMinutes >= 60
  ) {
    settings.notificationIntervalMinutes = Math.round(stored.notificationIntervalMinutes);
  }
  if (stored.exportPreference === 'json' || stored.exportPreference === 'encrypted') {
    settings.exportPreference = stored.exportPreference;
  }
  if (Array.isArray(stored.defaultTriggerCategoryIds)) {
    settings.defaultTriggerCategoryIds = stored.defaultTriggerCategoryIds.filter(
      (id): id is string => typeof id === 'string',
    );
  }
  if (typeof stored.confirmDestructiveImports === 'boolean') {
    settings.confirmDestructiveImports = stored.confirmDestructiveImports;
  }
  settings.lastExportAt = typeof stored.lastExportAt === 'number' ? stored.lastExportAt : null;
  settings.lastBackupAt = typeof stored.lastBackupAt === 'number' ? stored.lastBackupAt : null;
  return settings;
}

export const SETTINGS_KEYS: (keyof AppSettings)[] = [
  'onboarded',
  'theme',
  'timeFormat',
  'dateFormat',
  'firstDayOfWeek',
  'timeZoneMode',
  'fixedTimeZone',
  'durationFormat',
  'notificationsEnabled',
  'notificationIntervalMinutes',
  'exportPreference',
  'defaultTriggerCategoryIds',
  'confirmDestructiveImports',
  'lastExportAt',
  'lastBackupAt',
];
