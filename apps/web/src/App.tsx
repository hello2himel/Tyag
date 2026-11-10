import { useEffect, useRef, useState } from 'react';
import { AppProvider, useApp } from './store/app';
import { navigate, useRoute, type RouteName } from './router';
import { Icon, type IconName } from './ui/components';
import { DeUrgeLockup } from './ui/logo';
import { TrackersScreen } from './features/trackers/TrackersScreen';
import { TrackerDetailScreen } from './features/trackers/TrackerDetailScreen';
import { OnboardingScreen } from './features/onboarding/OnboardingScreen';
import { JournalScreen } from './features/journal/JournalScreen';
import { InsightsScreen } from './features/insights/InsightsScreen';
import { SettingsScreen } from './features/settings/SettingsScreen';
import { DataScreen } from './features/data/DataScreen';
import { LockScreen, SetPinScreen } from './features/lock/AppLock';
import { DeUrgeMark } from './ui/logo';

const NAV: { name: RouteName; label: string; icon: IconName; path: string }[] = [
  { name: 'trackers', label: 'Trackers', icon: 'clock', path: '/trackers' },
  { name: 'journal', label: 'Journal', icon: 'journal', path: '/journal' },
  { name: 'insights', label: 'Insights', icon: 'insights', path: '/insights' },
  { name: 'settings', label: 'Settings', icon: 'settings', path: '/settings' },
];

export function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}

function Root() {
  const app = useApp();
  const [hasPassword, setHasPassword] = useState(() => app.core.security.hasPassword());
  const [unlocked, setUnlocked] = useState(false);
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [privacyShield, setPrivacyShield] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [justUnlocked, setJustUnlocked] = useState(false);
  const unlockTimer = useRef<number | null>(null);

  // Backgrounding shows the branded privacy shield immediately and arms the
  // lock; the app switcher never captures content. On return the lock screen is
  // already waiting.
  useEffect(() => {
    function onVisibility(): void {
      if (document.hidden) {
        setPrivacyShield(true);
        setChangePinOpen(false);
        if (hasPassword) setUnlocked(false);
        return;
      }
      setPrivacyShield(false);
    }
    function onLock(): void {
      setUnlocked(false);
      setChangePinOpen(false);
    }
    function onChangePin(): void {
      setChangePinOpen(true);
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('deurge:lock', onLock);
    window.addEventListener('deurge:change-pin', onChangePin);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('deurge:lock', onLock);
      window.removeEventListener('deurge:change-pin', onChangePin);
    };
  }, [hasPassword]);

  useEffect(
    () => () => {
      if (unlockTimer.current !== null) window.clearTimeout(unlockTimer.current);
    },
    [],
  );

  function handleUnlock(): void {
    if (unlocking) return;
    setUnlocking(true);
    unlockTimer.current = window.setTimeout(() => {
      setUnlocked(true);
      setUnlocking(false);
      setJustUnlocked(true);
      window.setTimeout(() => setJustUnlocked(false), 420);
    }, 400);
  }

  if (!app.settings.onboarded) {
    return (
      <OnboardingScreen
        onComplete={() => {
          app.refresh();
          const hasPin = app.core.security.hasPassword();
          setHasPassword(hasPin);
          if (hasPin) {
            setUnlocked(true);
            setJustUnlocked(true);
            window.setTimeout(() => setJustUnlocked(false), 420);
          }
        }}
      />
    );
  }
  if (!hasPassword) {
    return (
      <SetPinScreen
        onDone={() => {
          setHasPassword(true);
          setUnlocked(true);
          setJustUnlocked(true);
          window.setTimeout(() => setJustUnlocked(false), 420);
        }}
      />
    );
  }
  if (!unlocked) {
    return (
      <>
        {privacyShield ? (
          <div className="privacy-shield" aria-hidden="true">
            <DeUrgeMark size={40} />
          </div>
        ) : null}
        <div className={unlocking ? 'lock-layer-exit' : ''}>
          <LockScreen onUnlock={handleUnlock} />
        </div>
      </>
    );
  }
  return (
    <>
      <div className={justUnlocked ? 'app-content-enter' : ''}>
        <Shell />
      </div>
      {changePinOpen ? (
        <SetPinScreen
          mode="change"
          overlay
          onCancel={() => setChangePinOpen(false)}
          onDone={() => {
            setChangePinOpen(false);
            app.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function ScreenContent({ route }: { route: ReturnType<typeof useRoute> }) {
  switch (route.name) {
    case 'tracker':
      return <TrackerDetailScreen trackerId={route.trackerId!} />;
    case 'journal':
      return <JournalScreen />;
    case 'insights':
      return <InsightsScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'data':
      return <DataScreen />;
    case 'trackers':
    default:
      return <TrackersScreen />;
  }
}

function Shell() {
  const app = useApp();
  const route = useRoute();
  const previousRoute = useRef(route);
  const [transition, setTransition] = useState<'' | 'push' | 'pop'>('');
  const [exiting, setExiting] = useState<ReturnType<typeof useRoute> | null>(null);
  const exitTimer = useRef<number | null>(null);
  useEffect(() => {
    const previous = previousRoute.current;
    const changed = previous.name !== route.name || previous.trackerId !== route.trackerId;
    if (!changed) return;
    let next: '' | 'push' | 'pop' = '';
    if (route.name === 'tracker') next = 'push';
    else if (previous.name === 'tracker') next = 'pop';
    setTransition(next);
    if (next) {
      setExiting(previous);
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
      exitTimer.current = window.setTimeout(() => {
        setExiting(null);
        setTransition('');
      }, 520);
    }
    previousRoute.current = route;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name, route.trackerId]);
  const screenKey = route.name === 'tracker' ? `tracker:${route.trackerId}` : route.name;
  const trackers = app.core.trackers.list();
  const isActive = (name: RouteName): boolean =>
    route.name === name || (name === 'trackers' && route.name === 'tracker');

  return (
    <div className="layout">
      <aside className="sidebar" aria-label="Primary">
        <button
          type="button"
          className="sidebar-brand"
          onClick={() => navigate('/trackers')}
          aria-label="deUrge — Trackers"
        >
          <DeUrgeLockup height={26} />
        </button>
        <div className="sidebar-label">Trackers</div>
        {trackers.map((tracker) => (
          <button
            type="button"
            key={tracker.id}
            className={`nav-item ${route.name === 'tracker' && route.trackerId === tracker.id ? 'on' : ''}`}
            onClick={() => navigate(`/tracker/${tracker.id}`)}
            title={tracker.name}
          >
            <span className={`dot ${tracker.status === 'active' ? '' : tracker.status}`} />
            <span className="nav-truncate">{tracker.name}</span>
          </button>
        ))}
        <button type="button" className="nav-item" onClick={() => navigate('/trackers?new=1')}>
          <span style={{ color: 'var(--b)', fontSize: 17, width: 8, textAlign: 'center' }}>+</span>
          <span style={{ color: 'var(--b)' }}>New tracker</span>
        </button>
        <div className="sidebar-label">Library</div>
        <button type="button" className={`nav-item ${isActive('journal') ? 'on' : ''}`} onClick={() => navigate('/journal')}>
          Journal
        </button>
        <button type="button" className={`nav-item ${isActive('insights') ? 'on' : ''}`} onClick={() => navigate('/insights')}>
          Insights
        </button>
        <button type="button" className={`nav-item ${isActive('data') ? 'on' : ''}`} onClick={() => navigate('/data')}>
          Data &amp; Backups
        </button>
        <button
          type="button"
          className={`nav-item ${isActive('settings') ? 'on' : ''}`}
          onClick={() => navigate('/settings')}
        >
          Settings
        </button>
      </aside>

      <div className="main">
        {app.storageWarning ? (
          <div className="storage-banner" role="status">
            {app.storageWarning}
          </div>
        ) : null}
        <div className="screen-stack">
          {exiting && transition ? (
            <div className={`screen-exit-layer screen-exit-${transition}`} aria-hidden="true">
              <ScreenContent route={exiting} />
            </div>
          ) : null}
          <div key={screenKey} className={`screen-wrap${transition ? ` screen-enter-${transition}` : ''}`}>
            <ScreenContent route={route} />
          </div>
        </div>
      </div>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((item) => {
          const active = isActive(item.name);
          return (
            <button
              key={item.name}
              type="button"
              className={active ? 'on' : ''}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(item.path)}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
