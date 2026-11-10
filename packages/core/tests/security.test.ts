import { describe, expect, it } from 'vitest';
import { DeUrgeError, isDeUrgeError } from '../src/index';
import { createTestCore, reopenTestCore, DAY, T0 } from './helpers';

const PASSWORD = '4829';

async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected an error');
  } catch (error) {
    expect(isDeUrgeError(error)).toBe(true);
    expect((error as DeUrgeError).code).toBe(code);
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

  it('keeps the lock hash across a restart', async () => {
    const test = await createTestCore();
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
