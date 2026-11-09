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
import type { PersistenceAdapter } from '../persistence';

export interface ImportOptions {
  mode: 'merge' | 'replace';
  /** What to do when an incoming id exists with different content. */
  onConflict?: 'skip' | 'keep-both';
  /** Explicit confirmation of a replace import. */
  confirmReplace?: boolean;
}

export class BackupService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly settings: SettingsService,
    private readonly analytics: AnalyticsService,
    private readonly persistence: PersistenceAdapter,
  ) {}

  async exportJson(): Promise<JsonExportResult> {
    void this.ctx;
    void this.settings;
    void this.analytics;
    throw new Error('Backup engine not implemented yet');
  }

  async exportEncrypted(password: string): Promise<EncryptedExportResult> {
    void password;
    throw new Error('Backup engine not implemented yet');
  }

  exportCsv(dataset: CsvDataset, options?: CsvExportOptions): CsvExportResult {
    void dataset;
    void options;
    throw new Error('Backup engine not implemented yet');
  }

  parseExport(text: string): DeUrgeExport {
    void text;
    throw new Error('Backup engine not implemented yet');
  }

  async importJson(text: string, options: ImportOptions): Promise<ImportReport> {
    void text;
    void options;
    void this.persistence;
    throw new Error('Backup engine not implemented yet');
  }

  async importEncrypted(text: string, password: string, options: ImportOptions): Promise<ImportReport> {
    void text;
    void password;
    void options;
    throw new Error('Backup engine not implemented yet');
  }

  /** Snapshot the current database through the persistence adapter. */
  async snapshot(): Promise<void> {
    await this.persistence.backup?.(this.ctx.db.export());
  }
}
