/**
 * Settings screen, grouped iOS-style preference lists.
 *
 * Every change persists immediately through `app.updateSettings` (or the core
 * trigger/reason category service) and re-renders without a reload. Errors are reported with
 * the core's user-safe messages. Nothing here talks to a server.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  REPOSITORY_URL,
  SCHEMA_VERSION,
  formatDate,
  formatUtcOffset,
  isTyagError,
  userMessage,
  utcOffsetMinutesAt,
  type AppSettings,
  type DateFormat,
} from '@tyag/core';
import { useApp } from '../../store/app';
import { TyagLockup } from '../../ui/logo';
import { navigate } from '../../router';
import {
  Button,
  ListGroup,
  ListRow,
  Segmented,
  Select,
  Toggle,
  useToast,
} from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { cancelNativeAcknowledgement, notificationAvailability, requestNotificationPermission } from '../../platform/notifications';
import { CategoriesSection } from './CategoriesSection';
import { authenticateBiometrics, biometricsAvailable, biometricsSupported } from '../../platform/biometrics';
import './settings.css';

const DATE_FORMATS: DateFormat[] = ['MMM d, yyyy', 'd MMM yyyy', 'MM/dd/yyyy', 'dd/MM/yyyy', 'yyyy-MM-dd'];

const FALLBACK_TIME_ZONES = [
  'UTC',
  'Asia/Dhaka',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Africa/Cairo',
  'Africa/Lagos',
];

const NOTIFICATION_INTERVALS: { value: number; label: string }[] = [
  { value: 60, label: 'Every hour' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Once a day' },
];

const STORAGE_INFO: Record<string, { label: string; note: string }> = {
  indexeddb: {
    label: 'This browser (IndexedDB)',
    note: 'The database is a snapshot stored in this browser profile on this device.',
  },
  localstorage: {
    label: 'This browser (limited local storage)',
    note: 'IndexedDB was blocked, so Tyag is using smaller local storage. Export a backup regularly.',
  },
  filesystem: {
    label: 'App-private storage on this device',
    note: 'The database snapshot is a file in the app’s own private storage on this device.',
  },
  desktop: {
    label: 'A local file on this computer',
    note: 'The desktop app keeps the database snapshot in its own app-data folder.',
  },
  memory: {
    label: 'Memory only, not saved',
    note: 'This environment blocks persistent storage. Your data will be lost when the app closes; export a backup now.',
  },
};

function SettingSection({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h2 className="settings-section-label" id={headingId}>
        {label}
      </h2>
      {children}
      {note ? <p className="setting-note">{note}</p> : null}
    </section>
  );
}

function SettingBlock({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-block">
      <div className="setting-block-label">{label}</div>
      {children}
      {hint ? <div className="setting-hint">{hint}</div> : null}
    </div>
  );
}

export function SettingsScreen() {
  const app = useApp();
  const toast = useToast();
  const fmt = useFormatters();
  const { settings, timeZone } = app;
  const [biometricAvailability, setBiometricAvailability] = useState<{ available: boolean; reason?: string } | null>(null);
  const [lockConfig, setLockConfig] = useState(() => app.core.security.config());

  useEffect(() => {
    let cancelled = false;
    if (!biometricsSupported()) return undefined;
    void biometricsAvailable().then((result) => {
      if (!cancelled) setBiometricAvailability(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleBiometrics(enabled: boolean): Promise<void> {
    try {
      if (enabled) {
        const result = await authenticateBiometrics();
        if (!result.success) {
          toast.error(result.error ?? 'Biometric authentication failed.');
          return;
        }
      }
      await app.core.security.setBiometricsEnabled(enabled);
      setLockConfig(app.core.security.config());
      toast.show(enabled ? 'Biometric unlock enabled.' : 'Biometric unlock disabled.');
    } catch (failure) {
      toast.error(isTyagError(failure) ? userMessage(failure) : 'Biometric unlock could not be changed.');
    }
  }

  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [checkingNotifications, setCheckingNotifications] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(() => {
    try {
      return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    } catch {
      return 'unknown';
    }
  });

  const availability = useMemo(() => notificationAvailability(), []);
  const deviceZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  const timeZones = useMemo(() => {
    let supported: string[] = [];
    try {
      const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
      supported = typeof intl.supportedValuesOf === 'function' ? (intl.supportedValuesOf('timeZone') ?? []) : [];
    } catch {
      supported = [];
    }
    if (supported.length === 0) supported = [...FALLBACK_TIME_ZONES];
    const current = settings.fixedTimeZone ?? deviceZone;
    if (!supported.includes(current)) supported = [current, ...supported];
    return supported;
  }, [settings.fixedTimeZone, deviceZone]);

  const storageInfo = app.storageKind ? STORAGE_INFO[app.storageKind] : undefined;

  const busy = savingKey !== null;

  const apply = useCallback(
    async (key: string, patch: Partial<AppSettings>) => {
      if (savingKey !== null) return;
      setSavingKey(key);
      try {
        await app.updateSettings(patch);
      } catch (error) {
        toast.error(
          isTyagError(error) ? userMessage(error) : 'That setting could not be saved. Your current settings are unchanged.',
        );
      } finally {
        setSavingKey(null);
      }
    },
    [app, savingKey, toast],
  );

  const applyNotificationSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      setSavingKey('notifications');
      try {
        await app.updateSettings(patch);
      } catch (error) {
        toast.error(
          isTyagError(error) ? userMessage(error) : 'That notification setting could not be saved. Nothing was changed.',
        );
      } finally {
        setSavingKey(null);
      }
    },
    [app, toast],
  );

  const toggleNotifications = async (next: boolean) => {
    if (busy || checkingNotifications) return;
    if (!next) {
      await applyNotificationSettings({ notificationsEnabled: false });
      void cancelNativeAcknowledgement();
      return;
    }
    if (availability === 'unsupported') {
      toast.error('This platform does not support local notifications. Tyag works the same without them.');
      return;
    }
    setCheckingNotifications(true);
    try {
      const granted = await requestNotificationPermission();
      try {
        setNotificationPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
      } catch {
        setNotificationPermission('unknown');
      }
      if (!granted) {
        toast.error('Notifications are blocked. Allow them for Tyag in your device or browser settings, then try again.');
        return;
      }
      await applyNotificationSettings({ notificationsEnabled: true });
      toast.show('Local progress acknowledgements are on. You can turn them off at any time.');
    } finally {
      setCheckingNotifications(false);
    }
  };

  const intervalValue = String(settings.notificationIntervalMinutes);
  const intervalOptions = useMemo(() => {
    const options = [...NOTIFICATION_INTERVALS];
    if (!options.some((option) => option.value === settings.notificationIntervalMinutes)) {
      options.push({ value: settings.notificationIntervalMinutes, label: 'Custom interval' });
    }
    return options;
  }, [settings.notificationIntervalMinutes]);

  const permissionNote =
    availability === 'unsupported'
      ? 'Local notifications are not supported in this environment. Tyag works fully without them.'
      : availability === 'native'
        ? 'Scheduled on this device by the app itself. No push service, server or account is involved.'
        : notificationPermission === 'denied'
          ? 'Notifications are currently blocked for this site or device. Allow them in your browser or device settings to use this.'
          : 'Shown locally while Tyag is open in this browser. No push service is used.';

  const durationSample = 2 * MS_PER_DAY + 4 * MS_PER_HOUR;

  return (
    <main className="screen">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Settings</h1>
          <div className="sub">Preferences are stored with your data on this device.</div>
        </div>
      </div>

      <div className="settings-sections">
        <SettingSection label="Appearance">
          <ListGroup aria-label="Appearance">
            <SettingBlock label="Theme">
              <Segmented
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                value={settings.theme}
                onChange={(theme) => void apply('theme', { theme })}
                ariaLabel="Theme"
              />
            </SettingBlock>
            <SettingBlock label="Duration format" hint={`Example: ${fmt.duration(durationSample)}`}>
              <Segmented
                options={[
                  { value: 'short', label: 'Short' },
                  { value: 'long', label: 'Long' },
                  { value: 'compact', label: 'Compact' },
                ]}
                value={settings.durationFormat}
                onChange={(durationFormat) => void apply('durationFormat', { durationFormat })}
                ariaLabel="Duration format"
              />
            </SettingBlock>
          </ListGroup>
          <p className="setting-note">Durations always come from stored timestamps; changing the format never changes progress.</p>
        </SettingSection>

        <SettingSection label="Date & time">
          <ListGroup aria-label="Date and time">
            <SettingBlock label="Time format">
              <Segmented
                options={[
                  { value: '12h', label: '12-hour' },
                  { value: '24h', label: '24-hour' },
                ]}
                value={settings.timeFormat}
                onChange={(timeFormat) => void apply('timeFormat', { timeFormat })}
                ariaLabel="Time format"
              />
            </SettingBlock>

            <SettingBlock label="Date format" hint={`Preview: ${fmt.date(app.now)}`}>
              <Select
                value={settings.dateFormat}
                onChange={(event) => {
                  const dateFormat = event.target.value as DateFormat;
                  void apply('dateFormat', { dateFormat });
                }}
                aria-label="Date format"
                disabled={busy}
              >
                {DATE_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {formatDate(app.now, timeZone, format)}
                  </option>
                ))}
              </Select>
            </SettingBlock>

            <SettingBlock label="First day of week">
              <Segmented
                options={[
                  { value: '0', label: 'Sunday' },
                  { value: '1', label: 'Monday' },
                ]}
                value={String(settings.firstDayOfWeek) as '0' | '1'}
                onChange={(value) => void apply('firstDayOfWeek', { firstDayOfWeek: value === '1' ? 1 : 0 })}
                ariaLabel="First day of week"
              />
            </SettingBlock>

            <SettingBlock label="Time zone">
              <Segmented
                options={[
                  { value: 'device', label: 'This device' },
                  { value: 'fixed', label: 'Fixed' },
                ]}
                value={settings.timeZoneMode}
                onChange={(timeZoneMode) => {
                  if (timeZoneMode === 'fixed') {
                    void apply('timeZoneMode', {
                      timeZoneMode,
                      fixedTimeZone: settings.fixedTimeZone ?? deviceZone,
                    });
                  } else {
                    void apply('timeZoneMode', { timeZoneMode });
                  }
                }}
                ariaLabel="Time zone behaviour"
              />
            </SettingBlock>

            {settings.timeZoneMode === 'fixed' ? (
              <SettingBlock label="Fixed time zone" hint="Used for dates, charts and exports, even when you travel.">
                <Select
                  value={settings.fixedTimeZone ?? deviceZone}
                  onChange={(event) => void apply('fixedTimeZone', { fixedTimeZone: event.target.value })}
                  aria-label="Fixed time zone"
                  disabled={busy}
                >
                  {timeZones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </Select>
              </SettingBlock>
            ) : null}

            <SettingBlock label="Preview" hint="Updates immediately; nothing is saved by previewing.">
              <div className="setting-preview" aria-live="polite">
                <div className="setting-preview-value">{fmt.dateTime(app.now)}</div>
                <div className="setting-hint">
                  {timeZone} · {formatUtcOffset(utcOffsetMinutesAt(app.now, timeZone))}
                  <span aria-hidden="true"> · </span>
                  {settings.timeZoneMode === 'fixed' ? 'Fixed time zone' : `Following this device (${deviceZone})`}
                </div>
              </div>
            </SettingBlock>
          </ListGroup>
        </SettingSection>

        <SettingSection
          label="Notifications"
          note="Local notifications only. No push service, no account. You can turn this off at any time."
        >
          <ListGroup aria-label="Notifications">
            <Toggle
              label="Progress acknowledgement"
              description="An occasional local reminder that your progress continues. Off by default; progress never depends on it."
              checked={settings.notificationsEnabled}
              onChange={(next) => void toggleNotifications(next)}
              disabled={busy || checkingNotifications || availability === 'unsupported'}
            />
            <SettingBlock label="Interval">
              <Select
                value={intervalValue}
                onChange={(event) =>
                  void apply('notificationInterval', { notificationIntervalMinutes: Number(event.target.value) })
                }
                aria-label="Progress acknowledgement interval"
                disabled={!settings.notificationsEnabled || busy}
              >
                {intervalOptions.map((option) => (
                  <option key={option.value} value={String(option.value)}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </SettingBlock>
          </ListGroup>
          <div className={`notice ${notificationPermission === 'denied' ? 'warn' : ''}`} style={{ marginTop: 12 }}>
            {permissionNote}
          </div>
        </SettingSection>

        <SettingSection
          label="App lock"
          note="Tyag asks for your PIN every time it opens and locks when you leave. The 4-digit PIN is stored only as a salted hash; it is never included in backups."
        >
          <ListGroup aria-label="App lock">
            <ListRow label="Change PIN" value="4 digits" chevron onClick={() => window.dispatchEvent(new Event('tyag:change-pin'))} />
            {biometricsSupported() && biometricAvailability?.available ? (
              <Toggle
                label="Biometric unlock"
                description="Use your fingerprint or face instead of typing the PIN."
                checked={lockConfig.biometricsEnabled}
                onChange={(value) => void toggleBiometrics(value)}
              />
            ) : null}
            <ListRow
              label="Lock now"
              chevron
              onClick={() => window.dispatchEvent(new Event('tyag:lock'))}
            />
          </ListGroup>
          <p className="setting-note">
            Reset is the only recovery: forgetting the PIN means erasing the local data and re-importing a backup. Turn on
            biometric unlock to avoid typing the PIN on this Android device.
          </p>
        </SettingSection>

        <SettingSection
          label="Triggers & reasons"
          note="Manage the lists offered when you record a lapse or an urge."
        >
          <CategoriesSection />
        </SettingSection>

        <SettingSection
          label="Privacy & security"
          note="Tyag has no account and no telemetry. Your records are never sent to a server."
        >
          <ListGroup aria-label="Privacy and security">
            <ListRow label="Your data lives in" value={storageInfo?.label ?? 'This device'} />
            <ListRow label="Account" value="Not required" />
            <ListRow label="Network" value="No data is sent" />
            <ListRow label="Encrypted backups" value="Optional, password-protected" />
            <ListRow label="Data & Backups" chevron onClick={() => navigate('/data')} />
          </ListGroup>
          {storageInfo?.note ? <p className="setting-note">{storageInfo.note}</p> : null}
          {app.storageWarning ? (
            <div className="notice warn" role="status" style={{ marginTop: 8 }}>
              {app.storageWarning}
            </div>
          ) : null}
          <div className="notice" style={{ marginTop: 8 }}>
            Everything you record stays in this app on this device. There is no server, no account, no analytics SDK and no
            network request that carries your data. Files leave the app only when you export a backup or spreadsheet yourself.
          </div>
          <div className="notice warn" style={{ marginTop: 8 }}>
            The app PIN and biometric unlock gate access to Tyag, but the live database itself is not encrypted by
            Tyag. Rely on your device passcode and disk encryption as well; someone with access to the app's private storage or
            a device backup could read the database file.
          </div>
        </SettingSection>

        <SettingSection label="About">
          <div className="about-brand">
            <TyagLockup height={24} />
          </div>
          <ListGroup aria-label="About Tyag">
            <ListRow label="Version" value={app.core.appVersion} />
            <ListRow label="Database schema" value={String(SCHEMA_VERSION)} />
            <ListRow label="License" value="AGPL-3.0-only" />
            <ListRow label="Source" value={<span className="setting-wrap-value">{REPOSITORY_URL.replace(/^https?:\/\//, '')}</span>} />
            <ListRow label="Works offline" value="Yes" />
            <ListRow label="Notifications require" value="Your permission" />
          </ListGroup>
          <p className="setting-note">
            Tyag is a local-first self-help tool, not medical care or a substitute for professional support. Insights
            describe patterns in your own records only; they do not diagnose, predict or judge.
          </p>
          <p className="setting-note">Plain-text links are shown for reference only; Tyag never opens external pages for you.</p>
        </SettingSection>
      </div>

      <div className="tiny settings-footer">
        <span>All preferences are saved automatically.</span>
        <Button variant="plain" onClick={() => navigate('/data')}>
          Open Data &amp; Backups
        </Button>
      </div>
    </main>
  );
}
