/**
 * First-run onboarding — three short steps, no network, no account.
 *
 * (a) Welcome, (b) create the first tracker (skippable, backdatable) and
 * (c) a plain-language privacy/backup summary. Going back a step never loses
 * a tracker: once created, step (b) switches to editing that same tracker.
 * Onboarding is marked complete through `updateSettings({ onboarded: true })`.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isDeUrgeError, LIMITS, userMessage } from '@deurge/core';
import { useApp } from '../../store/app';
import { navigate } from '../../router';
import { Button, Field, Icon, Input, Select, Textarea } from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { fromDateTimeLocalValue, toDateTimeLocalValue } from '../record/localDateTime';
import './onboarding.css';

const TOTAL_STEPS = 3;
const FORM_ID = 'deurge-onboarding-tracker-form';

interface CreatedTracker {
  id: string;
  name: string;
  startedAt: number;
}

export function OnboardingScreen({ onComplete }: { onComplete: () => void }) {
  const app = useApp();
  const fmt = useFormatters();
  const timeZone = app.timeZone;
  const categories = useMemo(() => app.core.categories.list('tracker_category'), [app.core, app.version]);

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [initialStart] = useState(() => toDateTimeLocalValue(app.now, timeZone));
  const [start, setStart] = useState(initialStart);
  const [reasons, setReasons] = useState('');
  const [created, setCreated] = useState<CreatedTracker | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const maxStart = toDateTimeLocalValue(app.now, timeZone);

  // Move focus into the form and keep each step at the top of the screen.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (step !== 1) return;
    const timer = window.setTimeout(() => document.getElementById('onboarding-tracker-name')?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [step]);

  async function handleCreateOrUpdate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving || finishing) return;
    setNameError(null);
    setStartError(null);
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Give your tracker a name, or choose “Skip for now” to decide later.');
      document.getElementById('onboarding-tracker-name')?.focus();
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
      if (created) {
        const updated = await app.core.trackers.update(created.id, {
          name: trimmedName,
          description,
          categoryId: categoryId || null,
          reasons,
          ...(startedAt !== undefined ? { startedAt, startedTimeZone: timeZone } : {}),
        });
        setCreated({ id: updated.id, name: updated.name, startedAt: updated.startedAt });
        app.refresh();
      } else {
        const tracker = await app.core.trackers.create({
          name: trimmedName,
          description,
          categoryId: categoryId || null,
          reasons,
          ...(startedAt !== undefined ? { startedAt, startedTimeZone: timeZone } : {}),
        });
        setCreated({ id: tracker.id, name: tracker.name, startedAt: tracker.startedAt });
        app.refresh();
      }
      setStep(2);
    } catch (writeError) {
      setError(userMessage(writeError));
      if (isDeUrgeError(writeError) && writeError.details['startedAt']) {
        setStartError(userMessage(writeError));
      }
    } finally {
      setSaving(false);
    }
  }

  async function finish(): Promise<void> {
    if (finishing) return;
    setFinishing(true);
    setError(null);
    try {
      await app.updateSettings({ onboarded: true });
      navigate(created ? `/tracker/${created.id}` : '/trackers');
      onComplete();
    } catch (writeError) {
      setError(userMessage(writeError));
      setFinishing(false);
    }
  }

  async function skipForNow(): Promise<void> {
    if (saving || finishing) return;
    setSaving(true);
    setError(null);
    try {
      await app.updateSettings({ onboarded: true });
      navigate('/trackers');
      onComplete();
    } catch (writeError) {
      setError(userMessage(writeError));
      setSaving(false);
    }
  }

  const saveLabel = saving ? 'Saving…' : created ? 'Save and continue' : 'Create tracker';

  return (
    <div className="onboarding">
      <div className="onboarding-inner">
        <div className="onboarding-top">
          <span className="onboarding-brand">deUrge</span>
          <div className="onboarding-dots" role="img" aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}>
            {Array.from({ length: TOTAL_STEPS }, (_, index) => (
              <i key={index} className={index <= step ? 'on' : ''} aria-hidden="true" />
            ))}
          </div>
        </div>

        {step === 0 ? (
          <>
            <div className="onboarding-card">
              <div className="onboarding-mark" aria-hidden="true">
                <Icon name="clock" size={34} strokeWidth={1.8} />
              </div>
              <h1 className="onboarding-title">Progress, not perfection.</h1>
              <p className="onboarding-lead">
                deUrge is a private place to track a behaviour you want to move away from — and the progress that
                continues through lapses and urges.
              </p>
              <p className="onboarding-privacy">Local only · no account · no cloud</p>
            </div>
            <div className="onboarding-actions">
              <Button variant="primary" onClick={() => setStep(1)}>
                Continue
              </Button>
              <span className="onboarding-footnote">Everything you record stays on this device.</span>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="onboarding-card">
              <h1 className="onboarding-title">Create your first tracker</h1>
              <p className="onboarding-lead">
                Start with one behaviour. You can add more later — and earlier progress is never lost.
              </p>
              <form id={FORM_ID} className="onboarding-form" onSubmit={handleCreateOrUpdate} noValidate>
                {error ? (
                  <div className="notice error" role="alert">
                    {error}
                  </div>
                ) : null}

                <Field label="Name" htmlFor="onboarding-tracker-name" error={nameError}>
                  <Input
                    id="onboarding-tracker-name"
                    value={name}
                    maxLength={LIMITS.trackerName}
                    autoComplete="off"
                    placeholder="e.g. Social media"
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>

                <Field label="Description (optional)" htmlFor="onboarding-tracker-description">
                  <Textarea
                    id="onboarding-tracker-description"
                    value={description}
                    maxLength={LIMITS.description}
                    placeholder="What does this tracker mean for you?"
                    style={{ minHeight: 76 }}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Field>

                <Field label="Category (optional)" htmlFor="onboarding-tracker-category">
                  <Select
                    id="onboarding-tracker-category"
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                  >
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
                  htmlFor="onboarding-tracker-start"
                  hint="Backdating is allowed. Your streak counts from the time you choose."
                  error={startError}
                >
                  <Input
                    id="onboarding-tracker-start"
                    type="datetime-local"
                    value={start}
                    max={maxStart}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </Field>

                <Field label="Reasons (optional)" htmlFor="onboarding-tracker-reasons">
                  <Textarea
                    id="onboarding-tracker-reasons"
                    value={reasons}
                    maxLength={LIMITS.description}
                    placeholder="Why does this matter to you?"
                    style={{ minHeight: 76 }}
                    onChange={(event) => setReasons(event.target.value)}
                  />
                </Field>
              </form>
              {created ? (
                <p className="field-hint">
                  <strong>{created.name}</strong> was created. Saving here updates that tracker — you will not lose it
                  by going back.
                </p>
              ) : null}
            </div>
            <div className="onboarding-actions">
              <Button variant="primary" type="submit" form={FORM_ID} disabled={saving}>
                {saveLabel}
              </Button>
              {created ? (
                <Button variant="plain" type="button" onClick={() => setStep(2)} disabled={saving}>
                  Continue without changes
                </Button>
              ) : (
                <Button variant="plain" type="button" onClick={() => void skipForNow()} disabled={saving}>
                  Skip for now
                </Button>
              )}
              <Button variant="plain" type="button" onClick={() => setStep(0)} disabled={saving}>
                Back
              </Button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="onboarding-card">
              <div className="onboarding-mark onboarding-mark-ready" aria-hidden="true">
                <Icon name="shield" size={32} strokeWidth={1.8} />
              </div>
              <h1 className="onboarding-title">
                {created ? `You're set up. ${created.name} is running.` : "You're set up."}
              </h1>
              <p className="onboarding-lead">
                Your data stays on this device. Export a backup any time from Data &amp; Backups.
              </p>
              <p className="onboarding-privacy">Local only · no account · no cloud</p>
              {created ? (
                <div className="notice">
                  Started <strong>{created.name}</strong> on {fmt.dateTime(created.startedAt)}. Every moment from there
                  counts, and earlier progress is never lost.
                </div>
              ) : (
                <div className="notice">
                  No tracker yet. You can create one whenever you are ready from the Trackers screen.
                </div>
              )}
              {error ? (
                <div className="notice error" role="alert">
                  {error}
                </div>
              ) : null}
            </div>
            <div className="onboarding-actions">
              <Button variant="primary" onClick={() => void finish()} disabled={finishing}>
                {finishing ? 'Opening…' : 'Open deUrge'}
              </Button>
              <Button variant="plain" type="button" onClick={() => setStep(1)} disabled={finishing}>
                Back
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
