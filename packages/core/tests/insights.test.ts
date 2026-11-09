import { describe, expect, it } from 'vitest';
import { DeUrgeError, MS_PER_DAY } from '../src/index';
import type { Insight } from '../src/index';
import { createTestCore, type TestCore } from './helpers';
import { seedRichCore } from './helpers/engines';

const DAY = MS_PER_DAY;

/** Saturday 2026-06-20 12:00 UTC. */
const NOW = Date.UTC(2026, 5, 20, 12, 0, 0);
/** Sunday 2026-03-01 12:00 UTC. */
const START = Date.UTC(2026, 2, 1, 12, 0, 0);

const INSIGHT_RULES_IN_ORDER = [
  'longest-streak',
  'accumulated',
  'lapse-trigger',
  'weekday-pattern',
  'streak-change',
  'urge-frequency',
  'urge-intensity-trend',
  'journal-activity',
];

/**
 * Build a tracker with enough history for every rule:
 *  - 7 lapses (3 in May, 4 in June) with a dominant "Stress" trigger
 *  - 3 urges in April, 3 in May, 4 in June
 *  - 1 journal entry in the last 30 days
 */
async function buildInsightScenario(): Promise<{ test: TestCore; trackerId: string }> {
  const test = await createTestCore({ now: NOW, timeZone: 'UTC' });
  const { core, clock } = test;
  clock.set(NOW);
  const tracker = await core.trackers.create({ name: 'Smoking', startedAt: START });
  const trackerId = tracker.id;

  const lapses: [number, string][] = [
    [Date.UTC(2026, 4, 4, 12), 'Stress'],
    [Date.UTC(2026, 4, 12, 12), 'Boredom'],
    [Date.UTC(2026, 4, 20, 12), 'Stress'],
    [Date.UTC(2026, 5, 2, 12), 'Stress'],
    [Date.UTC(2026, 5, 6, 12), 'Stress'],
    [Date.UTC(2026, 5, 10, 12), 'Boredom'],
    [Date.UTC(2026, 5, 15, 12), 'Stress'],
  ];
  for (const [occurredAt, trigger] of lapses) {
    clock.set(Math.max(occurredAt, START));
    await core.lapses.create({ trackerId, occurredAt, trigger });
  }

  const urges: [number, number][] = [
    [Date.UTC(2026, 3, 3, 12), 9], // April
    [Date.UTC(2026, 3, 10, 12), 8],
    [Date.UTC(2026, 3, 20, 12), 9],
    [Date.UTC(2026, 4, 6, 12), 8], // May
    [Date.UTC(2026, 4, 15, 12), 8],
    [Date.UTC(2026, 4, 22, 12), 7],
    [Date.UTC(2026, 5, 5, 12), 6], // June
    [Date.UTC(2026, 5, 9, 12), 5],
    [Date.UTC(2026, 5, 14, 12), 7],
    [Date.UTC(2026, 5, 19, 12), 4],
  ];
  for (const [occurredAt, intensity] of urges) {
    clock.set(occurredAt);
    await core.urges.create({ trackerId, occurredAt, intensity });
  }

  clock.set(Date.UTC(2026, 5, 19, 13));
  await core.journal.create({
    trackerId,
    occurredAt: Date.UTC(2026, 5, 19, 13),
    title: 'A month in',
    body: 'I kept going.',
  });
  clock.set(NOW);
  return { test, trackerId };
}

function ruleMap(insights: Insight[]): Map<string, Insight> {
  return new Map(insights.map((insight) => [insight.rule, insight]));
}

describe('insights: single tracker', () => {
  it('produces every rule in a stable order with period, sample size and caveat', async () => {
    const { test, trackerId } = await buildInsightScenario();
    const insights = test.core.insights.forTracker(trackerId);

    expect(insights.map((insight) => insight.rule)).toEqual(INSIGHT_RULES_IN_ORDER);
    expect(insights.every((insight) => insight.meaningful)).toBe(true);
    expect(insights.every((insight) => insight.text.length > 0)).toBe(true);
    expect(insights.every((insight) => insight.periodLabel.length > 0)).toBe(true);
    expect(insights.every((insight) => insight.caveat !== null && insight.caveat.length > 0)).toBe(true);
    expect(insights.every((insight) => insight.sampleSize > 0)).toBe(true);
    expect(insights.every((insight) => insight.id === `${trackerId}:${insight.rule}`)).toBe(true);

    const byRule = ruleMap(insights);
    expect(byRule.get('longest-streak')!.sampleSize).toBe(8); // 7 lapses + current interval
    expect(byRule.get('accumulated')!.sampleSize).toBe(8);
    expect(byRule.get('lapse-trigger')!.sampleSize).toBe(7);
    expect(byRule.get('lapse-trigger')!.text).toContain('Stress');
    expect(byRule.get('lapse-trigger')!.text).toContain('5 of 7');
    expect(byRule.get('weekday-pattern')!.sampleSize).toBe(7);
    expect(byRule.get('weekday-pattern')!.text).toContain('1 of your 7 recorded lapses');
    expect(byRule.get('weekday-pattern')!.text).toContain('Most fell on weekdays.');
    expect(byRule.get('streak-change')!.sampleSize).toBe(7);
    expect(byRule.get('streak-change')!.periodLabel).toBe('June 2026 vs May 2026');
    expect(byRule.get('streak-change')!.text).toContain('last month');
    expect(byRule.get('urge-frequency')!.sampleSize).toBe(7);
    expect(byRule.get('urge-frequency')!.text).toContain('4 urges this month and 3 urges last month');
    expect(byRule.get('urge-intensity-trend')!.sampleSize).toBe(10);
    expect(byRule.get('urge-intensity-trend')!.periodLabel).toBe('April 2026 – June 2026');
    expect(byRule.get('urge-intensity-trend')!.text).toContain('8.7 (April 2026)');
    expect(byRule.get('urge-intensity-trend')!.text).toContain('7.7 (May 2026)');
    expect(byRule.get('urge-intensity-trend')!.text).toContain('5.5 (June 2026)');
    expect(byRule.get('journal-activity')!.sampleSize).toBe(1);
    expect(byRule.get('journal-activity')!.text).toContain('1 journal entry');
  });

  it('is reproducible: the same records produce identical insights', async () => {
    const { test, trackerId } = await buildInsightScenario();
    const first = test.core.insights.forTracker(trackerId);
    const second = test.core.insights.forTracker(trackerId);
    expect(second).toEqual(first);
    expect(new Set(first.map((insight) => insight.id)).size).toBe(first.length);
  });

  it('avoids medical claims, predictions and causal language', async () => {
    const { test, trackerId } = await buildInsightScenario();
    for (const insight of test.core.insights.forTracker(trackerId)) {
      const text = insight.text.toLowerCase();
      expect(text).not.toMatch(/because|caused by|diagnos|you will|will improve|medical advice/);
    }
  });

  it('returns only tracked-time insights when there are no events yet', async () => {
    const test = await createTestCore({ now: NOW });
    test.clock.set(NOW - 3 * DAY);
    const tracker = await test.core.trackers.create({ name: 'New', startedAt: NOW - 3 * DAY });
    test.clock.set(NOW);
    const insights = test.core.insights.forTracker(tracker.id);
    expect(insights.map((insight) => insight.rule)).toEqual(['longest-streak', 'accumulated']);
    expect(insights.every((insight) => insight.meaningful)).toBe(true);
  });

  it('explicitly reports insufficient data when nothing is available', async () => {
    const test = await createTestCore({ now: NOW });
    const tracker = await test.core.trackers.create({ name: 'Brand new', startedAt: NOW });
    const insights = test.core.insights.forTracker(tracker.id);
    expect(insights).toHaveLength(1);
    const [insight] = insights;
    expect(insight!.rule).toBe('insufficient-data');
    expect(insight!.meaningful).toBe(false);
    expect(insight!.sampleSize).toBe(0);
    expect(insight!.text).toContain('Not enough data');
    expect(insight!.periodLabel.length).toBeGreaterThan(0);
    expect(insight!.caveat).not.toBeNull();
  });

  it('rejects unknown trackers', async () => {
    const test = await createTestCore({ now: NOW });
    expect(() => test.core.insights.forTracker('missing')).toThrow(DeUrgeError);
    try {
      test.core.insights.forTracker('missing');
    } catch (error) {
      expect((error as DeUrgeError).code).toBe('NOT_FOUND');
    }
  });

  it('groups months in the effective timezone', async () => {
    const test = await createTestCore({ now: Date.UTC(2026, 5, 10, 12), timeZone: 'America/New_York' });
    const { core, clock } = test;
    clock.set(Date.UTC(2026, 5, 10, 12));
    const tracker = await core.trackers.create({
      name: 'Boundary',
      startedAt: Date.UTC(2026, 3, 30, 12),
    });
    // Three urges in local May (late on May 31 local = June 1 UTC) and three in local June.
    const mayUrges = [
      Date.UTC(2026, 5, 1, 3, 30), // May 31 23:30 EDT
      Date.UTC(2026, 5, 1, 2, 30), // May 31 22:30 EDT
      Date.UTC(2026, 4, 31, 0, 30), // May 30 20:30 EDT
    ];
    const juneUrges = [
      Date.UTC(2026, 5, 2, 16),
      Date.UTC(2026, 5, 3, 16),
      Date.UTC(2026, 5, 4, 16),
    ];
    for (const occurredAt of [...mayUrges, ...juneUrges]) {
      clock.set(occurredAt);
      await core.urges.create({ trackerId: tracker.id, occurredAt, intensity: 5 });
    }
    clock.set(Date.UTC(2026, 5, 10, 12));
    const urgeInsight = core.insights
      .forTracker(tracker.id)
      .find((insight) => insight.rule === 'urge-frequency');
    expect(urgeInsight).toBeDefined();
    expect(urgeInsight!.text).toContain('3 urges this month and 3 urges last month');
  });
});

describe('insights: combined', () => {
  it('produces combined insights with tracker attribution', async () => {
    const seeded = await seedRichCore();
    const insights = seeded.core.insights.combined();
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.every((insight) => insight.meaningful)).toBe(true);
    expect(insights.every((insight) => insight.id.startsWith('combined:'))).toBe(true);
    const rules = insights.map((insight) => insight.rule);
    // Fixed relative order regardless of which rules qualify.
    expect(rules).toEqual([...rules].sort((a, b) => INSIGHT_RULES_IN_ORDER.indexOf(a) - INSIGHT_RULES_IN_ORDER.indexOf(b)));
    const byRule = ruleMap(insights);
    expect(byRule.get('longest-streak')).toBeDefined();
    expect(byRule.get('longest-streak')!.text).toContain('across all trackers');
    expect(byRule.get('longest-streak')!.text).toContain('"Smoking"');
    expect(byRule.get('accumulated')!.text).toContain('summed across 2 trackers');
    expect(byRule.get('journal-activity')).toBeDefined();
  });

  it('reports insufficient data when there are no trackers at all', async () => {
    const test = await createTestCore({ now: NOW });
    const insights = test.core.insights.combined();
    expect(insights).toHaveLength(1);
    expect(insights[0]!.rule).toBe('insufficient-data');
    expect(insights[0]!.meaningful).toBe(false);
    expect(insights[0]!.text).toContain('your trackers');
  });

  it('is reproducible', async () => {
    const seeded = await seedRichCore();
    expect(seeded.core.insights.combined()).toEqual(seeded.core.insights.combined());
  });
});
