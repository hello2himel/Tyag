/**
 * Data & Backups → Export.
 *
 * Files are produced by the core backup engine and written with the platform
 * save helper (browser download / native Documents). Nothing is uploaded.
 */
import { useState } from 'react';
import type { CsvDataset, ExportCounts } from '@deurge/core';
import { useApp } from '../../store/app';
import { saveTextFile } from '../../platform/files';
import { Button, Card, Field, Input, Select, useToast } from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { describeFailure, type ActionFailure } from './errors';
import './data.css';

const CSV_DATASETS: { value: CsvDataset; label: string; description: string }[] = [
  { value: 'trackers', label: 'Trackers', description: 'One row per tracker with status, start date and totals.' },
  { value: 'lapses', label: 'Lapses', description: 'One row per recorded lapse.' },
  { value: 'urges', label: 'Urges', description: 'One row per recorded urge, including intensity and outcome.' },
  { value: 'journal', label: 'Journal entries', description: 'One row per journal entry.' },
  { value: 'daily-summary', label: 'Daily summary', description: 'One row per local calendar day with activity totals.' },
  { value: 'statistics', label: 'Statistics', description: 'Aggregate statistics per tracker.' },
];

const CSV_LABEL = new Map<CsvDataset, string>(CSV_DATASETS.map((entry) => [entry.value, entry.label]));
const CSV_DESCRIPTION = new Map<CsvDataset, string>(CSV_DATASETS.map((entry) => [entry.value, entry.description]));

function totalCounts(counts: ExportCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

export function ExportSection() {
  const app = useApp();
  const toast = useToast();
  const fmt = useFormatters();
  const { settings } = app;

  const [busy, setBusy] = useState<'json' | 'encrypted' | 'csv' | null>(null);
  const [dataset, setDataset] = useState<CsvDataset>('lapses');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);

  const rememberExport = async (kind: 'export' | 'backup'): Promise<void> => {
    try {
      const now = Date.now();
      await app.core.settings.setInternal(kind === 'backup' ? { lastBackupAt: now } : { lastExportAt: now });
      app.refresh();
    } catch {
      // Timestamp metadata only; the file itself is already safe.
    }
  };

  const run = async (
    key: 'json' | 'encrypted' | 'csv',
    action: () => Promise<{ filename: string; detail: string; remember: 'export' | 'backup' }>,
  ): Promise<void> => {
    if (busy !== null) return;
    setBusy(key);
    setFailure(null);
    setSaved(null);
    try {
      const result = await action();
      await rememberExport(result.remember);
      setSaved(result.detail);
      toast.show(`Saved ${result.filename}.`);
    } catch (error) {
      const described = describeFailure(error);
      setFailure(described);
      toast.error(described.message);
    } finally {
      setBusy(null);
    }
  };

  const exportJson = () =>
    run('json', async () => {
      const result = await app.core.backup.exportJson();
      const file = await saveTextFile(result.filename, result.content, 'application/json');
      const total = totalCounts(result.counts);
      return {
        filename: file.filename,
        detail: `Saved ${file.filename} (${total} record${total === 1 ? '' : 's'}, JSON) to ${file.location}. This file is a full backup you can import again.`,
        remember: 'export' as const,
      };
    });

  const exportEncrypted = () => {
    setPasswordError(null);
    if (password.length < 8) {
      setPasswordError('Use at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError('The passwords do not match.');
      return;
    }
    void run('encrypted', async () => {
      const result = await app.core.backup.exportEncrypted(password);
      const file = await saveTextFile(result.filename, result.content, 'application/json');
      setPassword('');
      setConfirmPassword('');
      return {
        filename: file.filename,
        detail: `Saved ${file.filename} (encrypted backup) to ${file.location}. You will need this password to import it — there is no recovery.`,
        remember: 'backup' as const,
      };
    });
  };

  const exportCsv = () =>
    run('csv', async () => {
      const result = app.core.backup.exportCsv(dataset, {
        timeZone: app.timeZone,
        dateFormat: settings.dateFormat,
        timeFormat: settings.timeFormat,
        firstDayOfWeek: settings.firstDayOfWeek,
      });
      const file = await saveTextFile(result.filename, result.content, 'text/csv');
      return {
        filename: file.filename,
        detail: `Saved ${file.filename} (${CSV_LABEL.get(dataset) ?? dataset}, ${result.rows} row${result.rows === 1 ? '' : 's'}) to ${file.location}. CSV files are for spreadsheets and cannot be imported back into deUrge.`,
        remember: 'export' as const,
      };
    });

  return (
    <section className="data-section" aria-labelledby="data-export-heading">
      <h2 className="data-section-label" id="data-export-heading">
        Export
      </h2>
      <Card className="card-pad data-card">
        <p className="sub">
          Create a copy of everything you have recorded. Exports are written locally by your browser or device — deUrge never
          uploads them.
        </p>

        <div className="data-block">
          <div className="data-block-head">
            <div className="data-block-title">Full JSON backup</div>
            <div className="tiny">
              Last export: {settings.lastExportAt === null ? 'never' : fmt.dateTime(settings.lastExportAt)}
            </div>
          </div>
          <p className="data-block-body">
            All trackers, sessions, lapses, urges, journal entries, check-ins, categories and settings in one file you can
            import back later. Plain JSON is readable by anyone who opens the file.
          </p>
          <Button variant="primary" icon="download" onClick={() => void exportJson()} disabled={busy !== null}>
            {busy === 'json' ? 'Exporting…' : 'Export JSON'}
          </Button>
        </div>

        <div className="data-block">
          <div className="data-block-head">
            <div className="data-block-title">Encrypted backup</div>
            <div className="tiny">
              Last encrypted backup: {settings.lastBackupAt === null ? 'never' : fmt.dateTime(settings.lastBackupAt)}
            </div>
          </div>
          <p className="data-block-body">
            The same contents as JSON, protected with a password using PBKDF2-SHA256 key derivation and AES-GCM encryption.
            Encrypted backups are the safest way to keep a copy off the device.
          </p>
          <div className="data-password-grid">
            <Field label="Password" error={passwordError}>
              <Input
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setPasswordError(null);
                }}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                disabled={busy !== null}
                aria-label="New backup password"
              />
            </Field>
            <Field label="Confirm password">
              <Input
                type="password"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  setPasswordError(null);
                }}
                autoComplete="new-password"
                placeholder="Repeat the password"
                disabled={busy !== null}
                aria-label="Confirm new backup password"
              />
            </Field>
          </div>
          <p className="tiny">There is no password recovery. Without this password the backup cannot be opened.</p>
          <Button
            icon="lock"
            onClick={() => void exportEncrypted()}
            disabled={busy !== null || password.length === 0}
          >
            {busy === 'encrypted' ? 'Encrypting…' : 'Create encrypted backup'}
          </Button>
        </div>

        <div className="data-block">
          <div className="data-block-title">Spreadsheet export (CSV)</div>
          <p className="data-block-body">
            Plain-text tables for spreadsheets. Choose one dataset per file. CSV files cannot be imported back into deUrge, so
            keep a JSON or encrypted backup as well.
          </p>
          <Field label="Dataset" hint={CSV_DESCRIPTION.get(dataset)}>
            <Select
              value={dataset}
              onChange={(event) => setDataset(event.target.value as CsvDataset)}
              disabled={busy !== null}
              aria-label="CSV dataset"
            >
              {CSV_DATASETS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button icon="download" onClick={() => void exportCsv()} disabled={busy !== null}>
            {busy === 'csv' ? 'Exporting…' : `Export ${CSV_LABEL.get(dataset) ?? 'CSV'} CSV`}
          </Button>
        </div>

        {saved ? (
          <div className="notice data-saved" role="status">
            {saved}
          </div>
        ) : null}
        {failure ? (
          <div className={`notice ${failure.unavailable ? 'warn' : 'error'}`} role="alert">
            {failure.message}
          </div>
        ) : null}
      </Card>
    </section>
  );
}
