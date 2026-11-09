/** Injectable clock so calculations stay deterministic in tests. */
export interface Clock {
  now(): number;
  /** IANA timezone of the device at call time. */
  timeZone(): string;
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    timeZone: () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    },
  };
}

export function fixedClock(now: number, timeZone = 'UTC'): Clock {
  return { now: () => now, timeZone: () => timeZone };
}
