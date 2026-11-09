/** Raw SQLite row shapes and shared mapping helpers. */
export type BoolInt = 0 | 1;

export function boolToInt(value: boolean): BoolInt {
  return value ? 1 : 0;
}

export function intToBool(value: number): boolean {
  return value !== 0;
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Corrupt record: ${field} is not a string`);
  return value;
}

export function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Corrupt record: ${field} is not a finite number`);
  }
  return value;
}
