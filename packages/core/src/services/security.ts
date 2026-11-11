/**
 * App-lock security.
 *
 * The PIN is never stored or exported. Only a salted PBKDF2-SHA-256 hash lives
 * in the local `meta` table (which is intentionally not part of JSON backups),
 * so backups can be restored on a new device and protected with a new PIN. The
 * optional biometric flag is local-only too.
 *
 * This is an application access gate, not database encryption: the SQLite file
 * itself is protected by the operating system's app-private storage and disk
 * encryption. See docs/PRIVACY.md.
 */
import type { SqlDatabase } from '../db/sqlite';
import { metaRepo } from '../repos/meta';
import { fail } from '../util/errors';
import { write, type CoreContext } from './context';

const HASH_KEY = 'security.password_hash';
const SALT_KEY = 'security.password_salt';
const ITERATIONS_KEY = 'security.password_iterations';
const BIOMETRICS_KEY = 'security.biometrics_enabled';
/** Consecutive wrong PINs after which the lockout clock starts. */
const FAILED_ATTEMPTS_KEY = 'security.failed_attempts';
/** Epoch milliseconds until which PIN verification is refused (0 = unlocked). */
const LOCKED_UNTIL_KEY = 'security.locked_until';

/** PBKDF2 iteration count (OWASP-style 2026 baseline for SHA-256). */
export const PASSWORD_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/**
 * Brute-force protection: a 4-digit PIN has only 10,000 combinations, so an
 * unlimited offline/online guess loop would be trivially fast. After
 * {@link MAX_FAILED_ATTEMPTS} consecutive wrong PINs the app refuses further
 * verification for {@link BASE_LOCKOUT_MS}; every further wrong PIN doubles the
 * wait, capped at {@link MAX_LOCKOUT_MS}. The counters live in the local `meta`
 * table, so closing/reloading the app or killing it does not reset the clock,
 * and a correct PIN is the only thing that clears the state.
 *
 * This is deliberately an application gate: someone who can write the SQLite
 * file can also reset these counters. Device encryption/app-private storage
 * remain the real protection for the data (see docs/PRIVACY.md).
 */
export const MAX_FAILED_ATTEMPTS = 5;
export const BASE_LOCKOUT_MS = 30_000;
export const MAX_LOCKOUT_MS = 15 * 60_000;

export interface AppLockConfig {
  hasPassword: boolean;
  biometricsEnabled: boolean;
}

export interface LockoutStatus {
  /** Consecutive wrong PINs since the last successful unlock. */
  failedAttempts: number;
  /** Epoch ms until which verification is refused (0 when not locked out). */
  lockedUntil: number;
  /** Milliseconds left in the current lockout (0 when not locked out). */
  remainingMs: number;
  /** Wrong PINs still allowed before the lockout starts (0 once locked out). */
  attemptsLeft: number;
  /** Total attempts allowed before the lockout starts. */
  maxAttempts: number;
  /** Lockout that the next wrong PIN would trigger (0 while below the limit). */
  nextLockoutMs: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

async function deriveHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    fail('UNAVAILABLE', 'This device does not support secure password hashing.');
  }
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export class SecurityService {
  constructor(private readonly ctx: CoreContext) {}

  hasPassword(): boolean {
    return (metaRepo.get(this.ctx.db, HASH_KEY) ?? '').length > 0;
  }

  biometricsEnabled(): boolean {
    return this.hasPassword() && metaRepo.get(this.ctx.db, BIOMETRICS_KEY) === '1';
  }

  config(): AppLockConfig {
    return { hasPassword: this.hasPassword(), biometricsEnabled: this.biometricsEnabled() };
  }

  async setPassword(password: string, options: { biometricsEnabled?: boolean } = {}): Promise<void> {
    this.validatePassword(password);
    const salt = new Uint8Array(SALT_BYTES);
    const cryptoObject = globalThis.crypto;
    if (!cryptoObject?.getRandomValues) {
      fail('UNAVAILABLE', 'This device does not support secure password hashing.');
    }
    cryptoObject.getRandomValues(salt);
    const hash = await deriveHash(password, salt, PASSWORD_ITERATIONS);
    await write(this.ctx, () => {
      metaRepo.set(this.ctx.db, HASH_KEY, bytesToBase64(hash));
      metaRepo.set(this.ctx.db, SALT_KEY, bytesToBase64(salt));
      metaRepo.set(this.ctx.db, ITERATIONS_KEY, String(PASSWORD_ITERATIONS));
      metaRepo.set(this.ctx.db, BIOMETRICS_KEY, options.biometricsEnabled ? '1' : '0');
      // A new PIN always starts with a clean brute-force slate.
      this.storeAttemptState(0, 0);
    });
  }

  /**
   * Brute-force state for the UI. Reads the persisted counters synchronously so
   * a freshly mounted lock screen can show the remaining wait immediately after
   * an app restart.
   */
  lockoutStatus(now = this.ctx.clock.now()): LockoutStatus {
    const { failedAttempts, lockedUntil } = this.readAttemptState();
    const remainingMs = lockedUntil > now ? lockedUntil - now : 0;
    const nextFailure = failedAttempts + 1;
    return {
      failedAttempts,
      lockedUntil: remainingMs > 0 ? lockedUntil : 0,
      remainingMs,
      attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - failedAttempts),
      maxAttempts: MAX_FAILED_ATTEMPTS,
      nextLockoutMs: nextFailure >= MAX_FAILED_ATTEMPTS ? this.lockoutDurationMs(nextFailure) : 0,
    };
  }

  /** True while a lockout is active (convenience for callers/UI). */
  isLockedOut(now = this.ctx.clock.now()): boolean {
    return this.lockoutStatus(now).remainingMs > 0;
  }

  /**
   * Clear the failed-attempt state. Called after a successful biometric unlock:
   * the OS verified the user, so the PIN lockout has served its purpose and
   * must not keep the legitimate user out of their own app.
   */
  async resetLockout(): Promise<void> {
    const state = this.readAttemptState();
    if (state.failedAttempts === 0 && state.lockedUntil === 0) return;
    await write(this.ctx, () => this.storeAttemptState(0, 0));
  }

  /**
   * Verify a PIN, enforcing the persistent brute-force lockout.
   *
   * During a lockout the PIN is not even hashed, so an attacker cannot use the
   * verify call as a free attempt or timing oracle. Every wrong PIN after the
   * limit extends the lockout; only a correct PIN clears the counters.
   */
  async verifyPassword(password: string): Promise<boolean> {
    const hashB64 = metaRepo.get(this.ctx.db, HASH_KEY);
    const saltB64 = metaRepo.get(this.ctx.db, SALT_KEY);
    const iterations = Number(metaRepo.get(this.ctx.db, ITERATIONS_KEY) ?? PASSWORD_ITERATIONS);
    if (!hashB64 || !saltB64 || !Number.isFinite(iterations) || iterations < 10_000) return false;

    const now = this.ctx.clock.now();
    const state = this.readAttemptState();
    if (state.lockedUntil > now) return false;

    const candidate = await deriveHash(password, base64ToBytes(saltB64), iterations);
    const ok = equalBytes(candidate, base64ToBytes(hashB64));

    if (ok) {
      if (state.failedAttempts > 0 || state.lockedUntil > 0) {
        // Best effort: never block a *correct* unlock on a snapshot write error.
        try {
          await write(this.ctx, () => this.storeAttemptState(0, 0));
        } catch {
          /* the in-memory counters are already cleared; persistence is retried on the next write */
        }
      }
      return true;
    }

    const failedAttempts = state.failedAttempts + 1;
    const lockedUntil =
      failedAttempts >= MAX_FAILED_ATTEMPTS ? now + this.lockoutDurationMs(failedAttempts) : 0;
    try {
      await write(this.ctx, () => this.storeAttemptState(failedAttempts, lockedUntil));
    } catch {
      // Never turn a failed verification into an unlock: the in-memory counter
      // still applies for this session even if the snapshot could not be written.
    }
    return false;
  }

  private readAttemptState(): { failedAttempts: number; lockedUntil: number } {
    const attempts = Number(metaRepo.get(this.ctx.db, FAILED_ATTEMPTS_KEY) ?? '0');
    const lockedUntil = Number(metaRepo.get(this.ctx.db, LOCKED_UNTIL_KEY) ?? '0');
    return {
      failedAttempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
      lockedUntil: Number.isFinite(lockedUntil) && lockedUntil > 0 ? Math.floor(lockedUntil) : 0,
    };
  }

  private storeAttemptState(failedAttempts: number, lockedUntil: number): void {
    if (failedAttempts <= 0 && lockedUntil <= 0) {
      metaRepo.delete(this.ctx.db, FAILED_ATTEMPTS_KEY);
      metaRepo.delete(this.ctx.db, LOCKED_UNTIL_KEY);
      return;
    }
    metaRepo.set(this.ctx.db, FAILED_ATTEMPTS_KEY, String(failedAttempts));
    metaRepo.set(this.ctx.db, LOCKED_UNTIL_KEY, String(lockedUntil));
  }

  /** Exponential backoff for the failed-attempt count, capped. */
  private lockoutDurationMs(failedAttempts: number): number {
    const steps = Math.max(0, failedAttempts - MAX_FAILED_ATTEMPTS);
    return Math.min(BASE_LOCKOUT_MS * 2 ** steps, MAX_LOCKOUT_MS);
  }

  async setBiometricsEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.hasPassword()) {
      fail('VALIDATION', 'Set an app PIN before enabling biometric unlock.');
    }
    await write(this.ctx, () => {
      metaRepo.set(this.ctx.db, BIOMETRICS_KEY, enabled ? '1' : '0');
    });
  }

  async clearPassword(): Promise<void> {
    await write(this.ctx, () => {
      for (const key of [
        HASH_KEY,
        SALT_KEY,
        ITERATIONS_KEY,
        BIOMETRICS_KEY,
        FAILED_ATTEMPTS_KEY,
        LOCKED_UNTIL_KEY,
      ]) {
        metaRepo.delete(this.ctx.db, key);
      }
    });
  }

  /**
   * Erase all user data (and the app lock) while keeping the schema, then persist.
   * Used by the "forgot password / reset app" path after explicit confirmation.
   */
  async wipeAllData(): Promise<void> {
    await write(this.ctx, () => {
      const db: SqlDatabase = this.ctx.db;
      for (const table of [
        'journal_entries',
        'check_ins',
        'history_events',
        'lapse_events',
        'urge_events',
        'tracker_sessions',
        'trackers',
        'custom_categories',
        'application_settings',
        'meta',
      ]) {
        db.run(`DELETE FROM ${table}`);
      }
    });
  }

  private validatePassword(password: string): void {
    if (typeof password !== 'string' || !/^\d{4}$/.test(password)) {
      fail('VALIDATION', 'Enter a 4-digit PIN.');
    }
  }
}
