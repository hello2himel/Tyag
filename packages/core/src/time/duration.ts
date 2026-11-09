/**
 * Deterministic duration formatting.
 *
 * The format is derived only from the duration in milliseconds — there are no
 * milestones or thresholds in the calculation (the same string rules apply at
 * 59 minutes and at 10 years).
 */
export interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function splitDuration(ms: number): DurationParts {
  const safe = Math.max(0, Math.floor(ms));
  const days = Math.floor(safe / 86_400_000);
  const hours = Math.floor((safe % 86_400_000) / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  return { days, hours, minutes, seconds };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Short label, e.g. "12d 7h 34m", "3h 24m", "4m 12s". Used for dense UI. */
export function formatDurationShort(ms: number): string {
  const { days, hours, minutes, seconds } = splitDuration(ms);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) {
    if (seconds > 0) return `${seconds}s`;
    return '0s';
  }
  return parts.join(' ');
}

/** Compact label, e.g. "12d", "7h", "34m" — the single largest unit. */
export function formatDurationCompact(ms: number): string {
  const { days, hours, minutes, seconds } = splitDuration(ms);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export interface LongDurationOptions {
  /** Maximum number of units shown (default 2). */
  maxUnits?: number;
  /** Include seconds when the duration is below one hour (default true). */
  includeSeconds?: boolean;
  /** Join words: "and" (default) or ", ". */
  conjunction?: string;
}

/**
 * Human sentence fragment, e.g. "12 days, 7 hours", "3 hours and 24 minutes".
 * Never returns an empty string.
 */
export function formatDurationLong(ms: number, options: LongDurationOptions = {}): string {
  const maxUnits = options.maxUnits ?? 2;
  const includeSeconds = options.includeSeconds ?? true;
  const conjunction = options.conjunction ?? ' and ';
  const { days, hours, minutes, seconds } = splitDuration(ms);
  const units: string[] = [];
  if (days > 0) units.push(plural(days, 'day'));
  if (hours > 0) units.push(plural(hours, 'hour'));
  if (minutes > 0) units.push(plural(minutes, 'minute'));
  if (includeSeconds && units.length === 0 && ms < 3_600_000) {
    // Under an hour: show minutes + seconds so a brand-new streak is honest.
    if (minutes > 0) units.push(plural(minutes, 'minute'));
    units.push(plural(seconds, 'second'));
  }
  if (units.length === 0) return '0 seconds';
  const shown = units.slice(0, Math.max(1, maxUnits));
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(', ')}${conjunction}${shown[shown.length - 1]!}`;
}

/** "12 days, 7 hours and 34 minutes" — up to three units, for analytics. */
export function formatDurationFine(ms: number): string {
  const { days, hours, minutes } = splitDuration(ms);
  const units: string[] = [];
  if (days > 0) units.push(plural(days, 'day'));
  if (hours > 0) units.push(plural(hours, 'hour'));
  if (minutes > 0) units.push(plural(minutes, 'minute'));
  if (units.length === 0) return formatDurationLongBelowMinute(ms);
  return joinUnits(units);
}

function formatDurationLongBelowMinute(ms: number): string {
  const { seconds } = splitDuration(ms);
  return plural(seconds, 'second');
}

function joinUnits(units: string[]): string {
  if (units.length === 1) return units[0]!;
  if (units.length === 2) return `${units[0]} and ${units[1]}`;
  return `${units.slice(0, -1).join(', ')} and ${units[units.length - 1]}`;
}

/** Machine readable ISO-8601 duration, e.g. "P12DT7H34M". */
export function formatDurationIso(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const { days, hours, minutes, seconds } = splitDuration(safe);
  let out = 'P';
  if (days > 0) out += `${days}D`;
  if (hours > 0 || minutes > 0 || seconds > 0) {
    out += 'T';
    if (hours > 0) out += `${hours}H`;
    if (minutes > 0) out += `${minutes}M`;
    if (seconds > 0) out += `${seconds}S`;
  }
  if (out === 'P') out = 'PT0S';
  return out;
}

/** Parse a positive integer of seconds with safe fallback. */
export function secondsToMs(seconds: number | null | undefined): number | null {
  if (seconds === null || seconds === undefined) return null;
  return Math.max(0, Math.round(seconds)) * 1000;
}
