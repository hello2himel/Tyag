/**
 * Application state: the single DeUrgeCore instance, current settings and a
 * one-second clock used only for *display* (all durations are recomputed from
 * stored timestamps, so a suspended timer never distorts progress).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DeUrgeCore, type AppSettings, type PersistenceAdapter } from '@deurge/core';
import { openDeUrgeCore } from '../platform/db';
import {
  cancelNativeAcknowledgement,
  notificationAvailability,
  scheduleNativeAcknowledgement,
  showProgressNotification,
} from '../platform/notifications';

export type ResolvedTheme = 'light' | 'dark';

export interface AppContextValue {
  core: DeUrgeCore;
  settings: AppSettings;
  timeZone: string;
  now: number;
  /** Incremented whenever data changes; screens recompute from the database. */
  version: number;
  resolvedTheme: ResolvedTheme;
  storageKind: PersistenceAdapter['kind'] | null;
  storageWarning: string | null;
  refresh: () => void;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  reload: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

interface ReadyState {
  status: 'ready';
  core: DeUrgeCore;
  settings: AppSettings;
  timeZone: string;
  storageKind: PersistenceAdapter['kind'];
  storageWarning: string | null;
}

type BootState = { status: 'booting' } | ReadyState | { status: 'error'; message: string };

function resolveTheme(settings: AppSettings): ResolvedTheme {
  if (settings.theme === 'light') return 'light';
  if (settings.theme === 'dark') return 'dark';
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#000000' : '#F2F2F7');
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<BootState>({ status: 'booting' });
  const [now, setNow] = useState(() => Date.now());
  const [version, setVersion] = useState(0);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });
  const [reloadToken, setReloadToken] = useState(0);
  const notificationTimer = useRef<number | null>(null);

  const bootOnce = useCallback(async () => {
    setBoot({ status: 'booting' });
    try {
      const result = await openDeUrgeCore();
      const settings = result.core.settings.get();
      applyTheme(resolveTheme(settings));
      if (import.meta.env.DEV) {
        // Development-only handle for automated UI verification. Tree-shaken
        // from production builds; never exposed to users.
        (window as unknown as { __deurgeCore?: unknown }).__deurgeCore = result.core;
      }
      setBoot({
        status: 'ready',
        core: result.core,
        settings,
        timeZone: result.core.timeZone(),
        storageKind: result.persistenceKind,
        storageWarning: result.storageWarning,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'deUrge could not open its local database. Your data stays on this device.';
      setBoot({ status: 'error', message });
    }
  }, []);

  useEffect(() => {
    void bootOnce();
  }, [bootOnce, reloadToken]);

  // Display clock (one second), plus periodic database-independent refresh.
  useEffect(() => {
    if (boot.status !== 'ready') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [boot.status]);

  // Follow OS theme when the setting is "system".
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => setSystemTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const settings = boot.status === 'ready' ? boot.settings : null;
  const resolvedTheme = settings
    ? settings.theme === 'system'
      ? systemTheme
      : settings.theme
    : systemTheme;

  useEffect(() => {
    if (boot.status === 'ready') applyTheme(resolvedTheme);
  }, [boot.status, resolvedTheme]);

  const refresh = useCallback(() => {
    setVersion((value) => value + 1);
    setNow(Date.now());
    setBoot((current) => {
      if (current.status !== 'ready') return current;
      const nextSettings = current.core.settings.get();
      return {
        ...current,
        settings: nextSettings,
        timeZone: current.core.timeZone(),
      };
    });
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (boot.status !== 'ready') return;
      const next = await boot.core.settings.update(patch);
      setBoot((current) =>
        current.status === 'ready'
          ? { ...current, settings: next, timeZone: current.core.timeZone() }
          : current,
      );
    },
    [boot],
  );

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  // Optional, explicitly-enabled local progress acknowledgement.
  useEffect(() => {
    if (boot.status !== 'ready') return;
    const { core, settings: current, timeZone } = boot;
    if (!current.notificationsEnabled) {
      if (notificationTimer.current !== null) {
        window.clearInterval(notificationTimer.current);
        notificationTimer.current = null;
      }
      void cancelNativeAcknowledgement();
      return;
    }
    if (notificationAvailability() === 'native') {
      void scheduleNativeAcknowledgement(current.notificationIntervalMinutes);
    }
    const intervalMs = Math.max(current.notificationIntervalMinutes, 60) * 60_000;
    notificationTimer.current = window.setInterval(() => {
      try {
        const key = 'deurge.lastNotificationAt';
        const last = Number(window.localStorage.getItem(key) ?? 0);
        if (Number.isFinite(last) && Date.now() - last < intervalMs) return;
        const trackers = core.trackers.listActive();
        if (trackers.length === 0) return;
        const tracker = trackers[0]!;
        const metrics = core.metrics(tracker.id);
        const duration = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
          Math.max(0, Math.floor(metrics.currentStreakMs / 3_600_000)),
        );
        void showProgressNotification(
          'deUrge',
          `You've stayed away from ${tracker.name} for ${duration} hours. Your progress continues.`,
        );
        window.localStorage.setItem(key, String(Date.now()));
      } catch {
        /* local notifications are best-effort */
      }
      void timeZone;
    }, 60_000);
    return () => {
      if (notificationTimer.current !== null) window.clearInterval(notificationTimer.current);
    };
  }, [boot]);

  const value = useMemo<AppContextValue | null>(() => {
    if (boot.status !== 'ready') return null;
    return {
      core: boot.core,
      settings: boot.settings,
      timeZone: boot.timeZone,
      now,
      version,
      resolvedTheme,
      storageKind: boot.storageKind,
      storageWarning: boot.storageWarning,
      refresh,
      updateSettings,
      reload,
    };
  }, [boot, now, version, resolvedTheme, refresh, updateSettings, reload]);

  if (boot.status === 'booting') return <BootScreen />;
  if (boot.status === 'error') return <BootErrorScreen message={boot.message} onRetry={reload} />;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider after boot');
  return value;
}

function BootScreen() {
  return (
    <div className="boot">
      <div className="boot-mark" aria-hidden="true">
        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em' }}>deUrge</div>
      <div className="mut" style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="spinner" aria-hidden="true" /> Opening your local database…
      </div>
      <div className="tiny" style={{ maxWidth: 320 }}>
        Everything stays on this device. No account, no cloud, no tracking.
      </div>
    </div>
  );
}

function BootErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="boot">
      <div className="boot-mark" aria-hidden="true">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l10 18H2zM12 9v5M12 17.5h.01" />
        </svg>
      </div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>Could not open your local data</div>
      <div className="mut" style={{ maxWidth: 380, fontSize: 15, lineHeight: 1.5 }}>{message}</div>
      <div className="tiny" style={{ maxWidth: 380 }}>
        Nothing was sent anywhere. If this started after an import, your previous data may still be recoverable from a
        backup file you exported earlier.
      </div>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
