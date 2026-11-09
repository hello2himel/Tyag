/**
 * Create or edit a tracker.
 *
 * Kept local to the trackers feature (the shared `Sheet`/`Field` primitives do
 * the heavy lifting). Writes go through `core.trackers.create/update`; the
 * sheet stays open with an inline error if the core rejects the input.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isDeUrgeError, LIMITS, userMessage, type Tracker } from '@deurge/core';
import { useApp } from '../../store/app';
import { Button, Field, Input, Select, Sheet, Textarea, useToast } from '../../ui/components';
import { fromDateTimeLocalValue, toDateTimeLocalValue } from '../record/localDateTime';

const FORM_ID = 'deurge-tracker-form';

export interface TrackerSheetProps {
  open: boolean;
  /** When present the sheet edits this tracker; otherwise it creates one. */
  tracker: Tracker | null;
  onClose: () => void;
  onSaved: (tracker: Tracker, created: boolean) => void;
}

export function TrackerSheet({ open, tracker, onClose, onSaved }: TrackerSheetProps) {
  if (!open) return null;
  return <TrackerSheetDialog key={tracker?.id ?? 'new'} tracker={tracker} onClose={onClose} onSaved={onSaved} />;
}

function TrackerSheetDialog({ tracker, onClose, onSaved }: Omit<TrackerSheetProps, 'open'>) {
  const app = useApp();
  const toast = useToast();
  const timeZone = app.timeZone;
  const categories = useMemo(() => app.core.categories.list('tracker_category'), [app.core, app.version]);

  const [name, setName] = useState(tracker?.name ?? '');
  const [description, setDescription] = useState(tracker?.description ?? '');
  const [categoryId, setCategoryId] = useState(tracker?.categoryId ?? '');
  const [initialStart] = useState(() => toDateTimeLocalValue(tracker?.startedAt ?? app.now, timeZone));
  const [start, setStart] = useState(initialStart);
  const [reasons, setReasons] = useState(tracker?.reasons ?? '');
  const [notes, setNotes] = useState(tracker?.notes ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => document.getElementById('tracker-name')?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, []);

  const title = tracker ? 'Edit tracker' : 'New tracker';
  const maxStart = toDateTimeLocalValue(app.now, timeZone);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setNameError(null);
    setStartError(null);
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Give your tracker a name.');
      document.getElementById('tracker-name')?.focus();
      return;
    }

    let startedAt: number | undefined;
    if (start !== initialStart) {
      const parsed = fromDateTimeLocalValue(start, timeZone);
      if (parsed === null) {
        setStartError('Choose a valid start date and time.');
        return;
      }
      if (parsed > app.now + 5 * 60_000) {
        setStartError('The start time cannot be in the future.');
        return;
      }
      startedAt = parsed;
    }

    setSaving(true);
    try {
      const common = {
        name: trimmedName,
        description,
        categoryId: categoryId ? categoryId : null,
        reasons,
        notes,
        ...(startedAt !== undefined ? { startedAt, startedTimeZone: timeZone } : {}),
      };
      if (tracker) {
        const updated = await app.core.trackers.update(tracker.id, common);
        app.refresh();
        toast.show('Tracker updated.');
        onSaved(updated, false);
      } else {
        const created = await app.core.trackers.create(common);
        app.refresh();
        toast.show('Tracker created. Its streak starts at the time you chose.');
        onSaved(created, true);
      }
    } catch (writeError) {
      setError(userMessage(writeError));
      if (isDeUrgeError(writeError) && writeError.details['startedAt']) {
        setStartError(userMessage(writeError));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      left={
        <Button variant="plain" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      }
      right={
        <Button variant="plain" type="submit" form={FORM_ID} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      <form id={FORM_ID} className="sheet-form stack" onSubmit={handleSubmit} noValidate>
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}

        <Field label="Name" htmlFor="tracker-name" error={nameError}>
          <Input
            id="tracker-name"
            value={name}
            maxLength={LIMITS.trackerName}
            required
            autoComplete="off"
            placeholder="e.g. Social media"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Description (optional)" htmlFor="tracker-description">
          <Textarea
            id="tracker-description"
            value={description}
            maxLength={LIMITS.description}
            placeholder="What does this tracker mean for you?"
            style={{ minHeight: 84 }}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field label="Category (optional)" htmlFor="tracker-category">
          <Select id="tracker-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Start date and time"
          htmlFor="tracker-start"
          hint="Backdating is allowed. Your streak counts from the time you choose."
          error={startError}
        >
          <Input
            id="tracker-start"
            type="datetime-local"
            value={start}
            max={maxStart}
            onChange={(event) => setStart(event.target.value)}
          />
        </Field>

        <Field label="Reasons (optional)" htmlFor="tracker-reasons">
          <Textarea
            id="tracker-reasons"
            value={reasons}
            maxLength={LIMITS.description}
            placeholder="Why does this matter to you?"
            style={{ minHeight: 84 }}
            onChange={(event) => setReasons(event.target.value)}
          />
        </Field>

        <Field label="Notes (optional)" htmlFor="tracker-notes">
          <Textarea
            id="tracker-notes"
            value={notes}
            maxLength={LIMITS.notes}
            placeholder="Anything you want to remember."
            style={{ minHeight: 84 }}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>

        <p className="field-hint">
          {tracker
            ? 'Changing the start time adjusts the recorded sessions so nothing is counted before it.'
            : 'Everything you enter stays on this device. You can pause, archive or delete the tracker at any time.'}
        </p>
      </form>
    </Sheet>
  );
}
