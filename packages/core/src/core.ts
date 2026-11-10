/**
 * deUrge application core.
 *
 * One `DeUrgeCore` owns the SQLite database, the services (trackers, events,
 * journal, categories, settings, history) and the engines (analytics,
 * insights, backup). It has no platform dependencies: pass it a SQLite WASM
 * instance, a persistence adapter and a clock.
 */
import type { SqlJsStatic } from 'sql.js';
import type { AppSettings, TrackerMetrics } from './domain';
import { APP_VERSION } from './constants';
import { SqlDatabase } from './db/sqlite';
import { migrate } from './db/migrations';
import { seedDefaultCategories } from './settings/defaults';
import type { Clock } from './util/clock';
import { systemClock } from './util/clock';
import { DeUrgeError } from './util/errors';
import { loadTrackerBundle } from './services/data';
import { computeTrackerMetrics } from './engine/streak';
import type { CoreContext } from './services/context';
import { TrackerService } from './services/trackers';
import { LapseService, UrgeService } from './services/events';
import { CheckInService, JournalService } from './services/journal';
import { CategoryService } from './services/categories';
import { SettingsService } from './services/settings';
import { HistoryService } from './services/history';
import { AnalyticsService } from './analytics/service';
import { InsightsService } from './insights/service';
import { BackupService } from './backup/service';
import type { PersistenceAdapter } from './persistence';

export interface CoreOpenOptions {
  /** Initialised sql.js runtime (see `loadSqlJs`). */
  SQL: SqlJsStatic;
  persistence: PersistenceAdapter;
  clock?: Clock;
  appVersion?: string;
}

export class DeUrgeCore {
  readonly trackers: TrackerService;
  readonly lapses: LapseService;
  readonly urges: UrgeService;
  readonly journal: JournalService;
  readonly checkIns: CheckInService;
  readonly categories: CategoryService;
  readonly settings: SettingsService;
  readonly history: HistoryService;
  readonly analytics: AnalyticsService;
  readonly insights: InsightsService;
  readonly backup: BackupService;
  readonly persistence: PersistenceAdapter;
  readonly appVersion: string;

  private readonly clock: Clock;
  private readonly ctx: CoreContext;

  private constructor(
    database: SqlDatabase,
    persistence: PersistenceAdapter,
    clock: Clock,
    appVersion: string,
  ) {
    this.persistence = persistence;
    this.clock = clock;
    this.appVersion = appVersion;
    let settingsService: SettingsService | null = null;
    const ctx: CoreContext = {
      db: database,
      clock,
      appVersion,
      getEffectiveTimeZone: () => settingsService?.effectiveTimeZone() ?? 'UTC',
      persist: async () => {
        await persistence.save(ctx.db.export());
      },
    };
    this.ctx = ctx;
    this.trackers = new TrackerService(ctx);
    this.lapses = new LapseService(ctx);
    this.urges = new UrgeService(ctx);
    this.journal = new JournalService(ctx);
    this.checkIns = new CheckInService(ctx);
    this.categories = new CategoryService(ctx);
    this.settings = new SettingsService(ctx);
    settingsService = this.settings;
    this.history = new HistoryService(ctx);
    this.analytics = new AnalyticsService(ctx, this.settings);
    this.insights = new InsightsService(ctx, this.settings, this.analytics);
    this.backup = new BackupService(ctx, this.settings, this.analytics, persistence);
  }

  /**
   * Open the app: load the persisted snapshot, verify it, run migrations,
   * seed defaults and persist if anything changed.
   */
  static async open(options: CoreOpenOptions): Promise<DeUrgeCore> {
    const clock = options.clock ?? systemClock();
    const appVersion = options.appVersion ?? APP_VERSION;
    const bytes = await options.persistence.load();
    let database: SqlDatabase;
    try {
      database = SqlDatabase.fromBytes(options.SQL, bytes);
    } catch {
      throw new DeUrgeError(
        'DATABASE',
        'Your local deUrge data could not be opened. Restore a backup from the Data & Backups screen.',
      );
    }
    if (bytes) {
      const integrity = database.integrityCheck();
      if (integrity !== 'ok') {
        throw new DeUrgeError(
          'DATABASE',
          'Your local deUrge data failed an integrity check. Restore a backup from the Data & Backups screen.',
        );
      }
    }
    const applied = migrate(database, clock.now());
    if (applied > 0) {
      // Migrations rebuild tables with foreign-key enforcement disabled for the
      // duration of the transaction; verify the result before using it.
      const integrity = database.integrityCheck();
      if (integrity !== 'ok' || database.foreignKeyViolations().length > 0) {
        throw new DeUrgeError(
          'DATABASE',
          'Your local deUrge data could not be upgraded safely. Restore a backup from the Data & Backups screen.',
        );
      }
    }
    let seeded = false;
    database.transaction(() => {
      const before = database.get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_categories');
      seedDefaultCategories(database, clock.now());
      const after = database.get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_categories');
      seeded = (before?.n ?? 0) !== (after?.n ?? 0);
    });
    const core = new DeUrgeCore(database, options.persistence, clock, appVersion);
    if (!bytes || applied > 0 || seeded) {
      await core.persist();
    }
    return core;
  }

  get db(): SqlDatabase {
    return this.ctx.db;
  }

  now(): number {
    return this.clock.now();
  }

  timeZone(): string {
    return this.ctx.getEffectiveTimeZone();
  }

  settingsSnapshot(): AppSettings {
    return this.settings.get();
  }

  /** Current streak/accumulated metrics for one tracker. */
  metrics(trackerId: string): TrackerMetrics {
    const bundle = loadTrackerBundle(this.ctx.db, trackerId);
    return computeTrackerMetrics({
      tracker: bundle.tracker,
      sessions: bundle.sessions,
      lapses: bundle.lapses,
      urges: bundle.urges,
      journal: bundle.journal,
      now: this.now(),
    });
  }

  allMetrics(): TrackerMetrics[] {
    return this.trackers.list().map((tracker) => this.metrics(tracker.id));
  }

  async persist(): Promise<void> {
    await this.ctx.persist();
  }

  bytes(): Uint8Array {
    return this.ctx.db.export();
  }

  checkIntegrity(): string {
    return this.ctx.db.integrityCheck();
  }

  close(): void {
    this.ctx.db.close();
  }
}
