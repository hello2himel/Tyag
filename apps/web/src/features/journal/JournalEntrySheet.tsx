/**
 * Journal entry editor sheet.
 *
 * Create or edit one journal entry: when it happened (backdating is allowed),
 * which tracker it belongs to (optional — the global journal is fine), a
 * title and the body. Writes go through the core journal service, so history
 * records and validation are the same as everywhere else in the app.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { isDeUrgeError, userMessage, type JournalEntry } from '@deurge/core';
import { useApp } from '../../store/app';
import { Button, Field, Input, Select, Sheet, Textarea, useToast } from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { splitLocalDateTime, zonedLocalDateTimeToMs } from './time';

const FUTURE_TOLERANCE_MS = 5 * 60_000;

export function JournalEntrySheet({
  open,
  entry,
  defaultTrackerId,
  onClose,
}: {
  open: boolean;
  /** Existing entry to edit, or null to create a new one. */
  entry: JournalEntry | null;
  /** Tracker preselected for a new entry (from the active filter). */
  defaultTrackerId: string | null;
  onClose: () => void;
}) {
  const app = useApp();
  const toast = useToast();
  const fmt = useFormatters();
  const trackers = useMemo(() => app.core.trackers.list(), [app.core, app.version]);
  const idPrefix = useId();
  const trackerFieldId = `${idPrefix}-tracker`;
  const titleFieldId = `${idPrefix}-title`;
  const bodyFieldId = `${idPrefix}-body`;

  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [selectedTrackerId, setSelectedTrackerId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [whenError, setWhenError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset the form whenever the sheet opens (or the entry being edited changes).
  // Deliberately not keyed on the one-second display clock: the form must not
  // reset while the user is typing.
  useEffect(() => {
    if (!open) return;
    const initial = entry ? splitLocalDateTime(entry.occurredAt, app.timeZone) : splitLocalDateTime(Date.now(), app.timeZone);
    setDate(initial.date);
    setTime(initial.time);
    setSelectedTrackerId(entry ? (entry.trackerId ?? '') : (defaultTrackerId ?? ''));
    setTitle(entry?.title ?? '');
    setBody(entry?.body ?? '');
    setWhenError(null);
    setBodyError(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry, defaultTrackerId]);

  const whenMs = zonedLocalDateTimeToMs(date, time, app.timeZone);

  const save = async () => {
    if (saving) return;
    let valid = true;
    if (whenMs === null) {
      setWhenError('Choose a valid date and time.');
      valid = false;
    } else if (whenMs > Date.now() + FUTURE_TOLERANCE_MS) {
      setWhenError('This entry is dated in the future. Choose a past or current time.');
      valid = false;
    } else {
      setWhenError(null);
    }
    if (!body.trim()) {
      setBodyError('Write something before saving.');
      valid = false;
    } else {
      setBodyError(null);
    }
    if (!valid || whenMs === null) return;

    const payload = {
      trackerId: selectedTrackerId || null,
      occurredAt: whenMs,
      occurredTimeZone: app.timeZone,
      title: title.trim() ? title.trim() : null,
      body: body.trim(),
    };

    setSaving(true);
    try {
      if (entry) {
        await app.core.journal.update(entry.id, payload);
        toast.show('Entry updated.');
      } else {
        await app.core.journal.create(payload);
        toast.show('Entry saved.');
      }
      app.refresh();
      onClose();
    } catch (error) {
      toast.error(isDeUrgeError(error) ? userMessage(error) : 'That entry could not be saved. Your existing data was left untouched.');
    } finally {
      setSaving(false);
    }
  };

  const previewWhen = whenMs !== null ? fmt.relative(whenMs) : null;

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={entry ? 'Edit entry' : 'New entry'}
      left={
        <Button variant="plain" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      }
      right={
        <Button variant="plain" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      <Field label="When" error={whenError} hint={previewWhen ? `Shown as: ${previewWhen}` : 'You can backdate an entry.'}>
        <div className="journal-when">
          <Input
            type="date"
            value={date}
            max={splitLocalDateTime(Date.now(), app.timeZone).date}
            onChange={(event) => setDate(event.target.value)}
            aria-label="Entry date"
            disabled={saving}
          />
          <Input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            aria-label="Entry time"
            disabled={saving}
          />
        </div>
      </Field>

      <Field label="Tracker" htmlFor={trackerFieldId} hint="Optional. Leave it as the global journal to write about anything.">
        <Select
          id={trackerFieldId}
          value={selectedTrackerId}
          onChange={(event) => setSelectedTrackerId(event.target.value)}
          disabled={saving}
        >
          <option value="">Global journal</option>
          {trackers.map((tracker) => (
            <option key={tracker.id} value={tracker.id}>
              {tracker.name}
              {tracker.status === 'active' ? '' : ` (${tracker.status})`}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Title" htmlFor={titleFieldId} hint="Optional.">
        <Input
          id={titleFieldId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="A short headline"
          maxLength={200}
          disabled={saving}
        />
      </Field>

      <Field label="Entry" htmlFor={bodyFieldId} error={bodyError}>
        <Textarea
          id={bodyFieldId}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="What is happening? What do you want to remember about today?"
          aria-label="Journal entry"
          disabled={saving}
          rows={7}
        />
      </Field>

      <div className="tiny">
        Saved on this device only. Journal entries never change your streak calculations.
      </div>
    </Sheet>
  );
}
