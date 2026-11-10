/**
 * Data & Backups → Import.
 *
 * Flow: pick a file → parse/validate it through the core backup service →
 * show an honest preview → merge or replace with explicit confirmation → show
 * the ImportReport. The file is read on this device and nothing is written
 * until the user confirms.
 */
import { useMemo, useState } from 'react';
import {
  ENCRYPTED_BACKUP_FORMAT,
  SCHEMA_VERSION,
  type EncryptedBackupEnvelope,
  type ExportCounts,
  type ImportOptions,
  type ImportReport,
} from '@deurge/core';
import { useApp } from '../../store/app';
import { pickTextFile } from '../../platform/files';
import {
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Segmented,
  Select,
  useToast,
} from '../../ui/components';
import { useFormatters } from '../../ui/format';
import { describeFailure, type ActionFailure } from './errors';
import './data.css';

type ImportMode = 'merge' | 'replace';
type ConflictStrategy = 'skip' | 'keep-both';

interface Preview {
  kind: 'json' | 'encrypted';
  filename: string;
  text: string;
  exportedAt: number | null;
  appVersion: string | null;
  schemaVersion: number | null;
  timeZone: string | null;
  counts: ExportCounts | null;
}

const COUNT_FIELDS: { key: keyof ExportCounts; label: string }[] = [
  { key: 'trackers', label: 'Trackers' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'lapses', label: 'Lapses' },
  { key: 'urges', label: 'Urges' },
  { key: 'journalEntries', label: 'Journal entries' },
  { key: 'checkIns', label: 'Check-ins' },
  { key: 'categories', label: 'Triggers & reasons' },
  { key: 'settings', label: 'Settings' },
  { key: 'historyEvents', label: 'History events' },
];

const COLLECTION_LABEL: Record<string, string> = Object.fromEntries(
  COUNT_FIELDS.map((entry) => [entry.key, entry.label]),
);

function labelForCollection(collection: string): string {
  return COLLECTION_LABEL[collection] ?? collection;
}

function totalOf(counts: ExportCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function CountGrid({ counts }: { counts: ExportCounts }) {
  return (
    <dl className="import-counts">
      {COUNT_FIELDS.map((field) => (
        <div className="import-count" key={field.key}>
          <dt>{field.label}</dt>
          <dd>{counts[field.key]}</dd>
        </div>
      ))}
    </dl>
  );
}

function ImportReportCard({ report, filename }: { report: ImportReport; filename: string | null }) {
  const importedEntries = useMemo(
    () =>
      Object.entries(report.imported)
        .filter(([, count]) => count > 0)
        .map(([collection, count]) => ({ collection, count })),
    [report],
  );
  const importedTotal = importedEntries.reduce((sum, entry) => sum + entry.count, 0);
  return (
    <div className="import-report" role="status" aria-label="Import result">
      <div className="data-block-title">
        {report.mode === 'replace' ? 'Replace import complete' : 'Merge import complete'}
      </div>
      {filename ? <div className="tiny">From {filename}</div> : null}
      <p className="data-block-body">
        {importedTotal} record{importedTotal === 1 ? '' : 's'} imported
        {report.skippedDuplicates > 0 ? `, ${report.skippedDuplicates} existing record${report.skippedDuplicates === 1 ? '' : 's'} left untouched` : ''}
        {report.rekeyed > 0 ? `, ${report.rekeyed} conflicting record${report.rekeyed === 1 ? '' : 's'} given new ids` : ''}.
      </p>
      {importedEntries.length > 0 ? (
        <dl className="import-counts">
          {importedEntries.map((entry) => (
            <div className="import-count" key={entry.collection}>
              <dt>{labelForCollection(entry.collection)}</dt>
              <dd>{entry.count}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {report.warnings.length > 0 ? (
        <div className="stack-sm" style={{ marginTop: 8 }}>
          {report.warnings.map((warning, index) => (
            <div className="notice warn" key={index}>
              {warning}
            </div>
          ))}
        </div>
      ) : null}
      {report.conflicts.length > 0 ? (
        <details className="import-details">
          <summary>
            Conflicts ({report.conflicts.length}) — records that already existed with different content
          </summary>
          <ul className="import-conflicts">
            {report.conflicts.slice(0, 50).map((conflict, index) => (
              <li key={`${conflict.collection}-${conflict.id}-${index}`}>
                <code>{labelForCollection(conflict.collection)}</code> · {conflict.reason}
                <span className="tiny"> (id {conflict.id.slice(0, 8)}…)</span>
              </li>
            ))}
          </ul>
          {report.conflicts.length > 50 ? (
            <p className="tiny">Showing the first 50 of {report.conflicts.length} conflicts.</p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

export function ImportSection() {
  const app = useApp();
  const toast = useToast();
  const fmt = useFormatters();

  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<ImportMode>('merge');
  const [onConflict, setOnConflict] = useState<ConflictStrategy>('skip');
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [reportFile, setReportFile] = useState<string | null>(null);

  const resetPreview = () => {
    setPreview(null);
    setPassword('');
    setMode('merge');
    setOnConflict('skip');
    setFileError(null);
  };

  const pickFile = async (): Promise<void> => {
    if (picking || importing) return;
    setPicking(true);
    setFailure(null);
    setFileError(null);
    try {
      const file = await pickTextFile('.json,application/json');
      if (!file) return;
      let raw: unknown;
      try {
        raw = JSON.parse(file.text);
      } catch {
        setFileError('That file is not valid JSON. Choose a deUrge backup file (.json).');
        return;
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        setFileError('That file does not look like a deUrge backup.');
        return;
      }
      const record = raw as Record<string, unknown>;
      if (record['format'] === ENCRYPTED_BACKUP_FORMAT) {
        const envelope = raw as Partial<EncryptedBackupEnvelope>;
        if (!envelope.payload || !envelope.kdf || !envelope.cipher) {
          setFileError('This encrypted backup appears to be incomplete or damaged.');
          return;
        }
        setPreview({
          kind: 'encrypted',
          filename: file.name,
          text: file.text,
          exportedAt: typeof envelope.createdAt === 'number' ? envelope.createdAt : null,
          appVersion: typeof envelope.appVersion === 'string' ? envelope.appVersion : null,
          schemaVersion: typeof envelope.schemaVersion === 'number' ? envelope.schemaVersion : null,
          timeZone: null,
          counts: null,
        });
        setPassword('');
        setMode('merge');
        setOnConflict('skip');
        setReport(null);
        return;
      }
      try {
        const parsed = app.core.backup.parseExport(file.text);
        setPreview({
          kind: 'json',
          filename: file.name,
          text: file.text,
          exportedAt: typeof parsed.exportedAt === 'number' ? parsed.exportedAt : null,
          appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : null,
          schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null,
          timeZone: typeof parsed.timeZone === 'string' ? parsed.timeZone : null,
          counts: parsed.counts,
        });
        setPassword('');
        setMode('merge');
        setOnConflict('skip');
        setReport(null);
        setReportFile(null);
      } catch (error) {
        const described = describeFailure(error);
        setFileError(described.message);
        if (described.unavailable) setFailure(described);
      }
    } finally {
      setPicking(false);
    }
  };

  const runImport = async (): Promise<void> => {
    if (!preview || importing) return;
    if (preview.kind === 'encrypted' && password.length === 0) {
      setFileError('Enter the password for this encrypted backup.');
      return;
    }
    setImporting(true);
    setFailure(null);
    setFileError(null);
    try {
      const options: ImportOptions =
        mode === 'replace'
          ? { mode: 'replace', confirmReplace: true }
          : { mode: 'merge', onConflict };
      const result =
        preview.kind === 'encrypted'
          ? await app.core.backup.importEncrypted(preview.text, password, options)
          : await app.core.backup.importJson(preview.text, options);
      app.refresh();
      setReport(result);
      setReportFile(preview.filename);
      setPreview(null);
      setPassword('');
      const total = Object.values(result.imported).reduce((sum, count) => sum + count, 0);
      toast.show(
        result.mode === 'replace'
          ? `Data replaced: ${total} record${total === 1 ? '' : 's'} imported.`
          : `Merged: ${total} record${total === 1 ? '' : 's'} imported.`,
      );
    } catch (error) {
      const described = describeFailure(error);
      setFailure(described);
      toast.error(described.message);
    } finally {
      setImporting(false);
      setConfirmReplace(false);
    }
  };

  return (
    <section className="data-section" aria-labelledby="data-import-heading">
      <h2 className="data-section-label" id="data-import-heading">
        Import
      </h2>
      <Card className="card-pad data-card">
        <p className="sub">
          Restore a backup file from this device. deUrge validates the whole file before it writes anything, then shows a
          preview so you can choose merge or replace.
        </p>

        <div className="row-start">
          <Button icon="upload" onClick={() => void pickFile()} disabled={picking || importing}>
            {picking ? 'Reading file…' : 'Choose backup file'}
          </Button>
          <span className="tiny">Plain JSON or encrypted backup. Files are read locally; nothing is uploaded.</span>
        </div>

        {fileError ? (
          <div className="notice error" role="alert">
            {fileError}
          </div>
        ) : null}
        {failure ? (
          <div className={`notice ${failure.unavailable ? 'warn' : 'error'}`} role="alert">
            {failure.message}
          </div>
        ) : null}

        {preview ? (
          <div className="import-preview" aria-label="Backup file preview">
            <div className="data-block-head">
              <div className="data-block-title">{preview.filename}</div>
              <span className="import-kind">{preview.kind === 'encrypted' ? 'Encrypted backup' : 'JSON export'}</span>
            </div>
            <div className="import-meta">
              {preview.appVersion ? <span>Made with deUrge {preview.appVersion}</span> : null}
              {preview.exportedAt !== null ? <span>Exported {fmt.dateTime(preview.exportedAt)}</span> : null}
              {preview.timeZone ? <span>Time zone: {preview.timeZone}</span> : null}
              {preview.schemaVersion !== null ? <span>File schema {preview.schemaVersion} (app schema {SCHEMA_VERSION})</span> : null}
            </div>

            {preview.counts ? (
              <>
                <div className="tiny">{totalOf(preview.counts)} records in this file:</div>
                <CountGrid counts={preview.counts} />
              </>
            ) : (
              <div className="notice">
                This backup is encrypted, so its record counts stay unreadable until it is decrypted during the import.
                Nothing is written unless decryption and validation succeed.
              </div>
            )}

            {preview.kind === 'encrypted' ? (
              <Field label="Backup password" hint="Required to decrypt this file. It is never stored.">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="off"
                  placeholder="Password used when the backup was created"
                  aria-label="Backup file password"
                  disabled={importing}
                />
              </Field>
            ) : null}

            <Field label="Import mode">
              <Segmented
                options={[
                  { value: 'merge', label: 'Merge' },
                  { value: 'replace', label: 'Replace' },
                ]}
                value={mode}
                onChange={(next) => setMode(next)}
                ariaLabel="Import mode"
              />
            </Field>

            {mode === 'merge' ? (
              <Field
                label="When a record already exists"
                hint="Skip keeps this device's version; keep both gives the incoming record a new id. Merge never deletes anything already here."
              >
                <Select
                  value={onConflict}
                  onChange={(event) => setOnConflict(event.target.value as ConflictStrategy)}
                  aria-label="Conflict handling"
                  disabled={importing}
                >
                  <option value="skip">Skip incoming (keep this version)</option>
                  <option value="keep-both">Keep both (new id for incoming)</option>
                </Select>
              </Field>
            ) : (
              <div className="notice warn" role="note">
                <strong>Replace removes everything currently on this device</strong> before writing the file's contents.
                This cannot be undone unless you exported a backup first. You will be asked to type REPLACE to confirm.
              </div>
            )}

            <div className="row-start">
              <Button
                variant={mode === 'replace' ? 'danger' : 'primary'}
                icon={mode === 'replace' ? 'alert' : 'upload'}
                onClick={() => {
                  if (mode === 'replace') setConfirmReplace(true);
                  else void runImport();
                }}
                disabled={importing || (preview.kind === 'encrypted' && password.length === 0)}
              >
                {importing ? 'Importing…' : mode === 'replace' ? 'Replace everything on this device' : 'Merge into this device'}
              </Button>
              <Button variant="plain" onClick={resetPreview} disabled={importing}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {report ? <ImportReportCard report={report} filename={reportFile} /> : null}
      </Card>

      <ConfirmDialog
        open={confirmReplace}
        title="Replace all data on this device?"
        body={
          <div>
            <p>
              Everything currently stored on this device is removed and replaced with the contents of this backup file.
            </p>
            <p style={{ marginTop: 8 }}>
              This is irreversible unless you exported a backup first. Type REPLACE to confirm.
            </p>
          </div>
        }
        confirmLabel="Replace everything"
        tone="danger"
        requirePhrase="REPLACE"
        onConfirm={() => void runImport()}
        onCancel={() => setConfirmReplace(false)}
      />
    </section>
  );
}
