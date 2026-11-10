/**
 * App lock: the password/biometric gate shown before any records are rendered.
 *
 * - First run after onboarding (or after upgrading without a lock) forces the
 *   user to set a password.
 * - Every visit/cold start shows the unlock screen.
 * - Android can use the system BiometricPrompt instead of typing the password.
 * - Forgetting the password can only be recovered by erasing local data and
 *   re-importing a backup; there is deliberately no server-side recovery.
 */
import { useEffect, useRef, useState } from 'react';
import { isDeUrgeError, userMessage } from '@deurge/core';
import { useApp } from '../../store/app';
import { Button, Field, Input, Modal, Toggle, useToast } from '../../ui/components';
import { DeUrgeAppIcon } from '../../ui/logo';
import {
  authenticateBiometrics,
  biometricsAvailable,
  type BiometricAvailability,
} from '../../platform/biometrics';
import './lock.css';

const MIN_PASSWORD_LENGTH = 8;
const AUTO_LOCK_AFTER_MS = 60_000;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 30_000;

function LockBrand() {
  return (
    <div className="lock-mark">
      <DeUrgeAppIcon size={72} />
    </div>
  );
}

export function SetPasswordScreen({
  mode = 'create',
  onDone,
  onCancel,
}: {
  mode?: 'create' | 'change';
  onDone: () => void;
  onCancel?: () => void;
}) {
  const app = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [wantsBiometrics, setWantsBiometrics] = useState(false);
  const [availability, setAvailability] = useState<BiometricAvailability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void biometricsAvailable().then((result) => {
      if (!cancelled) setAvailability(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const canUseBiometrics = availability?.available === true;

  async function submit(): Promise<void> {
    if (saving) return;
    setError(null);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      if (mode === 'change') {
        const valid = await app.core.security.verifyPassword(current);
        if (!valid) {
          setError('Your current password is incorrect.');
          return;
        }
      }
      let biometricsEnabled = mode === 'change' ? app.core.security.biometricsEnabled() : false;
      if (mode === 'create' && wantsBiometrics && canUseBiometrics) {
        const result = await authenticateBiometrics();
        if (!result.success) {
          setError(result.error ?? 'Biometric authentication failed. Try again or turn it off.');
          return;
        }
        biometricsEnabled = true;
      }
      await app.core.security.setPassword(next, { biometricsEnabled });
      onDone();
    } catch (failure) {
      setError(isDeUrgeError(failure) ? userMessage(failure) : 'The password could not be saved. Nothing changed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="lock-setup">
      <div className="lock-setup-inner">
        <LockBrand />
        <h1 className="lock-title">{mode === 'create' ? 'Protect deUrge' : 'Change password'}</h1>
        <p className="lock-subtitle">
          {mode === 'create'
            ? 'Choose a password to open deUrge on this device. You will need it each time you visit.'
            : 'Enter your current password, then choose a new one.'}
        </p>
        <div className="lock-form">
          {mode === 'change' ? (
            <Field label="Current password" htmlFor="lock-current">
              <Input
                id="lock-current"
                type="password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                autoComplete="current-password"
                autoFocus
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
          ) : null}
          <Field label={mode === 'create' ? 'Password' : 'New password'} htmlFor="lock-new" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
            <Input
              id="lock-new"
              type="password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              autoComplete="new-password"
              autoFocus={mode === 'create'}
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Confirm password" htmlFor="lock-confirm">
            <Input
              id="lock-confirm"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          </Field>
          {error ? (
            <p className="lock-error" role="alert">
              {error}
            </p>
          ) : null}
          {mode === 'create' && canUseBiometrics ? (
            <div className="lock-toggle">
              <Toggle
                label="Unlock with biometrics"
                description="Use your fingerprint or face instead of typing the password. Android only."
                checked={wantsBiometrics}
                onChange={setWantsBiometrics}
                disabled={saving}
              />
            </div>
          ) : null}
          <div className="lock-actions">
            <Button variant="primary" block onClick={() => void submit()} disabled={saving}>
              {saving ? 'Saving…' : mode === 'create' ? 'Set password' : 'Save new password'}
            </Button>
            {mode === 'change' && onCancel ? (
              <Button block onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
        <p className="lock-note">
          deUrge cannot recover this password. If you forget it, you can reset the app — that erases the data on this device,
          so keep a backup. The password is stored only as a salted hash that never leaves this device.
        </p>
      </div>
    </div>
  );
}

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const app = useApp();
  const config = app.core.security.config();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [availability, setAvailability] = useState<BiometricAvailability | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetting, setResetting] = useState(false);
  const autoPrompted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void biometricsAvailable().then((result) => {
      if (cancelled) return;
      setAvailability(result);
      if (config.biometricsEnabled && result.available && !autoPrompted.current) {
        autoPrompted.current = true;
        void tryBiometrics(true);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const cooldownRemaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const canUseBiometrics = config.biometricsEnabled && availability?.available === true;

  async function tryBiometrics(auto = false): Promise<void> {
    if (bioBusy) return;
    setBioBusy(true);
    setError(null);
    try {
      const result = await authenticateBiometrics();
      if (result.success) {
        onUnlock();
      } else if (!auto && result.error) {
        setError(result.error);
      }
    } finally {
      setBioBusy(false);
    }
  }

  async function unlock(): Promise<void> {
    if (busy || cooldownRemaining > 0) return;
    setBusy(true);
    setError(null);
    try {
      const valid = await app.core.security.verifyPassword(password);
      if (valid) {
        onUnlock();
        return;
      }
      const nextAttempts = failedAttempts + 1;
      setFailedAttempts(nextAttempts);
      if (nextAttempts >= MAX_ATTEMPTS) {
        setCooldownUntil(Date.now() + COOLDOWN_MS);
        setNow(Date.now());
        setError('Too many incorrect attempts. Wait 30 seconds and try again.');
      } else {
        setError('Incorrect password. Try again.');
      }
    } catch {
      setError('The password could not be checked. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function resetApp(): Promise<void> {
    if (resetting || resetText.trim().toLowerCase() !== 'reset') return;
    setResetting(true);
    try {
      await app.core.security.wipeAllData();
      window.location.reload();
    } catch {
      setError('The app could not be reset. Close deUrge and try again.');
      setResetting(false);
    }
  }

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <LockBrand />
        <h1 className="lock-title">Welcome back</h1>
        <p className="lock-subtitle">deUrge is locked. Enter your password to open your private records.</p>
        <div className="lock-form">
          <Field label="Password" htmlFor="lock-password">
            <Input
              id="lock-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void unlock();
              }}
            />
          </Field>
          {error ? (
            <p className="lock-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="lock-actions">
            <Button
              variant="primary"
              block
              onClick={() => void unlock()}
              disabled={busy || cooldownRemaining > 0 || password.length === 0}
            >
              {busy ? 'Checking…' : cooldownRemaining > 0 ? `Try again in ${cooldownRemaining}s` : 'Unlock'}
            </Button>
            {canUseBiometrics ? (
              <>
                <div className="lock-divider">or</div>
                <Button
                  variant="secondary"
                  block
                  className="lock-bio"
                  onClick={() => void tryBiometrics(false)}
                  disabled={bioBusy}
                >
                  {bioBusy ? 'Waiting for biometrics…' : 'Unlock with biometrics'}
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {config.biometricsEnabled && availability && !availability.available ? (
          <p className="lock-note">Biometric unlock is enabled, but no biometric is available right now. Use your password.</p>
        ) : null}
        <button type="button" className="lock-link" onClick={() => setResetOpen((value) => !value)}>
          Forgot password?
        </button>
        {resetOpen ? (
          <div className="lock-reset">
            <p>
              There is no password recovery. Resetting erases every tracker, lapse, urge, journal entry and setting on this
              device, then starts fresh. Export a backup from another device first if you have one.
            </p>
            <Field label='Type "reset" to confirm' htmlFor="lock-reset-confirm">
              <Input
                id="lock-reset-confirm"
                value={resetText}
                onChange={(event) => setResetText(event.target.value)}
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Button
              variant="danger"
              block
              disabled={resetting || resetText.trim().toLowerCase() !== 'reset'}
              onClick={() => void resetApp()}
            >
              {resetting ? 'Erasing…' : 'Erase all data and reset app'}
            </Button>
          </div>
        ) : null}
        <p className="lock-note">Your password is checked locally. It is never sent anywhere.</p>
      </div>
    </div>
  );
}

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  }, [open]);

  async function save(): Promise<void> {
    if (saving) return;
    setError(null);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      if (!(await app.core.security.verifyPassword(current))) {
        setError('Your current password is incorrect.');
        return;
      }
      await app.core.security.setPassword(next, { biometricsEnabled: app.core.security.biometricsEnabled() });
      toast.show('Password changed.');
      onClose();
    } catch (failure) {
      setError(isDeUrgeError(failure) ? userMessage(failure) : 'The password could not be changed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change password"
      actions={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="mut" style={{ margin: 0, fontSize: 14 }}>
          Changing the password does not re-encrypt any backup files you have already created.
        </p>
        <Field label="Current password" htmlFor="change-current">
          <Input
            id="change-current"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field label="New password" htmlFor="change-new" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          <Input
            id="change-new"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field label="Confirm new password" htmlFor="change-confirm">
          <Input
            id="change-confirm"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        {error ? (
          <p className="lock-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
