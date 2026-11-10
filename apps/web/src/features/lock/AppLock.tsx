/**
 * App lock — implemented 1:1 from the supplied deUrge PIN screen kit
 * (`deurge-pin-screens`): mobile create/confirm/lock/forgot sheets, a
 * biometrics opt-in, and the desktop lock/set-PIN cards.
 *
 * Product decisions layered on the kit: the PIN is exactly 4 digits (so every
 * "6 digits" in the kit becomes four), and Touch ID / Face ID wording is
 * replaced with "biometrics". The Android build supplies the actual system
 * biometric prompt; other platforms use the PIN only.
 */
import { useEffect, useRef, useState } from 'react';
import { isDeUrgeError, userMessage } from '@deurge/core';
import { useApp } from '../../store/app';
import { ConfirmDialog } from '../../ui/components';
import { DeUrgeMark } from '../../ui/logo';
import { haptic } from '../../ui/motion';
import { pickTextFile } from '../../platform/files';
import {
  authenticateBiometrics,
  biometricsAvailable,
  type BiometricAvailability,
} from '../../platform/biometrics';
import './lock.css';

const PIN_LENGTH = 4;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 30_000;

const DIGITS: { digit: string; letters: string }[] = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
];

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia(query);
    const listener = () => setMatches(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  return matches;
}

function BiometricsIcon({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      strokeWidth="1.6"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 4H6a2 2 0 0 0-2 2v2M16 4h2a2 2 0 0 1 2 2v2M8 20H6a2 2 0 0 1-2-2v-2M16 20h2a2 2 0 0 0 2-2v-2M9 10v1.5M15 10v1.5M12 10v3h-1M9.5 16a3.5 3.5 0 0 0 5 0" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="10" height="17" viewBox="0 0 8 13" strokeWidth="2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 1.5l-5 5 5 5" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" strokeWidth="1.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-6-6z" />
      <path d="M12 9.5l5 5M17 9.5l-5 5" />
    </svg>
  );
}

function usePinKeyboard(onDigit: (digit: string) => void, onDelete: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    function handler(event: KeyboardEvent): void {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        onDigit(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        onDelete();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, onDelete, onDigit]);
}

function PinDots({
  length,
  error = false,
  shake = 0,
  size = 'sm',
}: {
  length: number;
  error?: boolean;
  shake?: number;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      key={shake}
      className={`pn-dots pn-dots-${size}${shake > 0 ? ' shake' : ''}`}
      role="img"
      aria-label={`${length} of ${PIN_LENGTH} digits entered`}
    >
      {Array.from({ length: PIN_LENGTH }, (_, index) => (
        <i key={index} className={`${index < length ? 'on' : ''}${error ? ' err' : ''}`} />
      ))}
    </div>
  );
}

function Keypad({
  onDigit,
  onDelete,
  onBiometrics,
  locked = false,
}: {
  onDigit: (digit: string) => void;
  onDelete: () => void;
  onBiometrics?: () => void;
  locked?: boolean;
}) {
  return (
    <div className={`pn-keypad${locked ? ' locked' : ''}`}>
      {DIGITS.map(({ digit, letters }) => (
        <button key={digit} type="button" className="pn-key" onClick={() => onDigit(digit)} aria-label={digit}>
          <span className="pn-key-digit">{digit}</span>
          <small>{letters}</small>
        </button>
      ))}
      {onBiometrics ? (
        <button type="button" className="pn-key pn-key-flat" onClick={onBiometrics} aria-label="Use biometrics">
          <BiometricsIcon size={32} />
        </button>
      ) : (
        <span />
      )}
      <button type="button" className="pn-key" onClick={() => onDigit('0')} aria-label="0">
        <span className="pn-key-digit">0</span>
        <small />
      </button>
      <button type="button" className="pn-key pn-key-flat" onClick={onDelete} aria-label="Delete">
        <DeleteIcon />
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- mobile */

function MobileCreateOrConfirm({
  mode,
  onDone,
  onCancel,
  overlay,
}: {
  mode: 'create' | 'change';
  onDone: () => void;
  onCancel?: () => void;
  overlay: boolean;
}) {
  const app = useApp();
  const [stage, setStage] = useState<'current' | 'new' | 'confirm' | 'biometrics'>(
    mode === 'change' ? 'current' : 'new',
  );
  const [pin, setPin] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [biometrics, setBiometrics] = useState<BiometricAvailability | null>(null);
  const [wantsBiometrics, setWantsBiometrics] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void biometricsAvailable().then((result) => {
      if (!cancelled) setBiometrics(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const title =
    stage === 'current'
      ? 'Enter your PIN'
      : stage === 'confirm'
        ? 'Confirm your PIN'
        : 'Create a PIN';
  const subtitle =
    stage === 'current'
      ? 'Enter your current PIN to change it.'
      : stage === 'confirm'
        ? 'Enter the same PIN once more.'
        : 'You will use it to open deUrge. It stays on this device.';
  // "PIN options" only has the biometrics toggle, so it is not shown at all on
  // devices where biometrics is unavailable. Backgrounding shows the privacy
  // shield immediately; there is intentionally no configurable "Lock after" row.
  const bottomAction =
    stage === 'confirm' ? 'Start over' : stage === 'new' && mode === 'create' && biometrics?.available ? 'PIN options' : null;

  function fail(message: string): void {
    setError(message);
    setPin('');
  }

  function addDigit(digit: string): void {
    if (saving || stage === 'biometrics' || pin.length >= PIN_LENGTH) return;
    setError(null);
    const next = pin + digit;
    setPin(next);
    if (next.length === PIN_LENGTH) {
      timer.current = window.setTimeout(() => void complete(next), 160);
    }
  }

  function deleteDigit(): void {
    if (saving) return;
    setPin((current) => current.slice(0, -1));
    setError(null);
  }

  usePinKeyboard(addDigit, deleteDigit, stage !== 'biometrics');

  async function complete(entered: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (stage === 'current') {
        if (!(await app.core.security.verifyPassword(entered))) {
          fail('Incorrect PIN. Try again.');
          return;
        }
        setStage('new');
        setPin('');
      } else if (stage === 'new') {
        setFirstPin(entered);
        setStage('confirm');
        setPin('');
      } else if (entered !== firstPin) {
        setStage('new');
        setFirstPin('');
        setError('PINs did not match. Try again.');
        setPin('');
      } else {
        await app.core.security.setPassword(entered, { biometricsEnabled: app.core.security.biometricsEnabled() });
        setPin('');
        const availability = biometrics ?? (await biometricsAvailable());
        setBiometrics(availability);
        if (mode === 'create' && availability.available) {
          setStage('biometrics');
        } else {
          onDone();
        }
      }
    } catch (failure) {
      setError(isDeUrgeError(failure) ? userMessage(failure) : 'The PIN could not be saved.');
      setPin('');
    } finally {
      setSaving(false);
    }
  }

  async function enableBiometrics(): Promise<void> {
    setBioError(null);
    const result = await authenticateBiometrics();
    if (!result.success) {
      setBioError(result.error ?? 'Biometric authentication failed. You can continue with your PIN.');
      return;
    }
    await app.core.security.setBiometricsEnabled(true);
    onDone();
  }

  async function declineBiometrics(): Promise<void> {
    await app.core.security.setBiometricsEnabled(false);
    onDone();
  }

  if (stage === 'biometrics') {
    return (
      <div className={`pin-ui pn-screen ${overlay ? 'pn-overlay-screen' : ''}`}>
        <div className="pn-bio">
          <div className="pn-bio-icon">
            <BiometricsIcon size={56} />
          </div>
          <h1 className="pn-big">Unlock with biometrics?</h1>
          <p className="pn-muted pn-bio-copy">
            Skip typing your PIN. Biometric data stays in the system. deUrge never sees it, and your PIN always works too.
          </p>
          {bioError ? <p className="pn-error">{bioError}</p> : null}
          <button type="button" className="pn-btn pn-btn-primary" onClick={() => void enableBiometrics()}>
            Enable biometrics
          </button>
          <button type="button" className="pn-btn pn-btn-text pn-bio-skip" onClick={() => void declineBiometrics()}>
            Not Now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`pin-ui pn-screen ${overlay ? 'pn-overlay-screen' : ''}`}>
      <div className="pn-mobile-top">
        {onCancel ? (
          <button type="button" className="pn-btn-text pn-back" onClick={onCancel}>
            <BackIcon /> Back
          </button>
        ) : stage === 'confirm' ? (
          <button
            type="button"
            className="pn-btn-text pn-back"
            onClick={() => {
              setStage('new');
              setFirstPin('');
              setPin('');
              setError(null);
            }}
          >
            <BackIcon /> Back
          </button>
        ) : (
          <span />
        )}
      </div>
      <div className="pn-mobile-head pn-stage-enter" key={stage}>
        <h1 className="pn-big pn-create-title">{title}</h1>
        <p className="pn-muted pn-mobile-subtitle">{subtitle}</p>
        <PinDots length={pin.length} error={Boolean(error)} />
      </div>
      {error ? <p className="pn-mobile-error">{error}</p> : null}
      <div className="pn-mobile-bottom">
        <Keypad onDigit={addDigit} onDelete={deleteDigit} />
        {bottomAction === 'Start over' ? (
          <button type="button" className="pn-btn-text pn-bottom-link" onClick={() => {
            setStage('new');
            setFirstPin('');
            setPin('');
            setError(null);
          }}>
            Start over
          </button>
        ) : bottomAction === 'PIN options' ? (
          <button type="button" className="pn-btn-text pn-bottom-link" onClick={() => setOptionsOpen(true)}>
            PIN options
          </button>
        ) : null}
      </div>
      {optionsOpen ? (
        <div className="pn-sheet-layer" role="presentation">
          <div className="pn-sheet-backdrop" onClick={() => setOptionsOpen(false)} />
          <div className="pn-sheet" role="dialog" aria-modal="true" aria-label="PIN options">
            <div className="pn-sheet-grabber" />
            <h2 className="pn-sheet-title">PIN options</h2>
            <div className="pn-group">
              {biometrics?.available ? (
                <div className="pn-row">
                  <span>Unlock with biometrics</span>
                  <button
                    type="button"
                    className={`pn-switch${wantsBiometrics ? ' on' : ''}`}
                    role="switch"
                    aria-checked={wantsBiometrics}
                    aria-label="Unlock with biometrics"
                    onClick={() => setWantsBiometrics((value) => !value)}
                  >
                    <i />
                  </button>
                </div>
              ) : null}
            </div>
            <button type="button" className="pn-btn pn-btn-primary" onClick={() => setOptionsOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- lock */

function ForgotSheet({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored: () => void;
}) {
  const app = useApp();
  const [confirmErase, setConfirmErase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const file = await pickTextFile('.json,application/json');
      if (!file) return;
      const parsed = JSON.parse(file.text) as { format?: string };
      if (parsed.format === 'deurge-encrypted-backup') {
        setError('This is an encrypted backup. Use a plain JSON backup to restore while locked.');
        return;
      }
      await app.core.backup.importJson(file.text, { mode: 'replace', confirmReplace: true });
      await app.core.security.clearPassword();
      onRestored();
    } catch (failure) {
      setError(isDeUrgeError(failure) ? userMessage(failure) : 'That backup could not be restored.');
    } finally {
      setBusy(false);
    }
  }

  async function erase(): Promise<void> {
    setBusy(true);
    try {
      await app.core.security.wipeAllData();
      window.location.reload();
    } catch {
      setError('The app could not be reset. Close deUrge and try again.');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="pn-sheet-layer" role="presentation">
        <div className="pn-sheet-backdrop" onClick={onClose} />
        <div className="pn-sheet" role="dialog" aria-modal="true" aria-labelledby="pn-forgot-title">
          <div className="pn-sheet-grabber" />
          <h2 className="pn-sheet-title" id="pn-forgot-title">Forgot your PIN?</h2>
          <p className="pn-muted pn-sheet-copy">
            deUrge has no account, so nobody can reset your PIN for you. That is what keeps your data private. You have two
            options.
          </p>
          <div className="pn-group">
            <button type="button" className="pn-row pn-row-block" onClick={() => void restore()} disabled={busy}>
              <span className="pn-row-strong">Restore from a backup</span>
              <span className="pn-muted">Replace this device's data with a backup file you exported.</span>
            </button>
            <button type="button" className="pn-row pn-row-block" onClick={() => setConfirmErase(true)} disabled={busy}>
              <span className="pn-row-strong pn-danger">Erase and start over</span>
              <span className="pn-muted">Deletes every tracker and entry on this device. This can't be undone.</span>
            </button>
          </div>
          {error ? <p className="pn-error">{error}</p> : null}
          <button type="button" className="pn-btn pn-btn-primary" onClick={onClose} disabled={busy}>
            Keep Trying
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmErase}
        title="Erase everything?"
        body={<p>Every tracker, lapse, urge, journal entry and setting on this device will be deleted. This cannot be undone.</p>}
        confirmLabel="Erase and reset"
        tone="danger"
        onCancel={() => setConfirmErase(false)}
        onConfirm={() => void erase()}
      />
    </>
  );
}

function MobileLock({ onUnlock }: { onUnlock: () => void }) {
  const app = useApp();
  const config = app.core.security.config();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorFlash, setErrorFlash] = useState(false);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [availability, setAvailability] = useState<BiometricAvailability | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const autoPrompted = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void biometricsAvailable().then((result) => {
      if (cancelled) return;
      setAvailability(result);
      if (config.biometricsEnabled && result.available && !autoPrompted.current) {
        autoPrompted.current = true;
        window.setTimeout(() => {
          void (async () => {
            const biometric = await authenticateBiometrics();
            if (biometric.success) onUnlock();
          })();
        }, 250);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [cooldownUntil]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  async function verify(entered: string): Promise<void> {
    if (cooldown > 0 || busy) return;
    setBusy(true);
    if (await app.core.security.verifyPassword(entered)) {
      window.setTimeout(onUnlock, 150);
      return;
    }
    haptic('error');
    const nextAttempts = attempts + 1;
    setAttempts(nextAttempts);
    setError(null);
    setErrorFlash(true);
    setShake((count) => count + 1);
    window.setTimeout(() => {
      setPin('');
      setErrorFlash(false);
      setBusy(false);
      if (nextAttempts >= MAX_ATTEMPTS) {
        setCooldownUntil(Date.now() + COOLDOWN_MS);
        setNow(Date.now());
        setError('Too many attempts. Wait 30 seconds.');
      } else {
        setError(`Incorrect PIN. ${MAX_ATTEMPTS - nextAttempts} attempts left.`);
      }
    }, 500);
  }

  function addDigit(digit: string): void {
    if (cooldown > 0 || busy || pin.length >= PIN_LENGTH) return;
    setError(null);
    const next = pin + digit;
    setPin(next);
    if (next.length === PIN_LENGTH) {
      timer.current = window.setTimeout(() => void verify(next), 160);
    }
  }

  function deleteDigit(): void {
    setPin((current) => current.slice(0, -1));
    setError(null);
  }

  usePinKeyboard(addDigit, deleteDigit, !forgotOpen && !busy);

  async function handleBiometrics(): Promise<void> {
    const result = await authenticateBiometrics();
    if (result.success) onUnlock();
  }

  return (
    <div className="pin-ui pn-screen">
      <div className="pn-lock-head">
        <DeUrgeMark size={44} />
        <h1 className="pn-big pn-lock-title">Enter PIN</h1>
        {error ? <p className="pn-error pn-lock-error">{error}</p> : <p className="pn-muted">deUrge is locked</p>}
        <div className="pn-lock-dots">
          <PinDots length={pin.length} error={errorFlash} shake={shake} />
        </div>
      </div>
      <div className="pn-mobile-bottom">
        <Keypad
          onDigit={addDigit}
          onDelete={deleteDigit}
          locked={cooldown > 0}
          onBiometrics={config.biometricsEnabled && availability?.available ? () => void handleBiometrics() : undefined}
        />
        <button type="button" className="pn-btn-text pn-bottom-link" onClick={() => setForgotOpen(true)}>
          Forgot PIN?
        </button>
      </div>
      {forgotOpen ? (
        <ForgotSheet onClose={() => setForgotOpen(false)} onRestored={() => window.location.reload()} />
      ) : null}
    </div>
  );

}

function DesktopPinBoxes({
  value,
  active,
  onFocus,
  shake = 0,
}: {
  value: string;
  active: boolean;
  onFocus: () => void;
  shake?: number;
}) {
  return (
    <div
      key={shake}
      className={`pn-boxes${shake > 0 ? ' shake' : ''}`}
      role="group"
      aria-label={`PIN, ${value.length} of ${PIN_LENGTH} digits entered`}
      onClick={onFocus}
    >
      {Array.from({ length: PIN_LENGTH }, (_, index) => (
        <span key={index} className={`pn-box${index < value.length ? ' filled' : ''}${active && index === Math.min(value.length, PIN_LENGTH - 1) ? ' active' : ''}`}>
          {index < value.length ? <i /> : null}
        </span>
      ))}
    </div>
  );
}

function DesktopLock({ onUnlock }: { onUnlock: () => void }) {
  const app = useApp();
  const config = app.core.security.config();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [availability, setAvailability] = useState<BiometricAvailability | null>(null);
  const [focused, setFocused] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoPrompted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void biometricsAvailable().then((result) => {
      if (cancelled) return;
      setAvailability(result);
      if (config.biometricsEnabled && result.available && !autoPrompted.current) {
        autoPrompted.current = true;
        window.setTimeout(() => {
          void (async () => {
            const biometric = await authenticateBiometrics();
            if (biometric.success) onUnlock();
          })();
        }, 250);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function unlock(): Promise<void> {
    if (busy || pin.length < PIN_LENGTH) return;
    setBusy(true);
    if (await app.core.security.verifyPassword(pin)) {
      window.setTimeout(onUnlock, 150);
      return;
    }
    haptic('error');
    setShake((count) => count + 1);
    window.setTimeout(() => {
      setPin('');
      setError('Incorrect PIN. Try again.');
      setBusy(false);
      inputRef.current?.focus();
    }, 500);
  }

  async function biometrics(): Promise<void> {
    const result = await authenticateBiometrics();
    if (result.success) onUnlock();
    else setError(result.error ?? 'Biometric authentication failed.');
  }

  return (
    <div className="pin-ui pn-desktop-stage">
      <div className="pn-desktop-lock">
        <DeUrgeMark size={52} />
        <h1 className="pn-big pn-desktop-title">deUrge is locked</h1>
        <p className="pn-muted">Type your PIN to unlock.</p>
        <DesktopPinBoxes value={pin} active={focused} shake={shake} onFocus={() => inputRef.current?.focus()} />
        <input
          ref={inputRef}
          className="pn-hidden-input"
          type="password"
          inputMode="numeric"
          value={pin}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setError(null);
            setPin(event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void unlock();
          }}
          aria-label="Enter PIN"
          autoComplete="off"
        />
        {error ? <p className="pn-error pn-desktop-error">{error}</p> : null}
        <button type="button" className="pn-btn pn-btn-primary pn-desktop-btn" onClick={() => void unlock()}>
          Unlock
        </button>
        {availability?.available && config.biometricsEnabled ? (
          <button type="button" className="pn-btn pn-btn-secondary pn-desktop-btn" onClick={() => void biometrics()}>
            <BiometricsIcon size={20} /> Use biometrics
          </button>
        ) : null}
        <button type="button" className="pn-btn-text pn-desktop-forgot" onClick={() => setForgotOpen(true)}>
          Forgot PIN?
        </button>
      </div>
      {forgotOpen ? (
        <ForgotSheet onClose={() => setForgotOpen(false)} onRestored={() => window.location.reload()} />
      ) : null}
    </div>
  );
}

function DesktopSetPin({
  mode,
  onDone,
  onCancel,
}: {
  mode: 'create' | 'change';
  onDone: () => void;
  onCancel?: () => void;
}) {
  const app = useApp();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [activeField, setActiveField] = useState<'pin' | 'confirm'>('pin');
  const [error, setError] = useState<string | null>(null);
  const [wantsBiometrics, setWantsBiometrics] = useState(false);
  const [availability, setAvailability] = useState<BiometricAvailability | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void biometricsAvailable().then((result) => {
      if (!cancelled) setAvailability(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeField]);

  const value = activeField === 'pin' ? pin : confirmPin;
  const setValue = activeField === 'pin' ? setPin : setConfirmPin;

  function onInput(next: string): void {
    const clean = next.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setValue(clean);
    setError(null);
    if (clean.length === PIN_LENGTH) {
      if (activeField === 'pin') setActiveField('confirm');
      else inputRef.current?.blur();
    }
  }

  async function save(): Promise<void> {
    setError(null);
    if (pin.length !== PIN_LENGTH || confirmPin.length !== PIN_LENGTH) {
      setError('Enter all 4 digits in both fields.');
      return;
    }
    if (pin !== confirmPin) {
      setError('PINs did not match.');
      setConfirmPin('');
      setActiveField('confirm');
      return;
    }
    setSaving(true);
    try {
      if (wantsBiometrics && availability?.available) {
        const result = await authenticateBiometrics();
        if (!result.success) {
          setError(result.error ?? 'Biometric authentication failed.');
          return;
        }
      }
      await app.core.security.setPassword(pin, {
        biometricsEnabled: wantsBiometrics && availability?.available === true,
      });
      onDone();
    } catch (failure) {
      setError(isDeUrgeError(failure) ? userMessage(failure) : 'The PIN could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pin-ui pn-desktop-stage">
      <div className="pn-desktop-card">
        <aside className="pn-desktop-side">
          <DeUrgeMark size={44} />
          <div className="pn-desktop-wordmark">
            <span>de</span>
            <b>Urge</b>
          </div>
          <div className="pn-side-text">
            <b>Why a PIN?</b>
            <p>It locks the app when you step away.</p>
            <b>Where it lives</b>
            <p>Only as a salted hash in your device's secure storage. deUrge cannot read or recover it.</p>
            <b>If you forget it</b>
            <p>Restore from a backup or erase this device. Keep a backup.</p>
          </div>
        </aside>
        <section className="pn-desktop-main">
          <div className="pn-lb">Security</div>
          <h1 className="pn-big pn-desktop-set-title">{mode === 'change' ? 'Change PIN' : 'Set a PIN'}</h1>
          <div className="pn-lb pn-box-label">New PIN</div>
          <DesktopPinBoxes
            value={pin}
            active={activeField === 'pin'}
            onFocus={() => {
              setActiveField('pin');
              inputRef.current?.focus();
            }}
          />
          <div className="pn-lb pn-box-label">Confirm PIN</div>
          <DesktopPinBoxes
            value={confirmPin}
            active={activeField === 'confirm'}
            onFocus={() => {
              setActiveField('confirm');
              inputRef.current?.focus();
            }}
          />
          <input
            ref={inputRef}
            className="pn-hidden-input"
            type="password"
            inputMode="numeric"
            value={value}
            onChange={(event) => onInput(event.target.value)}
            aria-label={activeField === 'pin' ? 'New PIN' : 'Confirm PIN'}
            autoComplete="off"
          />
          {error ? <p className="pn-error">{error}</p> : null}
          {availability?.available ? (
            <div className="pn-group pn-desktop-options">
              <div className="pn-row">
                <span>Unlock with biometrics</span>
                <button
                  type="button"
                  className={`pn-switch${wantsBiometrics ? ' on' : ''}`}
                  role="switch"
                  aria-checked={wantsBiometrics}
                  aria-label="Unlock with biometrics"
                  onClick={() => setWantsBiometrics((current) => !current)}
                >
                  <i />
                </button>
              </div>
            </div>
          ) : null}
          <div className="pn-desktop-footer">
            {onCancel ? (
              <button type="button" className="pn-btn-text" onClick={onCancel}>
                Cancel
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="pn-btn pn-btn-primary pn-set-btn" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Set PIN'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

export function SetPinScreen({
  mode = 'create',
  onDone,
  onCancel,
  overlay = false,
}: {
  mode?: 'create' | 'change';
  onDone: () => void;
  onCancel?: () => void;
  overlay?: boolean;
}) {
  const desktop = useMediaQuery('(min-width: 980px)');
  if (desktop) {
    return (
      <div className={overlay ? 'pn-overlay-wrap' : ''}>
        <DesktopSetPin mode={mode} onDone={onDone} onCancel={onCancel} />
      </div>
    );
  }
  return <MobileCreateOrConfirm mode={mode} onDone={onDone} onCancel={onCancel} overlay={overlay} />;
}

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const desktop = useMediaQuery('(min-width: 980px)');
  if (desktop) return <DesktopLock onUnlock={onUnlock} />;
  return <MobileLock onUnlock={onUnlock} />;
}
