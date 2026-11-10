/**
 * Analytics engine (implementation in `analytics/engine.ts`).
 *
 * Every number is recomputed from stored records via the streak engine and the
 * local-time period helpers. Nothing is cached as a source of truth, so edits
 * and deletions are reflected immediately and historical results are
 * reproducible.
 */
import type { CombinedAnalytics, Granularity, TrackerAnalytics } from '../domain';
import type { CoreContext } from '../services/context';
import type { SettingsService } from '../services/settings';
import { buildCombinedAnalytics, buildTrackerAnalytics } from './engine';

export interface TrackerAnalyticsOptions {
  granularity?: Granularity;
  /** Inclusive start of the chart window (defaults to the tracker start). */
  from?: number;
  /** Exclusive end of the chart window (defaults to now). */
  to?: number;
  periodLimit?: number;
}

export interface CombinedAnalyticsOptions {
  granularity?: Granularity;
  from?: number;
  to?: number;
  periodLimit?: number;
}

export class AnalyticsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Analytics for one tracker.
   *
   * @throws TyagError `NOT_FOUND` when the tracker does not exist and
   *   `VALIDATION` for invalid chart options.
   */
  forTracker(trackerId: string, options: TrackerAnalyticsOptions = {}): TrackerAnalytics {
    return buildTrackerAnalytics(this.ctx, this.settings, trackerId, options);
  }

  /**
   * Analytics across every tracker.
   *
   * Period `activeMs`/`abstinentMs` and `totalAccumulatedAbstinenceMs` are
   * *tracker-time*: when two trackers run in parallel both contribute, so the
   * totals can exceed wall-clock time. This is deliberate and documented in
   * `analytics/engine.ts`.
   */
  combined(options: CombinedAnalyticsOptions = {}): CombinedAnalytics {
    return buildCombinedAnalytics(this.ctx, this.settings, options);
  }
}
