import type { AppSettings } from '../domain';
import { hydrateSettings, SETTINGS_KEYS } from '../settings/defaults';
import { settingsRepo } from '../repos/settings';
import { validateAppSettingsPatch } from '../validation';
import { write, type CoreContext } from './context';
import { isValidTimeZone } from '../time/temporal';
import { TyagError, fail } from '../util/errors';

export class SettingsService {
  constructor(private readonly ctx: CoreContext) {}

  get(): AppSettings {
    const stored = settingsRepo.loadSettings(this.ctx.db, SETTINGS_KEYS);
    return hydrateSettings(stored);
  }

  /** Timezone used for grouping dates in the UI, analytics and exports. */
  effectiveTimeZone(): string {
    const settings = this.get();
    if (settings.timeZoneMode === 'fixed' && settings.fixedTimeZone) {
      if (isValidTimeZone(settings.fixedTimeZone)) return settings.fixedTimeZone;
    }
    const device = this.ctx.clock.timeZone();
    return isValidTimeZone(device) ? device : 'UTC';
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const clean = validateAppSettingsPatch(patch);
    if (Object.keys(clean).length === 0) return this.get();
    const now = this.ctx.clock.now();
    await write(this.ctx, () => {
      settingsRepo.saveSettings(this.ctx.db, clean as Partial<AppSettings>, now);
      this.ctx.db.run(
        `INSERT INTO history_events (id, tracker_id, type, occurred_at, created_at, ref_id, metadata)
         VALUES (?, NULL, 'settings_updated', ?, ?, NULL, ?)`,
        [`settings-${now}-${Math.random().toString(36).slice(2, 8)}`, now, now, JSON.stringify({ keys: Object.keys(clean) })],
      );
    });
    return this.get();
  }

  /** Internal metadata updates (export/backup timestamps) without history noise. */
  async setInternal(patch: Partial<AppSettings>): Promise<void> {
    const now = this.ctx.clock.now();
    await write(this.ctx, () => {
      settingsRepo.saveSettings(this.ctx.db, patch, now);
    });
  }

  async markOnboarded(): Promise<AppSettings> {
    return this.update({ onboarded: true });
  }

  requireFixedTimeZone(value: string | null): void {
    if (value !== null && !isValidTimeZone(value)) {
      fail('VALIDATION', 'Unknown time zone.');
    }
  }

  /** Guard used by the UI before enabling notifications. */
  assertNotificationsAvailable(enabled: boolean): void {
    if (enabled && typeof Notification === 'undefined') {
      throw new TyagError(
        'UNAVAILABLE',
        'This platform does not support local notifications. Tyag will keep working without them.',
      );
    }
  }
}
