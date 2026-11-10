import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  TyagCore,
  MemoryPersistence,
  loadSqlJs,
  type Clock,
  type PersistenceAdapter,
} from '../src/index';

const require = createRequire(import.meta.url);

let sqlPromise: ReturnType<typeof loadSqlJs> | null = null;

export async function loadSqlWasm(): Promise<Awaited<ReturnType<typeof loadSqlJs>>> {
  if (!sqlPromise) {
    const path = require.resolve('sql.js/dist/sql-wasm.wasm');
    const buffer = readFileSync(path);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    sqlPromise = loadSqlJs({ wasmBinary: arrayBuffer });
  }
  return sqlPromise;
}

/** Clock that tests can move forward and backward explicitly. */
export class TestClock implements Clock {
  private current: number;
  constructor(
    initial: number,
    private zone = 'UTC',
  ) {
    this.current = initial;
  }
  now(): number {
    return this.current;
  }
  timeZone(): string {
    return this.zone;
  }
  set(now: number): void {
    this.current = now;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  setZone(zone: string): void {
    this.zone = zone;
  }
}

export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00:00Z
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

export interface TestCore {
  core: TyagCore;
  persistence: PersistenceAdapter & { snapshot: () => Uint8Array | null };
  clock: TestClock;
}

export async function createTestCore(
  options: { now?: number; timeZone?: string; persistence?: MemoryPersistence } = {},
): Promise<TestCore> {
  const SQL = await loadSqlWasm();
  const now = options.now ?? T0;
  const clock = new TestClock(now, options.timeZone ?? 'UTC');
  const persistence = options.persistence ?? new MemoryPersistence();
  const core = await TyagCore.open({ SQL, persistence, clock });
  return { core, persistence, clock };
}

export async function reopenTestCore(
  test: TestCore,
  persistence: MemoryPersistence = test.persistence as MemoryPersistence,
): Promise<TestCore> {
  const SQL = await loadSqlWasm();
  const core = await TyagCore.open({ SQL, persistence, clock: test.clock });
  return { core, persistence, clock: test.clock };
}
