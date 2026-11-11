/**
 * Tyag onboarding, implemented 1:1 from the supplied onboarding kit
 * (`tyag-onboarding/light|dark/01-welcome … 05-ready` and `06-desktop`):
 * same copy, hierarchy, chips, grouped rows, dots and desktop step shell.
 * Behaviour is wired to the real core services (create tracker, local
 * reminder preference, restore from backup, open the app).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ENCRYPTED_BACKUP_FORMAT,
  isTyagError,
  userMessage,
  type Tracker,
} from '@tyag/core';
import { navigate } from '../../router';
import { useApp } from '../../store/app';
import { Button, Sheet, useToast } from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { useBackHandler } from '../../platform/back';
import { Keypad, PinDots } from '../lock/AppLock';
import { TyagAppIcon, TyagMark, TyagWordmark } from '../../ui/logo';
import { pickTextFile } from '../../platform/files';
import {
  notificationAvailability,
  requestNotificationPermission,
} from '../../platform/notifications';
import './onboarding.css';

type Step = 0 | 1 | 2 | 3 | 4 | 5; // welcome, privacy, tracker, reminders, PIN, ready

/**
 * A broad, plain-language list of addictions and compulsive behaviours. Every
 * entry is a distinct behaviour or substance, no synonyms, no narrower
 * duplicates of another entry. They only appear as search suggestions
 * while the person is typing (the onboarding board has no default pill row).
 */
const SUGGESTIONS = [
  'Alcohol',
  'Binge eating',
  'Caffeine',
  'Compulsive exercise',
  'Compulsive lying',
  'Compulsive shopping',
  'Compulsive stealing',
  'Compulsive trading',
  'Doomscrolling',
  'Drugs',
  'Gambling',
  'Gaming',
  'Hair pulling',
  'Masturbation',
  'Nail biting',
  'Nicotine or vaping',
  'Pornography',
  'Skin picking',
  'Social media',
  'Streaming',
  'Sugar',
  'Workaholism',
] as const;

/** Always-visible starting points under the name field. */
const QUICK_PICKS = [
  'Social media',
  'Hair pulling',
  'Drinking',
  'Pornography',
  'Gaming',
  'Gambling',
  'Drugs',
  'Masturbation',
  'Doomscrolling',
  'Binge eating',
] as const;
const REMINDER_OPTIONS: { value: number; label: string }[] = [
  { value: 60, label: 'Hourly' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Daily' },
];
const TRACKER_FORM_ID = 'onb-first-tracker';

function Dots({ active }: { active: number }) {
  return (
    <div className="onb-dots" role="img" aria-label={`Step ${active + 1} of 3`}>
      {Array.from({ length: 3 }, (_, index) => (
        <i key={index} className={index === active ? 'on' : ''} aria-hidden="true" />
      ))}
    </div>
  );
}

function Chevron() {
  return (
    <svg width="8" height="13" viewBox="0 0 8 13" strokeWidth="2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 1.5l5 5-5 5" />
    </svg>
  );
}

function BackChevron() {
  return (
    <svg width="10" height="17" viewBox="0 0 8 13" strokeWidth="2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 1.5l-5 5 5 5" />
    </svg>
  );
}

function Feature({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="onb-feature">
      <div className="onb-feature-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="1.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {icon}
        </svg>
      </div>
      <div>
        <div className="onb-feature-title">{title}</div>
        <div className="onb-feature-body">{body}</div>
      </div>
    </div>
  );
}

/**
 * iOS inset grouped search-results table for the tracker-name field. The rows
 * are plain buttons with a muted magnifier glyph and an inset separator drawn
 * on the container, exactly like a grouped table in iOS. Native mouse-down is
 * prevented so tapping a row never blurs (and therefore never closes) the
 * search field before the click is handled.
 */
function SuggestionList({
  id,
  suggestions,
  onSelect,
  mobile = false,
}: {
  id: string;
  suggestions: readonly string[];
  onSelect: (suggestion: string) => void;
  mobile?: boolean;
}) {
  return (
    <ul id={id} className={`onb-suggestions${mobile ? ' onb-suggestions-mobile' : ''}`} aria-label="Suggestions">
      {suggestions.map((suggestion) => (
        <li key={suggestion}>
          <button
            type="button"
            aria-label={`Use “${suggestion}”`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(suggestion)}
          >
            <span className="onb-suggestion-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-4.3-4.3" />
              </svg>
            </span>
            {suggestion}
          </button>
        </li>
      ))}
    </ul>
  );
}

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 980px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(min-width: 980px)');
    const listener = () => setDesktop(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);
  return desktop;
}

function minutesSeconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/* Local wall time <-> UTC epoch, in the effective timezone. */
function toLocalInput(epochMs: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function fromLocalInput(input: string, timeZone: string): number | null {
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const guess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return guess + (guess - asUtc);
}

export function OnboardingScreen({ onComplete }: { onComplete: () => void }) {
  const app = useApp();
  const fmt = useFormatters();
  const toast = useToast();
  const isDesktop = useIsDesktop();

  const [step, setStep] = useState<Step>(0);
  const [stepMotion, setStepMotion] = useState<'' | 'push' | 'pop'>('');
  const previousStep = useRef<Step>(0);
  useEffect(() => {
    if (step === previousStep.current) return;
    setStepMotion(step > previousStep.current ? 'push' : 'pop');
    previousStep.current = step;
    const timer = window.setTimeout(() => setStepMotion(''), 520);
    return () => window.clearTimeout(timer);
  }, [step]);
  const [name, setName] = useState('');
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [showWhen, setShowWhen] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [remindersOn, setRemindersOn] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [created, setCreated] = useState<Tracker | null>(null);
  const [pinStage, setPinStage] = useState<'create' | 'confirm'>('create');
  const [pinValue, setPinValue] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinShake, setPinShake] = useState(0);
  const [pinSaving, setPinSaving] = useState(false);
  const [desktopPin, setDesktopPin] = useState('');
  const [desktopConfirm, setDesktopConfirm] = useState('');
  const [desktopField, setDesktopField] = useState<'pin' | 'confirm'>('pin');
  const desktopPinRef = useRef<HTMLInputElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreKind, setRestoreKind] = useState<'json' | 'encrypted'>('json');
  const [restoreText, setRestoreText] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // A hardware/browser back press walks the steps exactly like the on-screen
  // Back buttons. Step 0 stays unhandled on purpose, on Android the native
  // shell may then close the app, which is the expected behaviour on the very
  // first screen. While a write is in flight, and on the final "ready" step,
  // the press is consumed so the user cannot slip back into a half-finished
  // flow (the tracker/PIN already exist by then).
  useBackHandler(() => {
    if (saving || pinSaving) return true;
    if (step === 0) return false;
    if (step === 5) return true;
    if (step === 4) {
      if (isDesktop) setStep(3);
      else backFromPin();
      return true;
    }
    setStep((current) => (current > 1 ? ((current - 1) as Step) : 0));
    return true;
  }, step > 0);

  const progressIndex = step === 1 ? 0 : step === 2 ? 1 : step === 3 ? 2 : step === 4 ? 3 : 0;
  useEffect(() => {
    if (step !== 4 || !isDesktop) return undefined;
    const timer = window.setTimeout(() => desktopPinRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [step, isDesktop, desktopField]);

  const nameQuery = name.trim().toLowerCase();
  const suggestionMatches =
    suggestionsOpen && nameQuery.length > 0
      ? [...SUGGESTIONS]
          .filter(
            (suggestion) => suggestion.toLowerCase().includes(nameQuery) && suggestion.toLowerCase() !== nameQuery,
          )
          .sort((a, b) => a.localeCompare(b))
      : [];
  // Whatever the user typed is always offered as the last option, so a
  // behaviour that is not in the list can still be used verbatim.
  const typedSuggestion = suggestionsOpen ? name.trim() : '';
  const typedIsShown = suggestionMatches.some((suggestion) => suggestion.toLowerCase() === typedSuggestion.toLowerCase());
  const matchingSuggestions = typedSuggestion && !typedIsShown
    ? [...suggestionMatches.slice(0, 7), typedSuggestion]
    : suggestionMatches.slice(0, 8);
  const whenLabel = useMemo(() => {
    const isToday = new Date(startedAt).toDateString() === new Date(app.now).toDateString();
    const time = fmt.time(startedAt);
    if (Math.abs(startedAt - app.now) < 60_000 && isToday) return `Now, ${time}`;
    if (isToday) return `Today, ${time}`;
    return `${fmt.dateCompact(startedAt)}, ${time}`;
  }, [startedAt, app.now, fmt]);

  const chooseSuggestion = useCallback((suggestion: string) => {
    setName(suggestion);
    setSuggestionsOpen(false);
    setError(null);
  }, []);

  const clearName = useCallback(() => {
    setName('');
    setSuggestionsOpen(false);
    setError(null);
    nameInputRef.current?.focus();
  }, []);

  const closeSuggestionsOnEscape = useCallback((event: { key: string }) => {
    if (event.key === 'Escape') setSuggestionsOpen(false);
  }, []);

  const finish = useCallback(async () => {
    try {
      await app.updateSettings({ onboarded: true });
    } catch {
      /* never trap the user in onboarding if a settings write fails */
    }
    onComplete();
    navigate(created ? `/tracker/${created.id}` : '/trackers');
  }, [app, created, onComplete]);

  async function startTracking(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name, or choose a suggestion.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tracker = await app.core.trackers.create({
        name: trimmed,
        startedAt,
      });
      setCreated(tracker);
      setStep(3);
      app.refresh();
    } catch (writeError) {
      setError(isTyagError(writeError) ? writeError.message : userMessage(writeError));
    } finally {
      setSaving(false);
    }
  }

  async function continueReminders(enable: boolean): Promise<void> {
    let enabled = enable;
    if (enable) {
      if (notificationAvailability() === 'unsupported') {
        enabled = false;
        toast.show('This platform does not support local notifications. Tyag works without them.');
      } else if (!(await requestNotificationPermission())) {
        enabled = false;
        toast.show('Notifications were not allowed. You can enable them later in Settings.');
      }
    }
    try {
      await app.updateSettings({ notificationsEnabled: enabled, notificationIntervalMinutes: intervalMinutes });
    } catch {
      toast.error('Could not save the reminder preference. You can change it in Settings.');
    }
    app.refresh();
    setStep(4);
  }

  function pinDigit(digit: string): void {
    if (pinSaving || pinValue.length >= 4) return;
    setPinError(null);
    const next = pinValue + digit;
    setPinValue(next);
    if (next.length === 4) window.setTimeout(() => void completePin(next), 120);
  }

  function pinDelete(): void {
    if (pinSaving) return;
    setPinValue((current) => current.slice(0, -1));
    setPinError(null);
  }

  async function completePin(pin: string): Promise<void> {
    if (pinSaving) return;
    setPinSaving(true);
    try {
      if (pinStage === 'create') {
        setFirstPin(pin);
        setPinStage('confirm');
        setPinValue('');
      } else if (pin !== firstPin) {
        setPinStage('create');
        setFirstPin('');
        setPinValue('');
        setPinError('PINs did not match. Try again.');
        setPinShake((count) => count + 1);
      } else {
        await app.core.security.setPassword(pin, { biometricsEnabled: app.core.security.biometricsEnabled() });
        setStep(5);
      }
    } catch (failure) {
      setPinError(isTyagError(failure) ? userMessage(failure) : 'The PIN could not be saved.');
      setPinValue('');
    } finally {
      setPinSaving(false);
    }
  }

  async function saveDesktopPin(): Promise<void> {
    if (pinSaving) return;
    if (desktopPin.length !== 4 || desktopConfirm.length !== 4) {
      setPinError('Enter all 4 digits in both fields.');
      return;
    }
    if (desktopPin !== desktopConfirm) {
      setPinError('PINs did not match. Try again.');
      setDesktopConfirm('');
      setDesktopField('confirm');
      desktopPinRef.current?.focus();
      return;
    }
    setPinSaving(true);
    try {
      await app.core.security.setPassword(desktopPin, { biometricsEnabled: app.core.security.biometricsEnabled() });
      setStep(5);
    } catch (failure) {
      setPinError(isTyagError(failure) ? userMessage(failure) : 'The PIN could not be saved.');
    } finally {
      setPinSaving(false);
    }
  }

  function backFromPin(): void {
    if (pinStage === 'confirm') {
      setPinStage('create');
      setFirstPin('');
      setPinValue('');
      setPinError(null);
      return;
    }
    setStep(3);
  }

  async function chooseRestoreFile(): Promise<void> {
    setRestoreError(null);
    const file = await pickTextFile('.json,application/json');
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(file.text);
      const encrypted =
        Boolean(parsed) &&
        typeof parsed === 'object' &&
        (parsed as { format?: string }).format === ENCRYPTED_BACKUP_FORMAT;
      setRestoreKind(encrypted ? 'encrypted' : 'json');
      setRestoreText(file.text);
      setRestorePassword('');
      setRestoreOpen(true);
    } catch {
      setRestoreError('That file is not valid JSON.');
      toast.error('That file is not valid JSON.');
    }
  }

  async function runRestore(): Promise<void> {
    if (restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      if (restoreKind === 'encrypted') {
        if (!restorePassword) {
          setRestoreError('Enter the password for this encrypted backup.');
          return;
        }
        await app.core.backup.importEncrypted(restoreText, restorePassword, { mode: 'merge' });
      } else {
        await app.core.backup.importJson(restoreText, { mode: 'merge' });
      }
      app.refresh();
      setRestoreOpen(false);
      toast.show('Backup restored on this device.');
      await finish();
    } catch (restoreFailure) {
      setRestoreError(userMessage(restoreFailure));
    } finally {
      setRestoring(false);
    }
  }

  /* ------------------------------ shared content ------------------------ */

  const privacyList = (
    <div className="onb-feature-list">
      <Feature
        icon={<><rect x="6" y="11" width="12" height="9" rx="2" /><path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11" /></>}
        title="Stays on this device"
        body="Your data stays on this device."
      />
      <Feature
        icon={<><circle cx="12" cy="12" r="8" /><path d="M6.3 17.7L17.7 6.3" /></>}
        title="No account needed"
        body="No sign-up, ads or tracking."
      />
      <Feature icon={<path d="M3 11.5l18-7-7 18-2.5-7.5z" />} title="Works offline" body="Works without internet." />
      <Feature icon={<path d="M12 4v10M8 10l4 4 4-4M5 19h14" />} title="Export anytime" body="Back up or move to a new device." />
    </div>
  );

  const trackerFields = (
    <>
      <h1 className="onb-title onb-title-form">Name of addiction</h1>
      <div className="onb-name-anchor">
        <div className="onb-group">
          <div className="onb-row onb-name-row">
          <input
            ref={nameInputRef}
            className="onb-inline-input"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
              setSuggestionsOpen(true);
            }}
            onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
            onKeyDown={closeSuggestionsOnEscape}
            aria-label="Tracker name"
            placeholder="Enter the name"
            autoFocus
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={matchingSuggestions.length > 0}
            aria-controls={matchingSuggestions.length > 0 ? 'onb-name-suggestions' : undefined}
          />
          {name.length > 0 ? (
            <button
              type="button"
              className="onb-clear"
              aria-label="Clear tracker name"
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearName}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" fill="currentColor" />
                <path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8" stroke="var(--card)" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
          </div>
        </div>
        {matchingSuggestions.length > 0 ? (
          <SuggestionList
            id="onb-name-suggestions"
            suggestions={matchingSuggestions}
            onSelect={chooseSuggestion}
            mobile
          />
        ) : null}
      </div>
      <div className="onb-chips" aria-label="Suggestions">
        {QUICK_PICKS.map((pick) => (
          <button key={pick} type="button" className={`onb-chip ${name === pick ? 'on' : ''}`} onClick={() => chooseSuggestion(pick)}>
            {pick}
          </button>
        ))}
      </div>
      {error ? <p className="onb-error" role="alert">{error}</p> : null}

      <div className="onb-label">Start date</div>
      <div className="onb-group">
        <button type="button" className="onb-row onb-row-button" onClick={() => setShowWhen((value) => !value)} aria-expanded={showWhen}>
          <span>Started</span>
          <span className="onb-muted onb-row-value">{whenLabel}</span>
        </button>
        {showWhen ? (
          <div className="onb-row">
            <input
              className="onb-inline-input"
              type="datetime-local"
              value={toLocalInput(startedAt, app.timeZone)}
              max={toLocalInput(app.now, app.timeZone)}
              onChange={(event) => {
                const next = fromLocalInput(event.target.value, app.timeZone);
                if (next !== null) setStartedAt(next);
              }}
              aria-label="Start date and time"
            />
          </div>
        ) : null}
      </div>
      <p className="onb-footnote">Pick a past date if you already started. Time is tracked to the minute.</p>

    </>
  );

  const remindersContent = (
    <>
      <h1 className="onb-title">Reminders (optional)</h1>
      <p className="onb-muted onb-subtitle onb-subtitle-wide">
        Get a private reminder on this device. You can change this later.
      </p>
      <div className="onb-label onb-label-flush">Preview</div>
      <div className="onb-preview">
        <div className="onb-preview-mark"><TyagMark size={22} /></div>
        <div className="onb-preview-body">
          <div className="onb-preview-head">
            <b>Tyag</b>
            <span className="onb-muted">now</span>
          </div>
          <p>You have stayed away from social media for 3 days, 4 hours. Your progress continues.</p>
        </div>
      </div>
      <div className="onb-group onb-group-spaced">
        <button
          type="button"
          className="onb-row onb-row-button"
          role="switch"
          aria-checked={remindersOn}
          aria-label="Progress notes"
          onClick={() => setRemindersOn((value) => !value)}
        >
          <span>Progress reminders</span>
          <span className={`onb-switch ${remindersOn ? 'on' : ''}`} aria-hidden="true" />
        </button>
        <label className="onb-row onb-row-button">
          <span className="onb-muted">How often</span>
          <span className="onb-muted onb-row-value">
            {REMINDER_OPTIONS.find((option) => option.value === intervalMinutes)?.label ?? 'Daily'} <Chevron />
          </span>
          <select
            className="onb-select-overlay"
            value={String(intervalMinutes)}
            onChange={(event) => setIntervalMinutes(Number(event.target.value))}
            aria-label="How often"
            disabled={!remindersOn}
          >
            {REMINDER_OPTIONS.map((option) => (
              <option key={option.value} value={String(option.value)}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="onb-footnote">Off by default. No servers, no accounts.</p>
    </>
  );

  /* --------------------------------- welcome ---------------------------- */

  const welcome = (
    <div className="onb-screen onb-welcome">
      <div className="onb-welcome-center onb-welcome-stagger">
        <TyagAppIcon size={96} />
        <TyagWordmark height={44} className="onb-welcome-wordmark" />
        <p className="onb-muted onb-welcome-tagline">
          Track recovery from addictions. Private, local-first, and always on this device.
        </p>
      </div>
      <div className="onb-welcome-actions onb-welcome-actions-stagger">
        <Button variant="primary" block onClick={() => setStep(1)}>Get Started</Button>
        <button type="button" className="onb-text-btn onb-center" onClick={() => void chooseRestoreFile()}>
          Restore from Backup
        </button>
      </div>
    </div>
  );

  /* ---------------------------------- ready ----------------------------- */

  const ready = created ? (
    <div className="onb-screen onb-ready">
      <div className="onb-ready-center">
        <span className="onb-chip onb-chip-status"><i className="onb-dot" aria-hidden="true" /> Tracking started</span>
        <div className="onb-ready-time">{minutesSeconds(app.core.metrics(created.id).currentStreakMs)}</div>
        <div className="onb-muted onb-ready-name">{created.name}</div>
        <p className="onb-ready-message">Your progress starts now.</p>
      </div>
      <p className="onb-footnote onb-ready-note">
        If you lapse, record it. Your earlier progress stays in your history.
      </p>
      <Button variant="primary" block onClick={() => void finish()}>Open Tyag</Button>
    </div>
  ) : null;

  /* --------------------------- desktop tracker form --------------------- */

  const desktopTrackerForm = (
    <form id={TRACKER_FORM_ID} className="onb-form onb-form-desktop" onSubmit={(event) => void startTracking(event)} noValidate>
      <label className="onb-label" htmlFor="onb-name">Addiction name</label>
      <div className="onb-desktop-name-anchor">
        <input
          id="onb-name"
          className="onb-desktop-input"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
            setSuggestionsOpen(true);
          }}
          onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
          onKeyDown={closeSuggestionsOnEscape}
          aria-label="Tracker name"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={matchingSuggestions.length > 0}
          aria-controls={matchingSuggestions.length > 0 ? 'onb-name-suggestions-desktop' : undefined}
        />
        {matchingSuggestions.length > 0 ? (
          <SuggestionList
            id="onb-name-suggestions-desktop"
            suggestions={matchingSuggestions}
            onSelect={chooseSuggestion}
          />
        ) : null}
      </div>
      <div className="onb-chips" aria-label="Suggestions">
        {QUICK_PICKS.map((pick) => (
          <button key={pick} type="button" className={`onb-chip ${name === pick ? 'on' : ''}`} onClick={() => chooseSuggestion(pick)}>
            {pick}
          </button>
        ))}
      </div>
      <div className="onb-label">Start date</div>
      <button type="button" className="onb-desktop-select" onClick={() => setShowWhen((value) => !value)} aria-expanded={showWhen}>
        <span>{whenLabel}</span>
        <Chevron />
      </button>
      {showWhen ? (
        <input
          className="onb-desktop-input onb-desktop-when"
          type="datetime-local"
          value={toLocalInput(startedAt, app.timeZone)}
          max={toLocalInput(app.now, app.timeZone)}
          onChange={(event) => {
            const next = fromLocalInput(event.target.value, app.timeZone);
            if (next !== null) setStartedAt(next);
          }}
          aria-label="Start date and time"
        />
      ) : null}
      <p className="onb-desktop-hint">Pick a past date if you already started.</p>
      {error ? <p className="onb-error" role="alert">{error}</p> : null}
      <div className="onb-desktop-form-spacer" />
    </form>
  );

  const pinContent = (
    <div className="onb-pin-body">
      <h1 className="onb-title">{pinStage === 'create' ? 'Create a PIN' : 'Confirm your PIN'}</h1>
      <p className="onb-muted onb-subtitle">
        {pinStage === 'create' ? 'You will use this to open Tyag. It stays on this device.' : 'Enter the same PIN once more.'}
      </p>
      <PinDots length={pinValue.length} error={Boolean(pinError)} shake={pinShake} />
      {pinError ? <p className="onb-error onb-pin-error" role="alert">{pinError}</p> : null}
      <div className="onb-pin-keypad">
        <Keypad onDigit={pinDigit} onDelete={pinDelete} />
      </div>
    </div>
  );

  const pinNav = (
    <div className="onb-nav-row">
      <button type="button" className="onb-text-btn" onClick={backFromPin} disabled={pinSaving}>
        <BackChevron /> Back
      </button>
      <Button
        variant="primary"
        block
        onClick={() => void completePin(pinValue)}
        disabled={pinSaving || pinValue.length < 4}
      >
        {pinStage === 'create' ? 'Set PIN' : 'Confirm PIN'}
      </Button>
    </div>
  );

  /* ------------------------------ mobile layout ------------------------- */

  const mobile = (
    <div className="onb-app">
      {step === 0 ? <div key="welcome" className={stepMotion ? `onb-step-${stepMotion}` : ''}>{welcome}</div> : null}
      {step === 1 ? (
        <div key="privacy" className={`onb-step-layer ${stepMotion ? `onb-step-${stepMotion}` : ''}`}>
          <div className="onb-topbar">
            <button type="button" className="onb-text-btn" onClick={() => setStep(0)}>
              <BackChevron /> Back
            </button>
          </div>
          <div className="onb-scroll onb-scroll-privacy">
            <h1 className="onb-title">Your data stays here</h1>
            <p className="onb-muted onb-subtitle">No account. Everything is on this device.</p>
            {privacyList}
          </div>
          <div className="onb-footer">
            <Dots active={0} />
            <Button variant="primary" block onClick={() => setStep(2)}>Continue</Button>
          </div>
        </div>
      ) : null}
      {step === 2 ? (
        <div key="tracker" className={`onb-step-layer ${stepMotion ? `onb-step-${stepMotion}` : ''}`}>
          <div className="onb-topbar">
            <button type="button" className="onb-text-btn" onClick={() => setStep(1)} disabled={saving}>
              <BackChevron /> Back
            </button>
          </div>
          <div className="onb-scroll onb-scroll-form">
            <form id={TRACKER_FORM_ID} className="onb-form" onSubmit={(event) => void startTracking(event)} noValidate>
              {trackerFields}
            </form>
          </div>
          <div className="onb-footer">
            <Dots active={1} />
            <Button variant="primary" block type="submit" form={TRACKER_FORM_ID} disabled={saving}>
              {saving ? 'Starting…' : 'Start Tracking'}
            </Button>
          </div>
        </div>
      ) : null}
      {step === 3 ? (
        <div key="reminders" className={`onb-step-layer ${stepMotion ? `onb-step-${stepMotion}` : ''}`}>
          <div className="onb-topbar">
            <button type="button" className="onb-text-btn" onClick={() => setStep(2)}>
              <BackChevron /> Back
            </button>
          </div>
          <div className="onb-scroll onb-scroll-reminders">{remindersContent}</div>
          <div className="onb-footer">
            <Dots active={2} />
            <Button variant="primary" block onClick={() => void continueReminders(remindersOn)}>Continue</Button>
          </div>
        </div>
      ) : null}
      {step === 4 ? (
        <div key="pin" className={`onb-step-layer ${stepMotion ? `onb-step-${stepMotion}` : ''}`}>
          <div className="onb-topbar">
            <button type="button" className="onb-text-btn" onClick={backFromPin} disabled={pinSaving}>
              <BackChevron /> Back
            </button>
          </div>
          {pinContent}
          <div className="onb-footer">
            <Button
              variant="primary"
              block
              onClick={() => void completePin(pinValue)}
              disabled={pinSaving || pinValue.length < 4}
            >
              {pinStage === 'create' ? 'Set PIN' : 'Confirm PIN'}
            </Button>
          </div>
        </div>
      ) : null}
      {step === 5 ? <div key="ready" className={stepMotion ? `onb-step-${stepMotion}` : ''}>{ready}</div> : null}
    </div>
  );

  /* ----------------------------- desktop layout ------------------------- */

  const desktopSteps = [
    { label: 'Your data stays here', value: 1 as Step },
    { label: 'Name of addiction', value: 2 as Step },
    { label: 'Reminders', value: 3 as Step },
    { label: 'PIN', value: 4 as Step },
  ];
  const desktopRight =
    step === 0 ? (
      <div className="onb-desktop-welcome">
        <div className="onb-label onb-label-flush">Welcome</div>
        <h1 className="onb-title onb-desktop-welcome-title">Track your recovery privately</h1>
        <p className="onb-muted onb-subtitle">
          No account. Everything stays on this device.
        </p>
        <div className="onb-desktop-welcome-actions">
          <Button variant="primary" block onClick={() => setStep(1)}>
            Get Started
          </Button>
          <button type="button" className="onb-text-btn onb-center" onClick={() => void chooseRestoreFile()}>
            Restore from Backup
          </button>
        </div>
      </div>
    ) : step === 1 ? (
      <>
        <h1 className="onb-title">Your data stays here</h1>
        <p className="onb-muted onb-subtitle">No account. Everything is on this device.</p>
        {privacyList}
        <div className="onb-desktop-footer">
          <button type="button" className="onb-text-btn" onClick={() => setStep(0)}>
            <BackChevron /> Back
          </button>
          <Button variant="primary" onClick={() => setStep(2)}>Continue</Button>
        </div>
      </>
    ) : step === 2 ? (
      <>
        <h1 className="onb-title onb-title-form">Name of addiction</h1>
        {desktopTrackerForm}
        <div className="onb-desktop-footer">
          <button type="button" className="onb-text-btn" onClick={() => setStep(1)} disabled={saving}>
            <BackChevron /> Back
          </button>
          <Button variant="primary" type="submit" form={TRACKER_FORM_ID} disabled={saving}>
            {saving ? 'Starting…' : 'Start Tracking'}
          </Button>
        </div>
      </>
    ) : step === 3 ? (
      <>
        {remindersContent}
        <div className="onb-desktop-footer">
          <button type="button" className="onb-text-btn" onClick={() => setStep(2)}>
            <BackChevron /> Back
          </button>
          <Button variant="primary" onClick={() => void continueReminders(remindersOn)}>Continue</Button>
        </div>
      </>
    ) : (
      <div className="onb-desktop-pin-set">
        <div className="onb-label onb-label-flush">Security</div>
        <h1 className="onb-title onb-desktop-set-title">Set a PIN</h1>
        <div className="onb-label">New PIN</div>
        <div
          className="pn-boxes onb-desktop-pin-boxes"
          onClick={() => {
            setDesktopField('pin');
            desktopPinRef.current?.focus();
          }}
        >
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index} className={`pn-box${index < desktopPin.length ? ' filled' : ''}${desktopField === 'pin' && index === Math.min(desktopPin.length, 3) ? ' active' : ''}`}>
              {index < desktopPin.length ? <i /> : null}
            </span>
          ))}
        </div>
        <div className="onb-label">Confirm PIN</div>
        <div
          className="pn-boxes onb-desktop-pin-boxes"
          onClick={() => {
            setDesktopField('confirm');
            desktopPinRef.current?.focus();
          }}
        >
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index} className={`pn-box${index < desktopConfirm.length ? ' filled' : ''}${desktopField === 'confirm' && index === Math.min(desktopConfirm.length, 3) ? ' active' : ''}`}>
              {index < desktopConfirm.length ? <i /> : null}
            </span>
          ))}
        </div>
        <input
          ref={desktopPinRef}
          className="pn-hidden-input"
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={desktopField === 'pin' ? desktopPin : desktopConfirm}
          onChange={(event) => {
            const clean = event.target.value.replace(/\D/g, '').slice(0, 4);
            setPinError(null);
            if (desktopField === 'pin') {
              setDesktopPin(clean);
              if (clean.length === 4 && desktopConfirm.length === 0) setDesktopField('confirm');
            } else {
              setDesktopConfirm(clean);
            }
          }}
          aria-label={desktopField === 'pin' ? 'New PIN' : 'Confirm PIN'}
        />
        {pinError ? <p className="onb-error" role="alert">{pinError}</p> : null}
        <div className="onb-desktop-footer">
          <button type="button" className="onb-text-btn" onClick={() => setStep(3)}>
            <BackChevron /> Back
          </button>
          <Button variant="primary" onClick={() => void saveDesktopPin()} disabled={pinSaving || desktopPin.length < 4 || desktopConfirm.length < 4}>
            {pinSaving ? 'Saving…' : 'Set PIN'}
          </Button>
        </div>
      </div>
    );

  const desktopWelcome = (
    <div className="onb-desktop onb-desktop-welcome-shell">
      <div className="onb-desktop-welcome-card">
        <div className="onb-desktop-welcome-brand">
          <TyagAppIcon size={72} />
          <TyagWordmark height={26} />
        </div>
        <h1 className="onb-desktop-welcome-title">Track recovery from addictions</h1>
        <p className="onb-muted onb-desktop-welcome-subtitle">
          Private, local-first, and always on your device.
        </p>
        <div className="onb-desktop-welcome-actions">
          <Button variant="primary" block onClick={() => setStep(1)}>
            Get Started
          </Button>
          <button type="button" className="onb-text-btn onb-center" onClick={() => void chooseRestoreFile()}>
            Restore from Backup
          </button>
        </div>
      </div>
    </div>
  );

  const desktop =
    isDesktop && step <= 4 ? (
      step === 0 ? desktopWelcome : (
      <div className="onb-desktop">
        <div className="onb-desktop-card">
          <aside className="onb-desktop-side">
            <TyagAppIcon size={44} />
            <TyagWordmark height={22} className="onb-desktop-wordmark" />
            {desktopSteps.map((item, index) => {
              const done = step > item.value;
              const active = step === item.value;
              return (
                <div key={item.label} className={`onb-desktop-step ${active ? 'on' : ''}`}>
                  <span className={`onb-desktop-bullet ${done ? 'done' : active ? 'active' : ''}`}>
                    {done ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12.5l4.5 4.5L19 7" />
                      </svg>
                    ) : (
                      index + 1
                    )}
                  </span>
                  {item.label}
                </div>
              );
            })}
            <div className="onb-desktop-side-footer">
            </div>
          </aside>
          <div key={step} className={`onb-desktop-content onb-step-layer ${stepMotion ? `onb-step-${stepMotion}` : ''}`}>
            <div className="onb-label onb-label-flush">{`Step ${progressIndex + 1} of 4`}</div>
            {desktopRight}
          </div>
        </div>
      </div>
      )
    ) : null;

  return (
    <>
      {desktop ?? mobile}
      <Sheet
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title="Restore from backup"
      >
        <p className="onb-muted">
          {restoreKind === 'encrypted'
            ? 'This is an encrypted backup. Enter its password to merge it into this device.'
            : 'This is a JSON backup. It will be merged into this device; existing records are never overwritten.'}
        </p>
        {restoreKind === 'encrypted' ? (
          <input
            className="onb-inline-input onb-restore-password"
            type="password"
            value={restorePassword}
            onChange={(event) => setRestorePassword(event.target.value)}
            placeholder="Backup password"
            aria-label="Backup password"
            autoComplete="current-password"
          />
        ) : null}
        {restoreError ? <p className="onb-error" role="alert">{restoreError}</p> : null}
        <div className="onb-restore-primary">
          <Button variant="primary" block onClick={() => void runRestore()} disabled={restoring}>
            {restoring ? 'Restoring…' : 'Restore Backup'}
          </Button>
          <Button variant="plain" block onClick={() => setRestoreOpen(false)} disabled={restoring}>
            Cancel
          </Button>
        </div>
      </Sheet>
    </>
  );
}
