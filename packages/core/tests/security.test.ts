import { describe, expect, it } from 'vitest';
import { BASE_LOCKOUT_MS, MAX_LOCKOUT_MS, TyagError, isTyagError } from '../src/index';
import { createTestCore, reopenTestCore, DAY, T0 } from './helpers';

const PASSWORD = '4829';
const WRONG_PIN = '0000';

async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected an error');
  } catch (error) {
    expect(isTyagError(error)).toBe(true);
    expect((error as TyagError).code).toBe(code);
  }
}

describe('app lock security', () => {
  it('starts without a PIN and sets one with a salted hash', async () => {
    const { core } = await createTestCore();
    expect(core.security.hasPassword()).toBe(false);
    expect(core.security.biometricsEnabled()).toBe(false);
    await core.security.setPassword(PASSWORD);
    expect(core.security.hasPassword()).toBe(true);
    const hash = core.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'security.password_hash'");
    const salt = core.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'security.password_salt'");
    expect(hash?.value).toBeTruthy();
    expect(salt?.value).toBeTruthy();
    expect(hash?.value).not.toContain(PASSWORD);
    const rows = core.db.all<{ key: string; value: string }>('SELECT key, value FROM meta');
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it('verifies the correct PIN and rejects wrong ones', async () => {
    const { core } = await createTestCore();
    await core.security.setPassword(PASSWORD);
    expect(await core.security.verifyPassword(PASSWORD)).toBe(true);
    expect(await core.security.verifyPassword('9999')).toBe(false);
    expect(await core.security.verifyPassword('')).toBe(false);
  });

  it('rejects non-PIN or too-short PINs and biometrics without a PIN', async () => {
    const { core } = await createTestCore();
    for (const invalid of ['123', '12345', 'abcd', '']) {
      await expectError(core.security.setPassword(invalid), 'VALIDATION');
    }
    await expectError(core.security.setBiometricsEnabled(true), 'VALIDATION');
  });

  it('stores the biometric flag locally and changes/removes the PIN', async () => {
    const { core } = await createTestCore();
    await core.security.setPassword(PASSWORD, { biometricsEnabled: true });
    expect(core.security.biometricsEnabled()).toBe(true);
    await core.security.setBiometricsEnabled(false);
    expect(core.security.biometricsEnabled()).toBe(false);
    await core.security.setPassword('9021');
    expect(await core.security.verifyPassword(PASSWORD)).toBe(false);
    expect(await core.security.verifyPassword('9021')).toBe(true);
    await core.security.clearPassword();
    expect(core.security.hasPassword()).toBe(false);
    expect(core.security.biometricsEnabled()).toBe(false);
  });

  it('keeps the lock hash across a restart', async () => {    const test = await createTestCore();
    await test.core.security.setPassword(PASSWORD, { biometricsEnabled: true });
    test.core.close();
    const reopened = await reopenTestCore(test);
    expect(reopened.core.security.hasPassword()).toBe(true);
    expect(reopened.core.security.biometricsEnabled()).toBe(true);
    expect(await reopened.core.security.verifyPassword(PASSWORD)).toBe(true);
  });

  it('does not export the PIN hash or biometric flag in backups', async () => {
    const { core } = await createTestCore();
    await core.trackers.create({ name: 'Private' });
    await core.security.setPassword(PASSWORD, { biometricsEnabled: true });
    const exported = await core.backup.exportJson();
    expect(exported.content).not.toContain('security.password');
    expect(exported.content).not.toContain(PASSWORD);
    expect(exported.content).not.toContain('security.biometrics');
  });

  it('wipes all user data and the lock, leaving a usable empty schema', async () => {
    const { core, clock } = await createTestCore();
    const tracker = await core.trackers.create({ name: 'Temporary' });
    clock.advance(DAY);
    await core.lapses.create({ trackerId: tracker.id });
    await core.journal.create({ body: 'A private note.' });
    await core.settings.update({ theme: 'dark' });
    await core.security.setPassword(PASSWORD);
    await core.security.wipeAllData();
    expect(core.trackers.list()).toHaveLength(0);
    expect(core.journal.list()).toHaveLength(0);
    expect(core.history.list()).toHaveLength(0);
    expect(core.settings.get().theme).toBe('system');
    expect(core.security.hasPassword()).toBe(false);
    expect(core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')?.n).toBe(2);
    expect(core.checkIntegrity()).toBe('ok');
    const dayTwo = core.trackers.create({ name: 'Fresh start' });
    await expect(dayTwo).resolves.toBeTruthy();
    void T0;
  });
});

describe('PIN brute-force protection', () => {
  it('locks after repeated failures and refuses even the correct PIN while locked', async () => {
    const { core, clock } = await createTestCore();
    await core.security.setPassword(PASSWORD);

    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(await core.security.verifyPassword(WRONG_PIN)).toBe(false);
    }
    let status = core.security.lockoutStatus();
    expect(status.failedAttempts).toBe(4);
    expect(status.remainingMs).toBe(0);
    expect(status.attemptsLeft).toBe(1);

    expect(await core.security.verifyPassword(WRONG_PIN)).toBe(false);
    status = core.security.lockoutStatus();
    expect(status.failedAttempts).toBe(5);
    expect(status.remainingMs).toBe(BASE_LOCKOUT_MS);
    expect(status.attemptsLeft).toBe(0);
    expect(status.lockedUntil).toBe(T0 + BASE_LOCKOUT_MS);

    // The correct PIN is refused while locked out and does not extend the wait.
    expect(await core.security.verifyPassword(PASSWORD)).toBe(false);
    expect(core.security.lockoutStatus().remainingMs).toBe(BASE_LOCKOUT_MS);

    clock.advance(BASE_LOCKOUT_MS - 1);
    expect(await core.security.verifyPassword(PASSWORD)).toBe(false);
    clock.advance(1);
    expect(await core.security.verifyPassword(PASSWORD)).toBe(true);
    status = core.security.lockoutStatus();
    expect(status.failedAttempts).toBe(0);
    expect(status.lockedUntil).toBe(0);
    expect(status.remainingMs).toBe(0);
  });

  it('persists the lockout across an app restart', async () => {
    const test = await createTestCore();
    await test.core.security.setPassword(PASSWORD);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await test.core.security.verifyPassword(WRONG_PIN)).toBe(false);
    }
    expect(test.core.security.lockoutStatus().remainingMs).toBe(BASE_LOCKOUT_MS);

    test.core.close();
    const reopened = await reopenTestCore(test);
    expect(reopened.core.security.lockoutStatus().remainingMs).toBe(BASE_LOCKOUT_MS);
    expect(await reopened.core.security.verifyPassword(PASSWORD)).toBe(false);
    reopened.clock.advance(BASE_LOCKOUT_MS);
    expect(await reopened.core.security.verifyPassword(PASSWORD)).toBe(true);
  });

  it('escalates the lockout exponentially and caps it', async () => {
    const { core, clock } = await createTestCore();
    await core.security.setPassword(PASSWORD);
    const durations: number[] = [];
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      expect(await core.security.verifyPassword(WRONG_PIN)).toBe(false);
      if (attempt >= 5) {
        const status = core.security.lockoutStatus();
        durations.push(status.remainingMs);
        clock.advance(status.remainingMs);
      }
    }
    expect(durations).toEqual([
      BASE_LOCKOUT_MS,
      BASE_LOCKOUT_MS * 2,
      BASE_LOCKOUT_MS * 4,
      BASE_LOCKOUT_MS * 8,
      BASE_LOCKOUT_MS * 16,
      MAX_LOCKOUT_MS,
      MAX_LOCKOUT_MS,
    ]);
    clock.advance(MAX_LOCKOUT_MS);
    expect(await core.security.verifyPassword(PASSWORD)).toBe(true);
    expect(core.security.lockoutStatus().failedAttempts).toBe(0);
  });

  it('resets attempts on success and when the PIN or lock is replaced', async () => {
    const { core } = await createTestCore();
    await core.security.setPassword(PASSWORD);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await core.security.verifyPassword(WRONG_PIN)).toBe(false);
    }
    expect(core.security.lockoutStatus().failedAttempts).toBe(3);
    expect(await core.security.verifyPassword(PASSWORD)).toBe(true);
    expect(core.security.lockoutStatus().failedAttempts).toBe(0);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await core.security.verifyPassword(WRONG_PIN)).toBe(false);
    }
    expect(core.security.lockoutStatus().remainingMs).toBe(BASE_LOCKOUT_MS);
    await core.security.setPassword('9021');
    expect(core.security.lockoutStatus().remainingMs).toBe(0);
    expect(await core.security.verifyPassword('9021')).toBe(true);

    await core.security.clearPassword();
    expect(core.security.hasPassword()).toBe(false);
    expect(core.security.lockoutStatus().remainingMs).toBe(0);
  });
});
