// PLACEHOLDER: implemented by the ui-trackers teammate.
import { useApp } from '../../store/app';
import { navigate } from '../../router';
import { Card, Icon, StatTile, StreakBar } from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { buildRecognition } from '@deurge/core';

export function TrackerDetailScreen({ trackerId }: { trackerId: string }) {
  const app = useApp();
  const fmt = useFormatters();
  const tracker = app.core.trackers.get(trackerId);
  const metrics = app.core.metrics(trackerId);
  const recognition = buildRecognition(tracker, metrics);
  return (
    <main className="screen">
      <button type="button" className="btn btn-plain" onClick={() => navigate('/trackers')}>
        <Icon name="chevron-left" size={18} /> Trackers
      </button>
      <h1 className="screen-title">{tracker.name}</h1>
      <div className="sub" style={{ marginBottom: 16 }}>
        <span className={`dot ${tracker.status === 'active' ? '' : tracker.status}`} /> {tracker.status} · Started{' '}
        {fmt.date(tracker.startedAt)}
      </div>
      <Card className="card-pad">
        <div className="lb" style={{ padding: 0 }}>Current streak</div>
        <div className="big" style={{ fontSize: 52, margin: '12px 0' }}>{fmt.duration(metrics.currentStreakMs)}</div>
        <p style={{ fontSize: 16, lineHeight: 1.5 }}>{recognition.headline}</p>
        <StreakBar intervals={metrics.intervals} className="streakbar" />
      </Card>
      <div className="stat-grid" style={{ marginTop: 12 }}>
        <StatTile label="Longest" value={fmt.duration(metrics.longestStreakMs)} />
        <StatTile label="Accumulated" value={fmt.duration(metrics.accumulatedAbstinenceMs)} />
        <StatTile label="Lapses" value={metrics.lapseCount} />
        <StatTile label="Since start" value={fmt.duration(metrics.elapsedSinceStartMs)} />
      </div>
    </main>
  );
}
