/**
 * Journal screen: the chronological record of everything that happened, plus
 * a writer for journal entries.
 *
 * The timeline is built from `core.history` (the append-only activity log), so
 * lapses, urges, check-ins, journal entries and tracker lifecycle events all
 * appear in the order they occurred. Counting, filtering and pagination also
 * happen in the core; this screen never invents or reorders records.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  isDeUrgeError,
  localDateKey,
  userMessage,
  type HistoryEventType,
  type HistoryFilter,
  type HistoryItem,
  type JournalEntry,
} from '@deurge/core';
import { useApp } from '../../store/app';
import { navigate, useRoute } from '../../router';
import {
  Button,
  Chip,
  EmptyState,
  Field,
  Input,
  Select,
} from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { HistoryDetailSheet } from './HistoryDetailSheet';
import { JournalEntrySheet } from './JournalEntrySheet';
import { dayHeaderLabel, startOfLocalDateKeyMs } from './time';
import './journal.css';

type FilterKey = 'all' | 'lapse' | 'urge' | 'journal' | 'checkin' | 'lifecycle';

interface TypeFilter {
  value: FilterKey;
  label: string;
  /** null means "no type filter". */
  types: HistoryEventType[] | null;
}

/** Every form of user record and tracker lifecycle event (no settings noise). */
const ALL_RECORD_TYPES: HistoryEventType[] = [
  'tracker_created',
  'tracker_started',
  'tracker_updated',
  'tracker_paused',
  'tracker_resumed',
  'tracker_archived',
  'tracker_restored',
  'tracker_deleted',
  'lapse_recorded',
  'lapse_updated',
  'lapse_deleted',
  'urge_recorded',
  'urge_updated',
  'urge_deleted',
  'journal_entry_created',
  'journal_entry_updated',
  'journal_entry_deleted',
  'checkin_recorded',
  'checkin_deleted',
];

const TYPE_FILTERS: TypeFilter[] = [
  { value: 'all', label: 'All', types: ALL_RECORD_TYPES },
  { value: 'lapse', label: 'Lapses', types: ['lapse_recorded', 'lapse_updated', 'lapse_deleted'] },
  { value: 'urge', label: 'Urges', types: ['urge_recorded', 'urge_updated', 'urge_deleted'] },
  { value: 'journal', label: 'Notes', types: ['journal_entry_created', 'journal_entry_updated', 'journal_entry_deleted'] },
  { value: 'checkin', label: 'Check-ins', types: ['checkin_recorded', 'checkin_deleted'] },
  {
    value: 'lifecycle',
    label: 'Lifecycle',
    types: [
      'tracker_created',
      'tracker_started',
      'tracker_updated',
      'tracker_paused',
      'tracker_resumed',
      'tracker_archived',
      'tracker_restored',
      'tracker_deleted',
    ],
  },
];

function dotClassFor(item: HistoryItem): string {
  switch (item.refType) {
    case 'lapse':
      return 'dot lapse';
    case 'urge':
      return 'dot urge';
    case 'journal':
      return 'dot journal';
    case 'checkin':
      return 'dot';
  }
  return item.event.type.startsWith('tracker_') ? 'dot' : 'dot paused';
}

export function JournalScreen() {
  const app = useApp();
  const fmt = useFormatters();
  const route = useRoute();

  const trackers = useMemo(() => app.core.trackers.list(), [app.core, app.version]);

  const [typeFilter, setTypeFilter] = useState<FilterKey>('all');
  const [trackerFilter, setTrackerFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pageSize, setPageSize] = useState(25);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
  const [detailItem, setDetailItem] = useState<HistoryItem | null>(null);

  // Deep link from Insights/empty states: /journal?new=1 opens the editor once.
  useEffect(() => {
    if (route.name === 'journal' && route.query.get('new') !== null) {
      setEditingEntry(null);
      setEditorOpen(true);
      navigate('/journal');
    }
  }, [route]);

  // A deleted tracker can no longer be filtered by; fall back to "All".
  useEffect(() => {
    if (trackerFilter !== 'all' && !trackers.some((tracker) => tracker.id === trackerFilter)) {
      setTrackerFilter('all');
    }
  }, [trackerFilter, trackers]);

  const { filter, rangeInvalid } = useMemo(() => {
    const types = TYPE_FILTERS.find((entry) => entry.value === typeFilter)?.types ?? null;
    const fromMs = fromDate ? startOfLocalDateKeyMs(fromDate, app.timeZone) : null;
    const toMs = toDate ? startOfLocalDateKeyMs(toDate, app.timeZone, 1) : null;
    const invalid = fromMs !== null && toMs !== null && fromMs >= toMs;
    const next: HistoryFilter = { limit: pageSize, offset: 0 };
    if (trackerFilter !== 'all') next.trackerId = trackerFilter;
    if (types) next.types = types;
    if (!invalid && fromMs !== null) next.from = fromMs;
    if (!invalid && toMs !== null) next.to = toMs;
    const term = search.trim();
    if (term) next.search = term;
    return { filter: next, rangeInvalid: invalid };
  }, [typeFilter, trackerFilter, fromDate, toDate, search, pageSize, app.timeZone]);

  const { items, total, error } = useMemo(() => {
    try {
      const list = app.core.history.list(filter);
      const count = app.core.history.count(filter);
      return { items: list, total: count, error: null as string | null };
    } catch (caught) {
      return {
        items: [] as HistoryItem[],
        total: 0,
        error: isDeUrgeError(caught)
          ? userMessage(caught)
          : 'Your history could not be read. Your data is still on this device.',
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.core, app.version, filter]);

  const groups = useMemo(() => {
    const byDay = new Map<string, HistoryItem[]>();
    for (const item of items) {
      const key = localDateKey(item.event.occurredAt, app.timeZone);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(item);
      else byDay.set(key, [item]);
    }
    return [...byDay.values()];
  }, [items, app.timeZone]);

  const hasFilters = typeFilter !== 'all' || trackerFilter !== 'all' || search.trim() !== '' || fromDate !== '' || toDate !== '';
  const totalLabel = total >= 500 ? '500+' : String(total);
  const shown = items.length;

  const resetFilters = () => {
    setTypeFilter('all');
    setTrackerFilter('all');
    setSearch('');
    setFromDate('');
    setToDate('');
    setPageSize(25);
  };

  const openNewEntry = () => {
    setEditingEntry(null);
    setEditorOpen(true);
  };

  return (
    <main className="screen">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Journal</h1>
          <div className="sub">
            {hasFilters ? `${totalLabel} matching events` : `${totalLabel} events recorded`}
          </div>
        </div>
        <Button size="sm" variant="primary" icon="plus" onClick={openNewEntry}>
          New entry
        </Button>
      </div>

      <div className="journal-filters">
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPageSize(25);
          }}
          placeholder="Search your history"
          aria-label="Search your history"
        />

        <div className="journal-chips" role="group" aria-label="Event type">
          {TYPE_FILTERS.map((entry) => (
            <Chip
              key={entry.value}
              selected={typeFilter === entry.value}
              onClick={() => {
                setTypeFilter(entry.value);
                setPageSize(25);
              }}
            >
              {entry.label}
            </Chip>
          ))}
        </div>

        <div className="journal-filter-row">
          <Field label="Tracker">
            <Select
              value={trackerFilter}
              onChange={(event) => {
                setTrackerFilter(event.target.value);
                setPageSize(25);
              }}
              aria-label="Filter by tracker"
            >
              <option value="all">All trackers</option>
              {trackers.map((tracker) => (
                <option key={tracker.id} value={tracker.id}>
                  {tracker.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" error={rangeInvalid ? 'Start date is after the end date.' : undefined}>
            <Input
              type="date"
              value={fromDate}
              onChange={(event) => {
                setFromDate(event.target.value);
                setPageSize(25);
              }}
              aria-label="From date"
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={toDate}
              onChange={(event) => {
                setToDate(event.target.value);
                setPageSize(25);
              }}
              aria-label="To date"
            />
          </Field>
        </div>

        {hasFilters ? (
          <div className="row">
            <span className="tiny">
              Filters apply to this timeline only; nothing is deleted or changed.
            </span>
            <Button size="sm" onClick={resetFilters}>
              Clear filters
            </Button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="notice error" role="alert" style={{ marginTop: 16 }}>
          {error}
        </div>
      ) : null}

      {!error && total === 0 && !hasFilters ? (
        <EmptyState
          title="Your history starts here"
          body="Write a journal entry, or record a lapse or urge from a tracker. Every record appears here in chronological order — nothing is ever hidden or rewritten."
          action={
            <div className="row-start" style={{ justifyContent: 'center' }}>
              <Button variant="primary" icon="plus" onClick={openNewEntry}>
                Write an entry
              </Button>
              <Button onClick={() => navigate('/trackers')}>Go to trackers</Button>
            </div>
          }
        />
      ) : null}

      {!error && total === 0 && hasFilters ? (
        <EmptyState
          title="No matching records"
          body="Nothing in your history matches these filters. Nothing has been removed — try a different tracker, event type or date range."
          action={<Button onClick={resetFilters}>Clear filters</Button>}
        />
      ) : null}

      {groups.map((group) => (
        <section className="journal-day" key={group[0]?.event.id ?? group[0]?.event.occurredAt}>
          <h2 className="journal-day-heading">
            {dayHeaderLabel(group[0]?.event.occurredAt ?? app.now, app.now, app.timeZone, app.settings.dateFormat)}
          </h2>
          <div className="card journal-day-card">
            {group.map((item) => {
              const trackerName = item.trackerName;
              const detail = item.detail && item.detail !== trackerName ? item.detail : null;
              return (
                <button
                  type="button"
                  className="timeline-item"
                  key={item.event.id}
                  onClick={() => setDetailItem(item)}
                  title={`Open ${item.title}`}
                >
                  <span className={dotClassFor(item)} aria-hidden="true" style={{ marginTop: 7 }} />
                  <span className="timeline-main">
                    <span className="timeline-title">
                      <span>{item.title}</span>
                      <span className="timeline-date">{fmt.time(item.event.occurredAt)}</span>
                    </span>
                    {trackerName || detail ? (
                      <span className="timeline-detail">
                        {trackerName ? <span className="journal-tracker-tag">{trackerName}</span> : null}
                        {trackerName && detail ? ' · ' : null}
                        {detail ?? ''}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {!error && shown > 0 && shown < total ? (
        <div className="stack-sm" style={{ alignItems: 'center', marginTop: 16 }}>
          <Button block onClick={() => setPageSize((size) => size + 25)}>
            Load more
          </Button>
          <span className="tiny">
            Showing {shown} of {totalLabel} events
          </span>
        </div>
      ) : null}

      {!error && total >= 500 && shown >= 500 ? (
        <div className="tiny" style={{ textAlign: 'center', marginTop: 16 }}>
          Showing the most recent 500 matching events. Narrow the filters — for example by tracker or date range — to reach
          older records.
        </div>
      ) : !error && total > 0 && shown >= total && total > 25 ? (
        <div className="tiny" style={{ textAlign: 'center', marginTop: 16 }}>
          All {totalLabel} matching events are shown.
        </div>
      ) : null}

      <JournalEntrySheet
        open={editorOpen}
        entry={editingEntry}
        defaultTrackerId={trackerFilter !== 'all' ? trackerFilter : null}
        onClose={() => {
          setEditorOpen(false);
          setEditingEntry(null);
        }}
      />

      <HistoryDetailSheet
        item={detailItem}
        onClose={() => setDetailItem(null)}
        onEditJournal={(entry) => {
          setDetailItem(null);
          setEditingEntry(entry);
          setEditorOpen(true);
        }}
        onOpenTracker={(trackerId) => {
          setDetailItem(null);
          navigate(`/tracker/${trackerId}`);
        }}
      />

    </main>
  );
}
