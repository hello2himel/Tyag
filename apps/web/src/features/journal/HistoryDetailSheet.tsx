/**
 * Detail sheet for one history record (journal entry, lapse, urge, check-in or
 * a lifecycle/system event). Read-only records are described honestly; journal
 * entries and check-ins can be deleted, journal entries can be edited.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  isDeUrgeError,
  userMessage,
  type CheckIn,
  type HistoryItem,
  type JournalEntry,
  type LapseEvent,
  type UrgeEvent,
} from '@deurge/core';
import { useApp } from '../../store/app';
import { Button, ConfirmDialog, Sheet, useToast } from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { RecordSheet } from '../record/RecordSheet';

type Loaded =
  | { kind: 'journal'; entry: JournalEntry }
  | { kind: 'lapse'; lapse: LapseEvent }
  | { kind: 'urge'; urge: UrgeEvent }
  | { kind: 'checkin'; checkIn: CheckIn }
  | { kind: 'missing' };

const URGE_OUTCOME_LABEL: Record<string, string> = {
  passed: 'Passed without a lapse',
  lapse: 'Led to a lapse',
  unknown: 'Outcome not recorded',
};

export function HistoryDetailSheet({
  item,
  onClose,
  onEditJournal,
  onOpenTracker,
}: {
  item: HistoryItem | null;
  onClose: () => void;
  onEditJournal: (entry: JournalEntry) => void;
  onOpenTracker: (trackerId: string) => void;
}) {
  const app = useApp();
  const toast = useToast();
  const fmt = useFormatters();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingRecord, setEditingRecord] = useState<'lapse' | 'urge' | null>(null);

  const refreshKey = app.version;
  useEffect(() => {
    setLoaded(null);
    setLoadError(null);
    setConfirmDelete(false);
    setEditingRecord(null);
    if (!item) return;
    try {
      if (item.refType === 'journal' && item.event.refId) {
        setLoaded({ kind: 'journal', entry: app.core.journal.get(item.event.refId) });
      } else if (item.refType === 'lapse' && item.event.refId) {
        setLoaded({ kind: 'lapse', lapse: app.core.lapses.get(item.event.refId) });
      } else if (item.refType === 'urge' && item.event.refId) {
        setLoaded({ kind: 'urge', urge: app.core.urges.get(item.event.refId) });
      } else if (item.refType === 'checkin' && item.event.refId) {
        const checkIn = app.core.checkIns.list().find((candidate) => candidate.id === item.event.refId);
        setLoaded(checkIn ? { kind: 'checkin', checkIn } : { kind: 'missing' });
      } else {
        setLoaded({ kind: 'missing' });
      }
    } catch (error) {
      setLoadError(isDeUrgeError(error) ? userMessage(error) : 'This record could not be opened.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, refreshKey]);

  const trackers = useMemo(() => app.core.trackers.list(), [app.core, app.version]);
  const trackerName = useMemo(() => {
    if (!item?.event.trackerId) return null;
    return trackers.find((tracker) => tracker.id === item.event.trackerId)?.name ?? null;
  }, [item, trackers]);

  if (!item) return null;

  const occurredAt = item.event.occurredAt;
  const trackerId = item.event.trackerId;

  const remove = async () => {
    if (deleting || !loaded) return;
    setDeleting(true);
    try {
      if (loaded.kind === 'journal') {
        await app.core.journal.delete(loaded.entry.id);
        toast.show('Journal entry deleted.');
      } else if (loaded.kind === 'checkin') {
        await app.core.checkIns.delete(loaded.checkIn.id);
        toast.show('Check-in deleted.');
      }
      app.refresh();
      setConfirmDelete(false);
      onClose();
    } catch (error) {
      toast.error(isDeUrgeError(error) ? userMessage(error) : 'That record could not be deleted.');
    } finally {
      setDeleting(false);
    }
  };

  const target = loaded?.kind === 'journal' ? 'journal entry' : loaded?.kind === 'checkin' ? 'check-in' : null;

  return (
    <>
      <Sheet
        open={item !== null && editingRecord === null}
        onClose={onClose}
        title={item.title}
        left={
          <Button variant="plain" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="journal-detail-meta">
          <span>{fmt.dateTime(occurredAt)}</span>
          <span aria-hidden="true">·</span>
          <span>{trackerName ?? 'Global journal'}</span>
        </div>

        {loadError ? (
          <div className="notice error" role="alert">
            {loadError}
          </div>
        ) : null}

        {loaded === null && !loadError ? <div className="tiny">Opening record…</div> : null}

        {loaded?.kind === 'journal' ? (
          <>
            {loaded.entry.title ? <div className="h2 journal-detail-title">{loaded.entry.title}</div> : null}
            <div className="journal-body">{loaded.entry.body}</div>
          </>
        ) : null}

        {loaded?.kind === 'lapse' ? (
          <div className="stack">
            <DetailRow label="Tracker" value={trackerName ?? 'Unknown tracker'} />
            <DetailRow label="Trigger" value={loaded.lapse.trigger ?? 'Not recorded'} />
            <DetailRow label="Reason" value={loaded.lapse.reason ?? 'Not recorded'} />
            <DetailRow label="Context" value={loaded.lapse.context ?? 'Not recorded'} />
            {loaded.lapse.description ? <DetailRow label="Description" value={loaded.lapse.description} /> : null}
            {loaded.lapse.notes ? <DetailRow label="Notes" value={loaded.lapse.notes} /> : null}
            <DetailRow label="Entered" value={loaded.lapse.retrospective ? 'Retrospectively' : 'When it happened'} />
            <div className="tiny">
              A lapse never erases earlier progress. The streak restarts and your accumulated time is kept.
            </div>
          </div>
        ) : null}

        {loaded?.kind === 'urge' ? (
          <div className="stack">
            <DetailRow label="Tracker" value={trackerName ?? 'Unknown tracker'} />
            <DetailRow label="Intensity" value={`${loaded.urge.intensity}/10`} />
            <DetailRow label="Outcome" value={URGE_OUTCOME_LABEL[loaded.urge.outcome] ?? loaded.urge.outcome} />
            <DetailRow
              label="Duration"
              value={loaded.urge.durationSeconds === null ? 'Not recorded' : fmt.duration(loaded.urge.durationSeconds * 1000)}
            />
            <DetailRow label="Trigger" value={loaded.urge.trigger ?? 'Not recorded'} />
            <DetailRow label="Context" value={loaded.urge.context ?? 'Not recorded'} />
            {loaded.urge.notes ? <DetailRow label="Notes" value={loaded.urge.notes} /> : null}
            <DetailRow label="Entered" value={loaded.urge.retrospective ? 'Retrospectively' : 'When it happened'} />
            <div className="tiny">Urges are recorded separately and never change your streak.</div>
          </div>
        ) : null}

        {loaded?.kind === 'checkin' ? (
          <div className="stack">
            <DetailRow label="Mood" value={loaded.checkIn.mood === null ? 'Not recorded' : `${loaded.checkIn.mood}/5`} />
            <DetailRow label="Note" value={loaded.checkIn.note ?? 'No note'} />
          </div>
        ) : null}

        {loaded?.kind === 'missing' ? (
          <div className="notice">
            {item.refType === null
              ? 'This happened. The underlying record has since been deleted, so only the activity entry remains.'
              : 'This record could not be found. It may have been deleted.'}
          </div>
        ) : null}

        <div className="row-start journal-detail-actions">
          {loaded?.kind === 'journal' ? (
            <Button icon="edit" onClick={() => onEditJournal(loaded.entry)}>
              Edit
            </Button>
          ) : null}
          {loaded?.kind === 'lapse' || loaded?.kind === 'urge' ? (
            <Button icon="edit" onClick={() => setEditingRecord(loaded.kind)}>
              Edit
            </Button>
          ) : null}
          {loaded?.kind === 'journal' || loaded?.kind === 'checkin' ? (
            <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} disabled={deleting}>
              Delete
            </Button>
          ) : null}
          {trackerId && trackers.some((tracker) => tracker.id === trackerId) ? (
            <Button icon="chevron-right" onClick={() => onOpenTracker(trackerId)}>
              Open tracker
            </Button>
          ) : null}
        </div>
      </Sheet>

      {editingRecord !== null && item.event.refId ? (
        <RecordSheet
          open
          edit={{ kind: editingRecord, id: item.event.refId }}
          onClose={() => setEditingRecord(null)}
          onSaved={() => {
            app.refresh();
            setEditingRecord(null);
            onClose();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete && target !== null}
        title={`Delete this ${target ?? 'record'}?`}
        body={
          <div>
            <p>
              The {target} will be removed and a “{target} deleted” activity entry will remain in your history.
            </p>
            <p style={{ marginTop: 8 }}>This cannot be undone. Your trackers and streak calculations are not changed.</p>
          </div>
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="journal-detail-row">
      <span className="journal-detail-label">{label}</span>
      <span className="journal-detail-value">{value}</span>
    </div>
  );
}
