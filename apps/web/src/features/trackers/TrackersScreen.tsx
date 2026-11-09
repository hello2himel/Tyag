// PLACEHOLDER: implemented by the ui-trackers teammate.
import { useApp } from '../../store/app';
import { navigate } from '../../router';
import { Card, EmptyState, IconButton, StreakBar } from '../../ui/components';
import { useFormatters } from '../../ui/format';

export function TrackersScreen() {
  const app = useApp();
  const fmt = useFormatters();
  const trackers = app.core.trackers.list();
  if (trackers.length === 0) {
    return (
      <main className="screen">
        <div className="screen-head">
          <div>
            <h1 className="screen-title">Trackers</h1>
            <div className="sub">deUrge · stored on this device</div>
          </div>
        </div>
        <EmptyState
          title="Start with one behaviour"
          body="Create a tracker for something you want to stay away from. Progress starts the moment you do."
          action={
            <button type="button" className="btn btn-primary" onClick={() => navigate('/trackers?new=1')}>
              Create a tracker
            </button>
          }
        />
      </main>
    );
  }
  return (
    <main className="screen">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Trackers</h1>
          <div className="sub">
            deUrge · {trackers.length} tracker{trackers.length === 1 ? '' : 's'}, stored on this device
          </div>
        </div>
        <IconButton label="New tracker" icon="plus" onClick={() => navigate('/trackers?new=1')} />
      </div>
      <div className="stack">
        {trackers.map((tracker) => {
          const metrics = app.core.metrics(tracker.id);
          return (
            <Card key={tracker.id} className="card-pad clickable" onClick={() => navigate(`/tracker/${tracker.id}`)}>
              <div className="row">
                <div className="h3">{tracker.name}</div>
                <div className="sub" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className={`dot ${tracker.status === 'active' ? '' : tracker.status}`} /> {tracker.status}
                </div>
              </div>
              <div className="big" style={{ fontSize: 44, margin: '14px 0 8px' }}>
                {fmt.duration(metrics.currentStreakMs)}
              </div>
              <div className="mut" style={{ fontSize: 13 }}>
                Since {fmt.date(tracker.startedAt)}
              </div>
              <StreakBar intervals={metrics.intervals} />
            </Card>
          );
        })}
      </div>
    </main>
  );
}
