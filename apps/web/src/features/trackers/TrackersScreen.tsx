/**
 * Trackers — the home screen. One card per tracker with the current streak,
 * how the tracker is running, and its streak history bar. The header's Edit
 * button reveals lifecycle actions on every card; the + button (and the
 * sidebar's "New tracker") opens the create sheet via `#/trackers?new=1`.
 */
import { useEffect, useMemo, useState } from 'react';
import type { TyagCore, Tracker } from '@tyag/core';
import { useApp } from '../../store/app';
import { navigate, useRoute } from '../../router';
import { RollingText } from '../../ui/RollingText';
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  StreakBar,
} from '../../ui/components';
import { useFormatters, type Formatters } from '../../ui/format';
import { TrackerActions } from './TrackerActions';
import { TrackerSheet } from './TrackerSheet';
import { TRACKER_STATUS_LABEL, trackerStatusDotClass } from './trackerStatus';
import './trackers.css';

/** When was this tracker last paused? The history log is the honest source. */
function lastPausedAt(core: TyagCore, trackerId: string): number | null {
  try {
    const [item] = core.history.list({ trackerId, types: ['tracker_paused'], limit: 1 });
    return item ? item.event.occurredAt : null;
  } catch {
    return null;
  }
}

function statusLine(tracker: Tracker, fmt: Formatters, pausedAt: number | null): string {
  const dateTime = `${fmt.dateCompact(tracker.startedAt)}, ${fmt.time(tracker.startedAt)}`;
  if (tracker.status === 'active') return `Since ${dateTime}`;
  if (tracker.status === 'paused') {
    return pausedAt === null
      ? 'Paused · time not counted'
      : `Paused ${fmt.dateCompact(pausedAt)} · time not counted`;
  }
  const archivedAt = tracker.archivedAt ?? tracker.updatedAt;
  return `Archived ${fmt.dateCompact(archivedAt)} · history kept`;
}

export function TrackersScreen() {
  const app = useApp();
  const fmt = useFormatters();
  const route = useRoute();
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<{ tracker: Tracker | null } | null>(null);
  const trackers = app.core.trackers.list();

  // Pause dates come from the activity log; looking them up only when the data
  // changes keeps the one-second display clock from querying every tick.
  const pausedDates = useMemo(() => {
    const dates = new Map<string, number | null>();
    for (const tracker of app.core.trackers.list()) {
      if (tracker.status === 'paused') dates.set(tracker.id, lastPausedAt(app.core, tracker.id));
    }
    return dates;
  }, [app.core, app.version]);

  // `#/trackers?new=1` comes from the sidebar and from the empty state CTA.
  useEffect(() => {
    if (route.name === 'trackers' && route.query.get('new') === '1') {
      setSheet({ tracker: null });
    }
  }, [route.name, route.hash]);

  function closeSheet(): void {
    setSheet(null);
    if (route.name === 'trackers' && route.query.has('new')) navigate('/trackers');
  }

  function handleSaved(tracker: Tracker, created: boolean): void {
    setSheet(null);
    if (created) {
      navigate(`/tracker/${tracker.id}`);
    } else if (route.query.has('new')) {
      navigate('/trackers');
    }
  }

  const countLabel = `${trackers.length} tracker${trackers.length === 1 ? '' : 's'}`;

  return (
    <main className="screen">
      <header className="trackers-header">
        <div className="trackers-topbar">
          {trackers.length > 0 ? (
            <button type="button" className="btn btn-plain trackers-edit" onClick={() => setEditing((value) => !value)}>
              {editing ? 'Done' : 'Edit'}
            </button>
          ) : (
            <span />
          )}
          <IconButton label="New tracker" icon="plus" onClick={() => setSheet({ tracker: null })} />
        </div>
        <h1 className="screen-title">Trackers</h1>
        <div className="sub">{countLabel}</div>
      </header>

      {trackers.length === 0 ? (
        <EmptyState
          title="Start tracking"
          body="New tracker for something you want to stay away from. Progress starts the moment you do — and earlier progress is never lost."
          action={
            <Button variant="primary" onClick={() => setSheet({ tracker: null })}>
              New tracker
            </Button>
          }
        />
      ) : (
        <div className="tracker-list">
          {trackers.map((tracker) => {
            const metrics = app.core.metrics(tracker.id);
            return (
              <Card key={tracker.id} className="tracker-card">
                <button
                  type="button"
                  className="tracker-card-main clickable"
                  onClick={() => navigate(`/tracker/${tracker.id}`)}
                  title={`Open ${tracker.name} — started ${fmt.dateTime(tracker.startedAt)}`}
                >
                  <span className="tracker-card-head">
                    <span className="tracker-name">{tracker.name}</span>
                    <span className="tracker-status">
                      <span className={trackerStatusDotClass(tracker.status)} />
                      {TRACKER_STATUS_LABEL[tracker.status]}
                    </span>
                  </span>
                  <span
                    className={`big tracker-streak ${
                      tracker.status === 'active' ? '' : tracker.status
                    }`.trim()}
                  >
                    <RollingText text={fmt.duration(metrics.currentStreakMs, 'short')} />
                  </span>
                  <span className="tracker-since">{statusLine(tracker, fmt, pausedDates.get(tracker.id) ?? null)}</span>
                  <StreakBar intervals={metrics.intervals} />
                </button>
                {editing ? (
                  <TrackerActions
                    tracker={tracker}
                    onEdit={() => setSheet({ tracker })}
                    onDeleted={() => undefined}
                  />
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      {sheet ? (
        <TrackerSheet
          open
          tracker={sheet.tracker}
          onClose={closeSheet}
          onSaved={handleSaved}
        />
      ) : null}
    </main>
  );
}
