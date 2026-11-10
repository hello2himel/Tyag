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
  if (!app.settings.onboarded) {
    return <OnboardingScreen onComplete={() => app.refresh()} />;
  }
  return <Shell />;
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
        <div className="sidebar-footer">Local only · no account</div>
      </aside>

      <div className="main">
        {app.storageWarning ? (
          <div className="storage-banner" role="status">
            {app.storageWarning}
          </div>
        ) : null}
        <ScreenContent route={route} />
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
