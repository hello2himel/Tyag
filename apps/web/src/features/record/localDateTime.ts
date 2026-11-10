/**
 * `<input type="datetime-local">` speaks local wall-clock time, while every
 * Tyag record is stored as a UTC instant. These helpers convert between the
 * two through the app's *effective* timezone (device or fixed, as chosen in
 * Settings) using Temporal, so DST gaps and repeated hours behave exactly like
 * the calculation engines.
 *
 * They are shared by the record sheet, the tracker sheet and onboarding.
 */
import { Temporal, zonedAt } from '@tyag/core';

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** UTC epoch milliseconds -> "YYYY-MM-DDTHH:mm" in `timeZone`. */
export function toDateTimeLocalValue(epochMs: number, timeZone: string): string {
  const zdt = zonedAt(epochMs, timeZone);
  return `${pad(zdt.year, 4)}-${pad(zdt.month)}-${pad(zdt.day)}T${pad(zdt.hour)}:${pad(zdt.minute)}`;
}

/**
 * "YYYY-MM-DDTHH:mm" wall-clock time in `timeZone` -> UTC epoch milliseconds.
 * Returns null for empty or unparseable values. Seconds are always zero, so a
 * caller that wants to keep an existing sub-minute timestamp should simply not
 * send the value when the input was not edited.
 */
export function fromDateTimeLocalValue(value: string, timeZone: string): number | null {
  if (!value) return null;
  try {
    const wallClock = Temporal.PlainDateTime.from(value);
    return wallClock.toZonedDateTime(timeZone).toInstant().epochMilliseconds;
  } catch {
    return null;
  }
}
