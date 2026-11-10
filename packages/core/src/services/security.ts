/**
 * App-lock security.
 *
 * The password is never stored or exported. Only a salted PBKDF2-SHA-256 hash
 * lives in the local `meta` table (which is intentionally not part of JSON
 * backups), so backups can be restored on a new device and protected with a new
 * password. The optional biometric flag is local-only too.
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

/** PBKDF2 iteration count (OWASP-style 2026 baseline for SHA-256). */
export const PASSWORD_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export interface AppLockConfig {
  hasPassword: boolean;
  biometricsEnabled: boolean;
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
    });
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hashB64 = metaRepo.get(this.ctx.db, HASH_KEY);
    const saltB64 = metaRepo.get(this.ctx.db, SALT_KEY);
    const iterations = Number(metaRepo.get(this.ctx.db, ITERATIONS_KEY) ?? PASSWORD_ITERATIONS);
    if (!hashB64 || !saltB64 || !Number.isFinite(iterations) || iterations < 10_000) return false;
    const candidate = await deriveHash(password, base64ToBytes(saltB64), iterations);
    return equalBytes(candidate, base64ToBytes(hashB64));
  }

  async setBiometricsEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.hasPassword()) {
      fail('VALIDATION', 'Set an app password before enabling biometric unlock.');
    }
    await write(this.ctx, () => {
      metaRepo.set(this.ctx.db, BIOMETRICS_KEY, enabled ? '1' : '0');
    });
  }

  async clearPassword(): Promise<void> {
    await write(this.ctx, () => {
      for (const key of [HASH_KEY, SALT_KEY, ITERATIONS_KEY, BIOMETRICS_KEY]) {
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
    if (typeof password !== 'string') fail('VALIDATION', 'Enter a password.');
    if (password.length < 8) fail('VALIDATION', 'Use at least 8 characters for your app password.');
    if (password.length > 256) fail('VALIDATION', 'That password is too long.');
  }
}
