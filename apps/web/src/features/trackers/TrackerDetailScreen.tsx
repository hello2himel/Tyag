/**
 * Tracker detail — the current streak, recognition, honest statistics and a
 * full activity timeline. Wide screens use the desktop layout from the design
 * boards: main column + Activity column on the right (>= 1200px).
 *
 * All numbers are recomputed from stored records on every render (and the app
 * clock ticks once a second), so the streak you see is always the streak the
 * calculation engine produces. Nothing here is cached as a source of truth.
 */
import { useMemo, useState } from 'react';
import {
  buildRecognition,
  type HistoryEventType,
  type HistoryItem,
  type Tracker,
} from '@deurge/core';
import { useApp } from '../../store/app';
import { navigate } from '../../router';
import { RollingText } from '../../ui/RollingText';
import {
  BarChart,
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  Input,
  StatTile,
  StreakBar,
} from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { RecordSheet, type RecordKind } from '../record/RecordSheet';
import { TrackerActions } from './TrackerActions';
import { TrackerSheet } from './TrackerSheet';
import { TRACKER_STATUS_LABEL, trackerStatusDotClass } from './trackerStatus';
import './trackers.css';

type ActivityFilter = 'all' | 'lapses' | 'urges' | 'notes';

interface ActivityFilterOption {
  value: ActivityFilter;
  label: string;
  types?: HistoryEventType[];
}

const ACTIVITY_FILTERS: ActivityFilterOption[] = [
  { value: 'all', label: 'All' },
  { value: 'lapses', label: 'Lapses', types: ['lapse_recorded', 'lapse_updated', 'lapse_deleted'] },
  { value: 'urges', label: 'Urges', types: ['urge_recorded', 'urge_updated', 'urge_deleted'] },
  {
    value: 'notes',
    label: 'Notes',
    types: [
      'journal_entry_created',
      'journal_entry_updated',
      'journal_entry_deleted',
      'checkin_recorded',
      'checkin_deleted',
    ],
  },
];

/** Only live lapse/urge records can be opened in the record sheet. */
function editableRecord(item: HistoryItem): { kind: RecordKind; id: string } | null {
  if (!item.event.refId) return null;
  if (item.refType === 'lapse' && item.event.type !== 'lapse_deleted') {
    return { kind: 'lapse', id: item.event.refId };
  }
  if (item.refType === 'urge' && item.event.type !== 'urge_deleted') {
    return { kind: 'urge', id: item.event.refId };
  }
  return null;
}

/** "Today" / "Yesterday" / "Oct 29" style labels for the timeline. */
function relativeDayLabel(relative: string): string {
  return relative.split(',')[0] ?? relative;
}

function itemDotTone(item: HistoryItem): string {
  if (item.refType === 'lapse') return 'lapse';
  if (item.refType === 'urge') return 'urge';
  if (item.refType === 'journal' || item.refType === 'checkin') return 'journal';
  switch (item.event.type) {
    case 'tracker_paused':
    case 'tracker_archived':
    case 'tracker_deleted':
    case 'tracker_restored':
      return 'paused';
    default:
      return '';
  }
}

export function TrackerDetailScreen({ trackerId }: { trackerId: string }) {
  const app = useApp();
  const fmt = useFormatters();
  const [editOpen, setEditOpen] = useState(false);
  const [logKind, setLogKind] = useState<RecordKind | null>(null);
  const [editRecord, setEditRecord] = useState<{ kind: RecordKind; id: string } | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [search, setSearch] = useState('');

  let tracker: Tracker | null = null;
  try {
    tracker = app.core.trackers.get(trackerId);
  } catch {
    tracker = null;
  }

  const filterTypes = ACTIVITY_FILTERS.find((option) => option.value === filter)?.types;
  const activity = useMemo(() => {
    if (!tracker) return [];
    try {
      return app.core.history.list({
        trackerId: tracker.id,
        types: filterTypes,
        search: search.trim() ? search.trim() : undefined,
        limit: 100,
      });
    } catch {
      return [];
    }
  }, [app.core, app.version, tracker?.id, filterTypes, search]);

  // Charts only change when the underlying records change, not every second.
  const analytics = useMemo(() => {
    if (!tracker) return null;
    try {
      return app.core.analytics.forTracker(tracker.id, { granularity: 'month', periodLimit: 6 });
    } catch {
      return null;
    }
  }, [app.core, app.version, tracker?.id]);

  if (!tracker) {
    return (
      <main className="screen">
        <div className="detail-topbar">
          <button type="button" className="btn btn-plain" onClick={() => navigate('/trackers')}>
            <Icon name="chevron-left" size={18} /> Trackers
          </button>
        </div>
        <EmptyState
          title="Tracker not found"
          body="This tracker may have been deleted. Your other data is still on this device."
          action={
            <Button variant="primary" onClick={() => navigate('/trackers')}>
              Back to trackers
            </Button>
          }
        />
      </main>
    );
  }

  const metrics = app.core.metrics(tracker.id);
  const recognition = buildRecognition(tracker, metrics);
  const share =
    metrics.abstinenceShareOfElapsed === null
      ? '—'
      : `${Math.round(metrics.abstinenceShareOfElapsed * 100)}%`;
  const periodData = analytics?.periods ?? [];
  const lapseChart = periodData.map((period) => {
    const month = Number(period.key.slice(5, 7));
    return {
      label: fmt.monthShort(month),
      value: period.lapseCount,
      displayValue: `${period.lapseCount} lapse${period.lapseCount === 1 ? '' : 's'}`,
    };
  });
  const urgeChart = periodData.map((period) => {
    const month = Number(period.key.slice(5, 7));
    return {
      label: fmt.monthShort(month),
      value: period.averageUrgeIntensity ?? 0,
      displayValue:
        period.averageUrgeIntensity === null ? 'No urges' : `${period.averageUrgeIntensity.toFixed(1)} / 10`,
    };
  });
  const emptyActivity = search.trim()
    ? 'No activity matches that search.'
    : filter === 'all'
      ? 'No activity yet. Log an urge or record a lapse and it will appear here.'
      : filter === 'notes'
        ? 'No journal notes for this tracker yet.'
        : `No ${filter} recorded yet.`;

  return (
    <main className="screen detail-screen">
      <div className="detail-topbar">
        <button type="button" className="btn btn-plain" onClick={() => navigate('/trackers')}>
          <Icon name="chevron-left" size={18} /> Trackers
        </button>
        <Button variant="plain" onClick={() => setEditOpen(true)}>
          Edit
        </Button>
      </div>

      <h1 className="screen-title">{tracker.name}</h1>
      <div className="detail-sub">
        <span className={trackerStatusDotClass(tracker.status)} />
        {TRACKER_STATUS_LABEL[tracker.status]} · Started {fmt.dateCompact(tracker.startedAt)},{' '}
        {fmt.time(tracker.startedAt)}
      </div>

      <TrackerActions
        tracker={tracker}
        onDeleted={() => navigate('/trackers')}
        className="detail-actions"
      />

      {tracker.description ? (
        <div className="detail-meta">
          {tracker.description ? <p className="detail-description">{tracker.description}</p> : null}

        </div>
      ) : null}

      <div className="detail-layout">
        <div className="detail-main">
          <Card className="detail-hero">
            <div className="lb" style={{ padding: 0 }}>
              Current streak
            </div>
            <div className="big detail-streak"><RollingText text={fmt.duration(metrics.currentStreakMs)} /></div>
            <p className="detail-recognition">{recognition.headline}</p>
            {recognition.accumulated ? <p className="sub">{recognition.accumulated}</p> : null}
            <div className="detail-record-actions">
              <Button onClick={() => setLogKind('urge')}>Log urge</Button>
              <Button variant="primary" onClick={() => setLogKind('lapse')}>
                Record lapse
              </Button>
            </div>
            <StreakBar
              intervals={metrics.intervals}
              className="detail-streakbar"
              ariaLabel="Abstinence periods for this tracker, oldest first, with lapse markers"
            />
          </Card>

          <section className="detail-stats" aria-label="Tracker statistics">
            <StatTile label="Longest" value={fmt.duration(metrics.longestStreakMs)} hint="Best run" />
            <StatTile label="Accumulated" value={fmt.duration(metrics.accumulatedAbstinenceMs)} hint="Active time only" />
            <StatTile label="Lapses" value={metrics.lapseCount} hint="Recorded" />
            <StatTile label="Since start" value={fmt.duration(metrics.elapsedSinceStartMs)} hint="Wall-clock time" />
            <StatTile
              label="Avg between lapses"
              value={metrics.averageBetweenLapsesMs === null ? '—' : fmt.duration(metrics.averageBetweenLapsesMs)}
              hint={metrics.averageBetweenLapsesMs === null ? 'Needs two lapses' : 'Between lapses'}
            />
            <StatTile
              label="Median between"
              value={metrics.medianBetweenLapsesMs === null ? '—' : fmt.duration(metrics.medianBetweenLapsesMs)}
              hint={metrics.medianBetweenLapsesMs === null ? 'Needs two lapses' : 'Between lapses'}
            />
            <StatTile label="Urges recorded" value={metrics.urgeCount} hint="Logged" />
            <StatTile label="Abstinent share" value={share} hint="Active ÷ elapsed" />
          </section>
          <p className="tiny detail-note">
            Accumulated counts uninterrupted, non-paused time only — it is not the same as elapsed time since you
            started. Paused time is never counted.
          </p>

          <div className="detail-charts">
            <div className="chart-card">
              <div className="chart-head">
                <span className="chart-title">Lapses per month</span>
                <span className="chart-n">n = {analytics?.metrics.lapseCount ?? metrics.lapseCount}</span>
              </div>
              <BarChart
                data={lapseChart}
                tone="lapse"
                ariaLabel="Lapses recorded per month over the last six months"
                emptyText="No monthly data yet."
              />
            </div>
            <div className="chart-card">
              <div className="chart-head">
                <span className="chart-title">Avg urge intensity</span>
                <span className="chart-n">n = {analytics?.metrics.urgeCount ?? metrics.urgeCount}</span>
              </div>
              <BarChart
                data={urgeChart}
                tone="urge"
                max={10}
                ariaLabel="Average urge intensity per month over the last six months, out of ten"
                emptyText="No urges recorded yet."
              />
            </div>
          </div>
        </div>

        <section className="activity-panel" aria-labelledby="activity-title">
          <div className="activity-head">
            <h2 className="h2" id="activity-title">
              Activity
            </h2>
          </div>
          <Input
            type="search"
            value={search}
            placeholder="Search history"
            aria-label="Search activity"
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="chips" role="group" aria-label="Filter activity">
            {ACTIVITY_FILTERS.map((option) => (
              <Chip key={option.value} selected={filter === option.value} onClick={() => setFilter(option.value)}>
                {option.label}
              </Chip>
            ))}
          </div>

          <div className="sr-only" role="status">
            {activity.length} activity record{activity.length === 1 ? '' : 's'} shown
          </div>

          <div className="timeline">
            {activity.map((item) => {
              const record = editableRecord(item);
              const content = (
                <>
                  <span className={`dot timeline-dot ${itemDotTone(item)}`.trim()} aria-hidden="true" />
                  <span className="timeline-main">
                    <span className="timeline-title">
                      <span>{item.title}</span>
                      <span className="timeline-date" title={fmt.dateTime(item.event.occurredAt)}>
                        {relativeDayLabel(fmt.relative(item.event.occurredAt))}
                      </span>
                    </span>
                    {item.detail ? <span className="timeline-detail">{item.detail}</span> : null}
                  </span>
                </>
              );
              return record ? (
                <button
                  key={item.event.id}
                  type="button"
                  className="timeline-item editable"
                  onClick={() => setEditRecord(record)}
                  aria-label={`Edit ${item.title} from ${fmt.dateTime(item.event.occurredAt)}`}
                >
                  {content}
                </button>
              ) : (
                <div key={item.event.id} className="timeline-item">
                  {content}
                </div>
              );
            })}
          </div>

          {activity.length === 0 ? <p className="activity-empty">{emptyActivity}</p> : null}
          <p className="activity-note">Everything here comes from your own records on this device.</p>
        </section>
      </div>

      {editOpen ? (
        <TrackerSheet
          open
          tracker={tracker}
          onClose={() => setEditOpen(false)}
          onSaved={() => setEditOpen(false)}
        />
      ) : null}
      {logKind ? (
        <RecordSheet
          open
          initialKind={logKind}
          defaultTrackerId={tracker.id}
          onClose={() => setLogKind(null)}
        />
      ) : null}
      {editRecord ? (
        <RecordSheet open edit={editRecord} onClose={() => setEditRecord(null)} />
      ) : null}
    </main>
  );
}
