/** Input validation shared by services and the import pipeline. */
import type { DateFormat, DurationFormat, TimeFormat, TrackerStatus } from './domain';
import { fail } from './util/errors';
import { isValidTimeZone } from './time/temporal';

export const LIMITS = {
  trackerName: 120,
  shortText: 200,
  description: 2_000,
  notes: 10_000,
  journalBody: 50_000,
  journalTitle: 200,
  trigger: 120,
  reason: 300,
  context: 200,
  categoryName: 60,
} as const;

/** Earliest timestamp the app accepts (2000-01-01T00:00:00Z). */
export const MIN_TIMESTAMP = 946_684_800_000;
/** Tolerated future skew when validating user-entered timestamps. */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

export function requireText(value: unknown, field: string, maxLength: number, label: string): string {
  if (typeof value !== 'string') fail('VALIDATION', `${label} is required.`, { [field]: 'required' });
  const trimmed = value.trim();
  if (!trimmed) fail('VALIDATION', `${label} is required.`, { [field]: 'required' });
  if (trimmed.length > maxLength) {
    fail('VALIDATION', `${label} must be ${maxLength} characters or fewer.`, { [field]: 'too-long' });
  }
  return trimmed;
}

export function optionalText(value: unknown, field: string, maxLength: number, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('VALIDATION', `${label} must be text.`, { [field]: 'type' });
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    fail('VALIDATION', `${label} must be ${maxLength} characters or fewer.`, { [field]: 'too-long' });
  }
  return trimmed;
}

export function requireTimestamp(value: unknown, field: string, label: string, now: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('VALIDATION', `${label} must be a valid date and time.`, { [field]: 'invalid' });
  }
  const rounded = Math.round(value);
  if (rounded < MIN_TIMESTAMP) fail('VALIDATION', `${label} is too far in the past.`, { [field]: 'past' });
  if (rounded > now + FUTURE_TOLERANCE_MS) {
    fail('VALIDATION', `${label} cannot be in the future.`, { [field]: 'future' });
  }
  return rounded;
}

export function requireTimeZone(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !isValidTimeZone(value)) {
    fail('VALIDATION', 'Unknown time zone.', { [field]: 'invalid' });
  }
  return value;
}

export function requireIntegerInRange(
  value: unknown,
  field: string,
  label: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('VALIDATION', `${label} must be a whole number between ${min} and ${max}.`, { [field]: 'range' });
  }
  return value;
}

export function requireOneOf<T extends string>(
  value: unknown,
  field: string,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail('VALIDATION', `${label} is not a valid option.`, { [field]: 'invalid' });
  }
  return value as T;
}

export function requireTrackerStatus(value: unknown): TrackerStatus {
  return requireOneOf(value, 'status', 'Status', ['active', 'paused', 'archived'] as const);
}

export function validateAppSettingsPatch(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('VALIDATION', 'Settings must be an object.');
  }
  const input = patch as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(input, key);

  if (has('theme')) {
    clean.theme = requireOneOf(input.theme, 'theme', 'Theme', ['system', 'light', 'dark'] as const);
  }
  if (has('timeFormat')) {
    clean.timeFormat = requireOneOf<TimeFormat>(input.timeFormat, 'timeFormat', 'Time format', ['12h', '24h']);
  }
  if (has('dateFormat')) {
    const allowed: DateFormat[] = ['MMM d, yyyy', 'd MMM yyyy', 'MM/dd/yyyy', 'dd/MM/yyyy', 'yyyy-MM-dd'];
    clean.dateFormat = requireOneOf(input.dateFormat, 'dateFormat', 'Date format', allowed);
  }
  if (has('firstDayOfWeek')) {
    if (input.firstDayOfWeek !== 0 && input.firstDayOfWeek !== 1) {
      fail('VALIDATION', 'First day of week must be Sunday or Monday.', { firstDayOfWeek: 'invalid' });
    }
    clean.firstDayOfWeek = input.firstDayOfWeek;
  }
  if (has('timeZoneMode')) {
    clean.timeZoneMode = requireOneOf(input.timeZoneMode, 'timeZoneMode', 'Time zone behaviour', [
      'device',
      'fixed',
    ] as const);
  }
  if (has('fixedTimeZone')) {
    if (input.fixedTimeZone === null) clean.fixedTimeZone = null;
    else clean.fixedTimeZone = requireTimeZone(input.fixedTimeZone, 'fixedTimeZone', 'UTC');
  }
  if (has('durationFormat')) {
    clean.durationFormat = requireOneOf<DurationFormat>(input.durationFormat, 'durationFormat', 'Duration format', [
      'short',
      'long',
      'compact',
    ]);
  }
  if (has('notificationsEnabled')) {
    if (typeof input.notificationsEnabled !== 'boolean') {
      fail('VALIDATION', 'Notifications setting must be true or false.', { notificationsEnabled: 'type' });
    }
    clean.notificationsEnabled = input.notificationsEnabled;
  }
  if (has('notificationIntervalMinutes')) {
    if (
      typeof input.notificationIntervalMinutes !== 'number' ||
      !Number.isFinite(input.notificationIntervalMinutes) ||
      input.notificationIntervalMinutes < 60 ||
      input.notificationIntervalMinutes > 60 * 24 * 30
    ) {
      fail('VALIDATION', 'Acknowledgement interval must be between 1 hour and 30 days.', {
        notificationIntervalMinutes: 'range',
      });
    }
    clean.notificationIntervalMinutes = Math.round(input.notificationIntervalMinutes);
  }
  if (has('exportPreference')) {
    clean.exportPreference = requireOneOf(input.exportPreference, 'exportPreference', 'Export preference', [
      'json',
      'encrypted',
    ] as const);
  }
  if (has('defaultTriggerCategoryIds')) {
    if (
      !Array.isArray(input.defaultTriggerCategoryIds) ||
      input.defaultTriggerCategoryIds.some((value) => typeof value !== 'string')
    ) {
      fail('VALIDATION', 'Default trigger categories must be a list of category ids.', {
        defaultTriggerCategoryIds: 'type',
      });
    }
    clean.defaultTriggerCategoryIds = [...new Set(input.defaultTriggerCategoryIds as string[])];
  }
  if (has('confirmDestructiveImports')) {
    if (typeof input.confirmDestructiveImports !== 'boolean') {
      fail('VALIDATION', 'Import confirmation setting must be true or false.', { confirmDestructiveImports: 'type' });
    }
    clean.confirmDestructiveImports = input.confirmDestructiveImports;
  }
  if (has('onboarded')) {
    if (typeof input.onboarded !== 'boolean') {
      fail('VALIDATION', 'Onboarding flag must be true or false.', { onboarded: 'type' });
    }
    clean.onboarded = input.onboarded;
  }
  return clean;
}
