/**
 * Record sheet — the one place a lapse or an urge is written.
 *
 * It is intentionally a standalone, reusable component: the tracker detail
 * screen opens it for "Log urge"/"Record lapse" and for editing an existing
 * timeline entry, and the journal/settings features can mount the same sheet.
 *
 * Copy rules: a lapse never erases earlier progress, an urge never resets a
 * streak. Errors are shown inside the sheet and the sheet stays open until the
 * write succeeds.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isTyagError, userMessage, type LapseEvent, type Tracker, type UrgeEvent, type UrgeOutcome } from '@tyag/core';
import { useApp } from '../../store/app';
import {
  Button,
  ConfirmDialog,
  Field,
  Icon,
  Input,
  ListGroup,
  ListRow,
  Segmented,
  Select,
  Sheet,
  Textarea,
  useToast,
} from '../../ui/components';
import { fromDateTimeLocalValue, toDateTimeLocalValue } from './localDateTime';
import './record.css';

export type RecordKind = 'lapse' | 'urge';

export interface RecordSheetProps {
  open: boolean;
  onClose: () => void;
  /** Tracker pre-selected when recording a new event. */
  defaultTrackerId?: string;
  /** Which kind of event the sheet should start on. Defaults to lapse. */
  initialKind?: RecordKind;
  /** Edit an existing event instead of creating a new one. */
  edit?: { kind: RecordKind; id: string };
  /** Called after a successful create/update/delete, before `onClose`. */
  onSaved?: () => void;
}

export function RecordSheet({ open, onClose, defaultTrackerId, initialKind, edit, onSaved }: RecordSheetProps) {
  if (!open) return null;
  return (
    <RecordSheetDialog
      key={`${edit?.kind ?? initialKind ?? 'lapse'}:${edit?.id ?? defaultTrackerId ?? 'new'}`}
      onClose={onClose}
      defaultTrackerId={defaultTrackerId}
      initialKind={initialKind}
      edit={edit}
      onSaved={onSaved}
    />
  );
}

const FORM_ID = 'tyag-record-form';

const INTENSITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const OUTCOME_OPTIONS: { value: UrgeOutcome; label: string }[] = [
  { value: 'passed', label: 'Passed without a lapse' },
  { value: 'lapse', label: 'Led to a lapse' },
  { value: 'unknown', label: 'Prefer not to say' },
];

function RecordSheetDialog({
  onClose,
  defaultTrackerId,
  initialKind,
  edit,
  onSaved,
}: Omit<RecordSheetProps, 'open'>) {
  const app = useApp();
  const toast = useToast();
  const timeZone = app.timeZone;

  // The existing record (edit mode). A deleted record simply resolves to null
  // and the sheet explains that instead of crashing.
  const existing = useMemo(() => {
    if (!edit) return null;
    try {
      return edit.kind === 'lapse' ? app.core.lapses.get(edit.id) : app.core.urges.get(edit.id);
    } catch {
      return null;
    }
  }, [app.core, edit]);

  const trackers = useMemo(() => app.core.trackers.list(), [app.core, app.version]);
  const triggerCategories = useMemo(() => app.core.categories.list('trigger'), [app.core, app.version]);

  const [kind, setKind] = useState<RecordKind>(() => edit?.kind ?? initialKind ?? 'lapse');
  const lapseExisting: LapseEvent | null = edit?.kind === 'lapse' ? (existing as LapseEvent | null) : null;
  const urgeExisting: UrgeEvent | null = edit?.kind === 'urge' ? (existing as UrgeEvent | null) : null;

  const [trackerId, setTrackerId] = useState<string>(() => {
    const preferred = existing?.trackerId ?? defaultTrackerId;
    if (preferred && trackers.some((tracker) => tracker.id === preferred)) return preferred;
    return trackers.find((tracker) => tracker.status === 'active')?.id ?? trackers[0]?.id ?? '';
  });
  const [initialWhen] = useState(() => toDateTimeLocalValue(existing?.occurredAt ?? app.now, timeZone));
  const [when, setWhen] = useState(initialWhen);
  const [triggerCategoryId, setTriggerCategoryId] = useState<string | null>(() => {
    if (existing) return existing.triggerCategoryId;
    const preferred = app.settings.defaultTriggerCategoryIds;
    return preferred.find((id) => triggerCategories.some((category) => category.id === id)) ?? null;
  });
  const [reason, setReason] = useState(lapseExisting?.reason ?? '');
  const [context, setContext] = useState(existing?.context ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [intensity, setIntensity] = useState(urgeExisting?.intensity ?? 5);
  const [initialDuration] = useState(() =>
    urgeExisting?.durationSeconds != null ? String(Math.round(urgeExisting.durationSeconds / 60)) : '',
  );
  const [durationMinutes, setDurationMinutes] = useState(initialDuration);
  const [outcome, setOutcome] = useState<UrgeOutcome>(urgeExisting?.outcome ?? 'passed');
  const [error, setError] = useState<string | null>(null);
  const [whenError, setWhenError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Move focus into the sheet, and put it back where it came from on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => document.getElementById('record-when')?.focus(), 60);
    return () => {
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, []);

  const kindLabel = kind === 'lapse' ? 'Lapse' : 'Urge';
  const title = edit ? `Edit ${kindLabel}` : `New ${kindLabel}`;
  const maxWhen = toDateTimeLocalValue(app.now, timeZone);
  const activeTracker: Tracker | null = trackers.find((tracker) => tracker.id === trackerId) ?? null;

  function toggleTrigger(id: string): void {
    setTriggerCategoryId((current) => (current === id ? null : id));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setError(null);
    setWhenError(null);

    if (!trackerId) {
      setError('Create a tracker first, then record events against it.');
      return;
    }

    const occurredAtChanged = when !== initialWhen;
    let occurredAt: number | undefined;
    if (occurredAtChanged) {
      const parsed = fromDateTimeLocalValue(when, timeZone);
      if (parsed === null) {
        setWhenError('Choose a valid date and time.');
        return;
      }
      if (parsed > app.now + 5 * 60_000) {
        setWhenError('That time is in the future. Choose a time that has already happened.');
        return;
      }
      if (activeTracker && parsed < activeTracker.startedAt) {
        setWhenError('That time is before this tracker started. Edit its start date first.');
        return;
      }
      occurredAt = parsed;
    }

    let durationSeconds: number | null | undefined;
    if (kind === 'urge' && durationMinutes !== initialDuration) {
      const trimmed = durationMinutes.trim();
      if (trimmed !== '') {
        const minutes = Number(trimmed);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 10_080 || !Number.isInteger(minutes)) {
          setError('Urge duration must be a whole number of minutes between 0 and 10,080 (7 days).');
          return;
        }
        durationSeconds = minutes * 60;
      } else {
        durationSeconds = null;
      }
    }

    setSaving(true);
    try {
      if (edit) {
        if (kind === 'lapse') {
          await app.core.lapses.update(edit.id, {
            ...(occurredAt !== undefined ? { occurredAt, occurredTimeZone: timeZone } : {}),
            reason,
            context,
            notes,
            triggerCategoryId,
            ...(triggerCategoryId ? {} : { trigger: null }),
          });
        } else {
          await app.core.urges.update(edit.id, {
            ...(occurredAt !== undefined ? { occurredAt, occurredTimeZone: timeZone } : {}),
            intensity,
            ...(durationSeconds !== undefined ? { durationSeconds } : {}),
            context,
            notes,
            outcome,
            triggerCategoryId,
            ...(triggerCategoryId ? {} : { trigger: null }),
          });
        }
      } else if (kind === 'lapse') {
        await app.core.lapses.create({
          trackerId,
          ...(occurredAt !== undefined ? { occurredAt, occurredTimeZone: timeZone } : {}),
          reason,
          context,
          notes,
          triggerCategoryId,
        });
      } else {
        await app.core.urges.create({
          trackerId,
          ...(occurredAt !== undefined ? { occurredAt, occurredTimeZone: timeZone } : {}),
          intensity,
          durationSeconds: durationSeconds ?? null,
          context,
          notes,
          outcome,
          triggerCategoryId,
        });
      }

      app.refresh();
      if (edit) {
        toast.show(`${kindLabel} updated.`);
      } else if (kind === 'lapse') {
        toast.show('Lapse recorded. Earlier progress stays in your history.');
      } else {
        toast.show('Urge logged. An urge never resets your streak.');
      }
      onSaved?.();
      onClose();
    } catch (writeError) {
      setError(userMessage(writeError));
      if (isTyagError(writeError) && writeError.details['occurredAt']) {
        setWhenError(userMessage(writeError));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!edit || saving) return;
    setConfirmDelete(false);
    setSaving(true);
    setError(null);
    try {
      if (edit.kind === 'lapse') await app.core.lapses.delete(edit.id);
      else await app.core.urges.delete(edit.id);
      app.refresh();
      toast.show(`${kindLabel} deleted. Your remaining history is unchanged.`);
      onSaved?.();
      onClose();
    } catch (deleteError) {
      setError(userMessage(deleteError));
    } finally {
      setSaving(false);
    }
  }

  const headerLeft = (
    <Button variant="plain" onClick={onClose} disabled={saving}>
      Cancel
    </Button>
  );

  if (edit && !existing) {
    return (
      <Sheet open onClose={onClose} title="Record not found" left={headerLeft}>
        <div className="notice error" role="alert">
          That record could not be found. It may have been deleted from another screen.
        </div>
      </Sheet>
    );
  }

  if (trackers.length === 0) {
    return (
      <Sheet open onClose={onClose} title={title} left={headerLeft}>
        <div className="notice" role="status">
          You need a tracker before you can record a lapse or an urge. Create one from the Trackers screen — it only
          takes a name and a start time.
        </div>
      </Sheet>
    );
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={title}
        left={headerLeft}
        right={
          <Button variant="plain" type="submit" form={FORM_ID} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        }
      >
        <form id={FORM_ID} className="sheet-form record-form stack" onSubmit={handleSubmit} noValidate>
          {error ? (
            <div className="notice error" role="alert">
              {error}
            </div>
          ) : null}

          {edit ? null : (
            <Segmented
              className="record-type"
              ariaLabel="Record a lapse or urge"
              value={kind}
              onChange={(nextKind) => setKind(nextKind)}
              options={[
                { value: 'lapse', label: 'Lapse' },
                { value: 'urge', label: 'Urge' },
              ]}
            />
          )}

          <Field label="When" htmlFor="record-when" error={whenError}>
            <Input
              id="record-when"
              type="datetime-local"
              value={when}
              max={maxWhen}
              onChange={(event) => setWhen(event.target.value)}
            />
          </Field>

          <Field label="Tracker" htmlFor="record-tracker">
            <Select
              id="record-tracker"
              value={trackerId}
              disabled={Boolean(edit)}
              onChange={(event) => setTrackerId(event.target.value)}
            >
              {trackers.map((tracker) => (
                <option key={tracker.id} value={tracker.id}>
                  {tracker.name}
                </option>
              ))}
            </Select>
          </Field>

          <p className="record-helper">
            {kind === 'lapse'
              ? 'This ends the current streak at the time you choose. Earlier progress stays in your history.'
              : 'An urge never resets your streak. Recording one adds context to the progress you are already making.'}
          </p>

          {activeTracker && activeTracker.status !== 'active' ? (
            <p className="field-hint">
              This tracker is {activeTracker.status}. Paused time is not counted toward any streak.
            </p>
          ) : null}

          {kind === 'urge' ? (
            <>
              <div className="record-section">
                <div className="lb" style={{ padding: 0 }} id="record-intensity-label">
                  Intensity
                </div>
                <div className="intensity-grid" role="group" aria-labelledby="record-intensity-label">
                  {INTENSITIES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={intensity === value ? 'on' : ''}
                      aria-pressed={intensity === value}
                      aria-label={`Intensity ${value} of 10`}
                      onClick={() => setIntensity(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <div className="field-hint">1 = mild, 10 = overwhelming.</div>
              </div>

              <Field
                label="How long? (minutes, optional)"
                htmlFor="record-duration"
                hint="Optional. Leave blank if unsure."
              >
                <Input
                  id="record-duration"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={10_080}
                  step={1}
                  value={durationMinutes}
                  placeholder="e.g. 15"
                  onChange={(event) => setDurationMinutes(event.target.value)}
                />
              </Field>
            </>
          ) : null}

          <div className="record-section">
            <div className="lb" style={{ padding: 0 }}>
              Trigger
            </div>
            {triggerCategories.length === 0 ? (
              <p className="field-hint">No trigger categories yet. You can add them in Settings.</p>
            ) : (
              <ListGroup className="record-trigger-list" role="group" aria-label="Trigger">
                {triggerCategories.map((category) => {
                  const selected = triggerCategoryId === category.id;
                  return (
                    <ListRow
                      key={category.id}
                      label={category.name}
                      selected={selected}
                      onClick={() => toggleTrigger(category.id)}
                      trailing={
                        selected ? <Icon name="check" size={18} className="check" /> : undefined
                      }
                    />
                  );
                })}
              </ListGroup>
            )}
            <div className="field-hint">Optional. Tap a trigger to select it; tap again to clear.</div>
          </div>

          {kind === 'lapse' ? (
            <>
              <Field label="Reason (optional)" htmlFor="record-reason">
                <Input
                  id="record-reason"
                  value={reason}
                  maxLength={300}
                  placeholder="What led to it? (optional)"
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <Field label="Context (optional)" htmlFor="record-context">
                <Input
                  id="record-context"
                  value={context}
                  maxLength={200}
                  placeholder="Where were you? (optional)"
                  onChange={(event) => setContext(event.target.value)}
                />
              </Field>
            </>
          ) : (
            <div className="record-section">
              <div className="lb" style={{ padding: 0 }}>
                Outcome
              </div>
              <ListGroup role="group" aria-label="Outcome">
                {OUTCOME_OPTIONS.map((option) => {
                  const selected = outcome === option.value;
                  return (
                    <ListRow
                      key={option.value}
                      label={option.label}
                      selected={selected}
                      onClick={() => setOutcome(option.value)}
                      trailing={selected ? <Icon name="check" size={18} className="check" /> : undefined}
                    />
                  );
                })}
              </ListGroup>
            </div>
          )}

          <Field label="Notes (optional)" htmlFor="record-notes">
            <Textarea
              id="record-notes"
              value={notes}
              maxLength={10_000}
              placeholder="What happened? (optional)"
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>

          {edit ? (
            <div className="record-actions">
              <Button
                variant="danger"
                type="button"
                disabled={saving}
                onClick={() => setConfirmDelete(true)}
              >
                Delete {kindLabel.toLowerCase()}
              </Button>
            </div>
          ) : null}
        </form>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete this ${kindLabel.toLowerCase()}?`}
        body={`This permanently removes the record from your history. Streaks and statistics are recalculated from your remaining records — nothing else is changed.`}
        confirmLabel={`Delete ${kindLabel.toLowerCase()}`}
        tone="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
