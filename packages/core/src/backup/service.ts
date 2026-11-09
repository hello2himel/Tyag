/**
 * JSON/CSV export, encrypted backups and transactional import.
 *
 * The JSON export is the canonical portable format (schema version +
 * application version + export timestamp). Import validates everything before
 * touching the database, supports merge and replace, detects duplicates by
 * stable id and reports conflicts instead of silently overwriting records.
 */
import type {
  CsvDataset,
  CsvExportOptions,
  CsvExportResult,
  DeUrgeExport,
  EncryptedExportResult,
  ImportReport,
  JsonExportResult,
} from '../domain';
import type { CoreContext } from '../services/context';
import type { SettingsService } from '../services/settings';
import type { AnalyticsService } from '../analytics/service';
import { computeAllTrackerData } from '../analytics/engine';
import type { PersistenceAdapter } from '../persistence';
import { loadAllData } from '../services/data';
import { SCHEMA_VERSION } from '../db/migrations';
import { buildCsvExport, type CsvContext } from './csv';
import { executeImport, type ImportOptions } from './import';
import { openEnvelope, sealEnvelope } from './crypto';
import { buildExport, exportFilename } from './serialize';
import { parseExportDocument } from './schema';

/**
 * Maximum number of daily buckets exported by the `daily-summary` CSV.
 * Bounded so an export of many years of history stays fast and finite.
 */
export const MAX_DAILY_SUMMARY_PERIODS = 4_000;

export type { ImportOptions };

export class BackupService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly settings: SettingsService,
    private readonly analytics: AnalyticsService,
    private readonly persistence: PersistenceAdapter,
  ) {}

  /**
   * Export everything as a canonical JSON document.
   *
   * Settings' `lastExportAt` metadata is intentionally *not* written here: an
   * export is a pure read operation, and writing would change the data being
   * exported. The UI records the export timestamp through the settings
   * service when the user actually saves the file.
   */
  async exportJson(): Promise<JsonExportResult> {
    const data = loadAllData(this.ctx.db);
    const exportedAt = this.ctx.clock.now();
    const timeZone = this.settings.effectiveTimeZone();
    const document = await buildExport(data, {
      appVersion: this.ctx.appVersion,
      exportedAt,
      timeZone,
    });
    return {
      filename: exportFilename('deurge-export', exportedAt, timeZone, 'json'),
      content: JSON.stringify(document, null, 2),
      counts: document.counts,
    };
  }

  /**
   * Encrypted backup: PBKDF2(SHA-256, 310 000 iterations) + AES-256-GCM.
   *
   * The encrypted payload is the same canonical JSON document as
   * {@link exportJson}, so an encrypted backup round-trips through the normal
   * import validator (including its integrity hash).
   */
  async exportEncrypted(password: string): Promise<EncryptedExportResult> {
    const data = loadAllData(this.ctx.db);
    const createdAt = this.ctx.clock.now();
    const timeZone = this.settings.effectiveTimeZone();
    const document = await buildExport(data, {
      appVersion: this.ctx.appVersion,
      exportedAt: createdAt,
      timeZone,
    });
    const envelope = await sealEnvelope(JSON.stringify(document), password, {
      createdAt,
      appVersion: this.ctx.appVersion,
      schemaVersion: SCHEMA_VERSION,
    });
    return {
      filename: exportFilename('deurge-encrypted-backup', createdAt, timeZone, 'json'),
      content: JSON.stringify(envelope, null, 2),
      createdAt,
    };
  }

  /**
   * Export one dataset as RFC 4180 CSV in the effective (or requested) zone.
   *
   * Column names are documented on the column constants in `backup/csv.ts`.
   * The file always uses CRLF and contains one trailing newline.
   */
  exportCsv(dataset: CsvDataset, options: CsvExportOptions = {}): CsvExportResult {
    const data = loadAllData(this.ctx.db);
    const now = this.ctx.clock.now();
    // `daily-summary` needs one bucket per local day across the whole history;
    // the analytics engine bounds enumeration with this limit.
    const combinedDailyPeriods = this.analytics.combined({
      granularity: 'day',
      periodLimit: MAX_DAILY_SUMMARY_PERIODS,
    }).periods;
    const context: CsvContext = {
      data,
      now,
      effectiveTimeZone: this.settings.effectiveTimeZone(),
      combinedDailyPeriods,
      trackerMetrics: computeAllTrackerData(this.ctx).map((entry) => entry.metrics),
    };
    return buildCsvExport(dataset, context, options);
  }

  /**
   * Parse and validate an export document without importing it.
   *
   * Integrity hashing is asynchronous and is therefore verified during
   * {@link importJson}; this method performs full structural, enum, type,
   * uniqueness, timestamp and count validation synchronously.
   */
  parseExport(text: string): DeUrgeExport {
    return parseExportDocument(text);
  }

  /** Validate and import a JSON export (merge or replace). */
  async importJson(text: string, options: ImportOptions): Promise<ImportReport> {
    const parsed = this.parseExport(text);
    return executeImport(
      this.ctx,
      parsed,
      { ...options, supportsSnapshot: typeof this.persistence.backup === 'function' },
      () => this.snapshot(),
    );
  }

  /**
   * Decrypt and import an encrypted backup. A wrong password or a damaged
   * payload fails before any validation/import work happens.
   */
  async importEncrypted(
    text: string,
    password: string,
    options: ImportOptions,
  ): Promise<ImportReport> {
    const plaintext = await openEnvelope(text, password);
    return this.importJson(plaintext, options);
  }

  /** Snapshot the current database through the persistence adapter. */
  async snapshot(): Promise<void> {
    await this.persistence.backup?.(this.ctx.db.export());
  }
}
