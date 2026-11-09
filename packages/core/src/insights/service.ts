/**
 * Deterministic, offline insights engine.
 *
 * Rules only use locally stored records, always name the period and sample
 * size, and explicitly say when there is not enough data. No network calls,
 * no AI services, no medical claims, no predictions.
 */
import type { Insight } from '../domain';
import type { CoreContext } from '../services/context';
import type { SettingsService } from '../services/settings';
import type { AnalyticsService } from '../analytics/service';
import { buildCombinedInsights, buildTrackerInsights } from './engine';

export class InsightsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly settings: SettingsService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Insights for a single tracker, in a fixed, reproducible order.
   *
   * Only rules with enough data are returned. When nothing has enough data a
   * single `insufficient-data` insight explains that, always citing the period
   * and the number of records considered.
   *
   * @throws DeUrgeError `NOT_FOUND` when the tracker does not exist.
   */
  forTracker(trackerId: string): Insight[] {
    return buildTrackerInsights(this.ctx, this.settings, this.analytics, trackerId);
  }

  /** Combined insights across every tracker, in the same fixed order. */
  combined(): Insight[] {
    return buildCombinedInsights(this.ctx, this.settings);
  }
}
