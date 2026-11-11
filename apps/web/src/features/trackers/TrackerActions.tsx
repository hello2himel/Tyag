/**
 * Lifecycle actions for one tracker: pause/resume, archive/restore, delete.
 * Rendered on tracker cards (in edit mode) and in the tracker detail header.
 *
 * Status transitions are delegated entirely to the core services, the UI only
 * decides which action is offered for the current status. Dates/times in the
 * confirmations are intentionally explained in terms of the calculation rules
 * (paused time is never counted; archived history is kept).
 */
import { useState } from 'react';
import { userMessage, type Tracker } from '@tyag/core';
import { useApp } from '../../store/app';
import { Button, ConfirmDialog, useToast } from '../../ui/components';

export type TrackerActionKind = 'pause' | 'resume' | 'archive' | 'restore' | 'delete';

const ACTION_TOAST: Record<Exclude<TrackerActionKind, 'delete'>, string> = {
  pause: 'Tracker paused. Paused time is not counted.',
  resume: 'Tracker resumed. The streak continues from now.',
  archive: 'Tracker archived. Its history is kept.',
  restore: 'Tracker restored as paused. Resume whenever you are ready.',
};

export interface TrackerActionsProps {
  tracker: Tracker;
  onEdit?: () => void;
  onDeleted?: () => void;
  className?: string;
}

export function TrackerActions({ tracker, onEdit, onDeleted, className = '' }: TrackerActionsProps) {
  const app = useApp();
  const toast = useToast();
  const [pending, setPending] = useState<TrackerActionKind | null>(null);
  const [confirm, setConfirm] = useState<'pause' | 'archive' | 'delete' | null>(null);
  const busy = pending !== null;

  async function run(action: TrackerActionKind): Promise<void> {
    if (busy) return;
    setPending(action);
    try {
      switch (action) {
        case 'pause':
          await app.core.trackers.pause(tracker.id);
          break;
        case 'resume':
          await app.core.trackers.resume(tracker.id);
          break;
        case 'archive':
          await app.core.trackers.archive(tracker.id);
          break;
        case 'restore':
          await app.core.trackers.restore(tracker.id);
          break;
        case 'delete':
          await app.core.trackers.delete(tracker.id);
          break;
      }
      app.refresh();
      if (action === 'delete') {
        toast.show('Tracker deleted. Journal entries were kept.');
        onDeleted?.();
      } else {
        toast.show(ACTION_TOAST[action]);
      }
    } catch (writeError) {
      toast.error(userMessage(writeError));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={`tracker-actions ${className}`.trim()}>
      {onEdit ? (
        <Button size="sm" onClick={onEdit} disabled={busy}>
          Edit
        </Button>
      ) : null}
      {tracker.status === 'active' ? (
        <Button size="sm" onClick={() => setConfirm('pause')} disabled={busy}>
          Pause
        </Button>
      ) : null}
      {tracker.status === 'paused' ? (
        <Button size="sm" onClick={() => void run('resume')} disabled={busy}>
          Resume
        </Button>
      ) : null}
      {tracker.status === 'archived' ? (
        <Button size="sm" onClick={() => void run('restore')} disabled={busy}>
          Restore
        </Button>
      ) : null}
      {tracker.status !== 'archived' ? (
        <Button size="sm" onClick={() => setConfirm('archive')} disabled={busy}>
          Archive
        </Button>
      ) : null}
      <Button size="sm" variant="danger" onClick={() => setConfirm('delete')} disabled={busy}>
        Delete
      </Button>
      {pending ? (
        <span className="tiny" role="status">
          Saving…
        </span>
      ) : null}

      <ConfirmDialog
        open={confirm === 'pause'}
        title={`Pause ${tracker.name}?`}
        body={
          <>
            <p>Paused time is not counted toward any streak.</p>
            <p style={{ marginTop: 8 }}>
              Your accumulated progress stays exactly as it is. You can resume whenever you choose.
            </p>
          </>
        }
        confirmLabel="Pause tracker"
        onConfirm={() => {
          setConfirm(null);
          void run('pause');
        }}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'archive'}
        title={`Archive ${tracker.name}?`}
        body={
          <>
            <p>
              Archiving stops the clock. Everything you have recorded for this tracker stays on this device and its
              history remains readable.
            </p>
            <p style={{ marginTop: 8 }}>Restoring it later brings it back paused, so no time is counted in between.</p>
          </>
        }
        confirmLabel="Archive tracker"
        onConfirm={() => {
          setConfirm(null);
          void run('archive');
        }}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete this tracker permanently?"
        body={
          <>
            <p>
              <strong>{tracker.name}</strong> and its sessions, lapses, urges and activity history will be deleted.
              Journal entries and check-ins are kept.
            </p>
            <p style={{ marginTop: 8 }}>This cannot be undone. Export a backup first if you want a copy.</p>
          </>
        }
        confirmLabel="Delete tracker"
        tone="danger"
        requirePhrase="delete"
        onConfirm={() => {
          setConfirm(null);
          void run('delete');
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
