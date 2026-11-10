/**
 * Insights screen: period and tracker selectors, all-time statistics, period
 * charts and the "From your records" insight rules.
 *
 * Statistics are all-time; charts cover the most recent local calendar periods
 * (week/month/quarter/year). Both come from the analytics engine, and every
 * card states its sample size. If an engine is unavailable the screen explains
 * it instead of guessing.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  isTyagError,
  userMessage,
  type CombinedAnalytics,
  type Granularity,
  type Insight,
  type Tracker,
  type TrackerAnalytics,
} from '@tyag/core';
import { useApp } from '../../store/app';
import { navigate } from '../../router';
import { BarChart, Button, Card, Chip, EmptyState, Segmented, StatTile } from '../../ui/components';
import { useFormatters } from '../../ui/format';
import {
  WINDOW_PERIODS,
  WINDOW_UNIT,
  analyticsWindow,
  combinedStats,
  lapseBars,
  periodTotals,
  trackerStats,
  urgeBars,
  type StatSpec,
} from './insightsUtils';
import './insights.css';

type View =
  | { kind: 'combined'; data: CombinedAnalytics }
  | { kind: 'tracker'; data: TrackerAnalytics; tracker: Tracker }
  | { kind: 'error'; message: string };

type InsightsView = { kind: 'ok'; insights: Insight[] } | { kind: 'error'; message: string };

const PERIOD_OPTIONS: { value: Granularity; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

export function InsightsScreen() {
  const app = useApp();
  const fmt = useFormatters();
  const { timeZone, settings } = app;

  const trackers = useMemo(() => app.core.trackers.list(), [app.core, app.version]);

  const [period, setPeriod] = useState<Granularity>('month');
  const [selected, setSelected] = useState<'all' | string>('all');

  useEffect(() => {
    if (selected !== 'all' && !trackers.some((tracker) => tracker.id === selected)) setSelected('all');
  }, [selected, trackers]);

  const view = useMemo<View>(() => {
    const window = analyticsWindow(period, Date.now(), timeZone, settings.firstDayOfWeek);
    const options = {
      granularity: window.granularity,
      from: window.from,
      to: window.to,
      periodLimit: window.periodLimit,
    };
    try {
      if (selected === 'all') {
        return { kind: 'combined', data: app.core.analytics.combined(options) };
      }
      const tracker = app.core.trackers.get(selected);
      return { kind: 'tracker', tracker, data: app.core.analytics.forTracker(selected, options) };
    } catch (error) {
      return {
        kind: 'error',
        message: isTyagError(error)
          ? userMessage(error)
          : 'Analytics could not be calculated right now. Your records are still on this device.',
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.core, app.version, selected, period, timeZone, settings.firstDayOfWeek]);

  const insightsView = useMemo<InsightsView>(() => {
    try {
      if (selected === 'all') return { kind: 'ok', insights: app.core.insights.combined() };
      return { kind: 'ok', insights: app.core.insights.forTracker(selected) };
    } catch (error) {
      return {
        kind: 'error',
        message: isTyagError(error)
          ? userMessage(error)
          : 'Insights are not available in this build yet. Your records are unaffected.',
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.core, app.version, selected, timeZone, settings.firstDayOfWeek, settings.dateFormat]);

  const stats = useMemo<StatSpec[]>(() => {
    if (view.kind === 'combined') return combinedStats(view.data, fmt);
    if (view.kind === 'tracker') return trackerStats(view.data.metrics, fmt);
    return [];
  }, [view, fmt]);

  const totals = useMemo(() => (view.kind === 'error' ? null : periodTotals(view.data.periods)), [view]);

  const rangeLabel = useMemo(() => {
    if (view.kind === 'error') return null;
    const periods = view.data.periods;
    const first = periods[0];
    const last = periods[periods.length - 1];
    if (!first || !last) return null;
    return `${fmt.dateCompact(first.startAt)} – ${fmt.dateCompact(last.endAt - 1)}`;
  }, [view, fmt]);

  const selectionName = view.kind === 'tracker' ? view.tracker.name : 'All trackers';
  const unit = WINDOW_UNIT[period];
  const periodCount = WINDOW_PERIODS[period];
  const unitPlural = `${unit}s`;

  const noRecords = useMemo(() => {
    if (view.kind === 'error') return false;
    const metrics = view.kind === 'combined' ? view.data.trackers : [view.data.metrics];
    return metrics.every((entry) => entry.lapseCount === 0 && entry.urgeCount === 0 && entry.journalCount === 0);
  }, [view]);

  const trackerHasWindowData =
    totals !== null && (totals.lapses > 0 || totals.urges > 0 || totals.journal > 0 || totals.checkIns > 0);

  if (trackers.length === 0) {
    return (
      <main className="screen">
        <div className="screen-head">
          <div>
            <h1 className="screen-title">Insights</h1>
            <div className="sub">Based on your records on this device.</div>
          </div>
        </div>
        <EmptyState
          title="Nothing to measure yet"
          body="Add a tracker and record something. Insights appear once there is enough data, with the sample size shown."
          action={
            <div className="row-start" style={{ justifyContent: 'center' }}>
              <Button variant="primary" onClick={() => navigate('/trackers?new=1')}>
                Create a tracker
              </Button>
              <Button onClick={() => navigate('/journal?new=1')}>Write an entry</Button>
            </div>
          }
        />
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Insights</h1>
          <div className="sub">Based on your records on this device.</div>
        </div>
      </div>

      <div className="stack" style={{ marginBottom: 16 }}>
        <Segmented options={PERIOD_OPTIONS} value={period} onChange={setPeriod} ariaLabel="Chart period" />
        <div className="chips" role="group" aria-label="Tracker">
          <Chip selected={selected === 'all'} onClick={() => setSelected('all')}>
            All
          </Chip>
          {trackers.map((tracker) => (
            <Chip key={tracker.id} selected={selected === tracker.id} onClick={() => setSelected(tracker.id)} title={tracker.name}>
              {tracker.name}
            </Chip>
          ))}
        </div>
        <div className="insights-window">
          <span>{selectionName}</span>
          <span aria-hidden="true">·</span>
          <span>
            Last {periodCount} {unitPlural}
            {rangeLabel ? ` (${rangeLabel})` : ''}
          </span>
          <span aria-hidden="true">·</span>
          <span>{timeZone}</span>
        </div>
      </div>

      {view.kind === 'error' ? (
        <div className="stack">
          <div className="notice error" role="alert">
            {view.message}
          </div>
          <div className="row-start">
            <Button onClick={() => app.refresh()}>Try again</Button>
            <Button variant="plain" onClick={() => navigate('/trackers')}>
              Go to trackers
            </Button>
          </div>
        </div>
      ) : (
        <div className="stack-lg">
          {noRecords ? (
            <div className="notice">
              <strong>No records for {selectionName.toLowerCase()} yet.</strong> Statistics show zeros and charts stay empty until
              you record a lapse or urge. <Button variant="plain" size="sm" onClick={() => navigate('/trackers')}>Open trackers</Button>
            </div>
          ) : null}

          <section aria-labelledby="insights-alltime">
            <h2 className="lb insights-section-label" id="insights-alltime">
              All-time
            </h2>
            <div className="stat-grid">
              {stats.map((stat) => (
                <StatTile key={stat.label} label={stat.label} value={stat.value} hint={stat.hint} />
              ))}
            </div>
            <p className="tiny insights-note">
              Abstinent share is accumulated abstinence ÷ time since start. Paused time counts toward time since start but not
              toward accumulated time, so the share falls while a tracker is paused. In the combined view, accumulated time is
              tracker-time: two parallel trackers both contribute. Every figure above is computed from stored records.
            </p>
          </section>

          <section aria-labelledby="insights-charts">
            <h2 className="lb insights-section-label" id="insights-charts">
              {`Per ${unit}`}
            </h2>
            <div className="insights-charts">
              <Card className="chart-card">
                <div className="chart-head">
                  <span className="chart-title">Lapses per {unit}</span>
                  <span className="chart-n">n = {totals?.lapses ?? 0}</span>
                </div>
                {totals && totals.lapses > 0 ? (
                  <BarChart
                    data={lapseBars(view.data.periods, period, timeZone)}
                    tone="lapse"
                    ariaLabel={`Lapses per ${unit} over the last ${periodCount} ${unitPlural}`}
                  />
                ) : (
                  <div className="chart-empty">No lapses recorded in this window.</div>
                )}
              </Card>

              <Card className="chart-card">
                <div className="chart-head">
                  <span className="chart-title">Avg urge intensity</span>
                  <span className="chart-n">n = {totals?.urges ?? 0}</span>
                </div>
                {totals && totals.urges > 0 ? (
                  <BarChart
                    data={urgeBars(view.data.periods, period, timeZone)}
                    tone="urge"
                    max={10}
                    ariaLabel={`Average urge intensity per ${unit} over the last ${periodCount} ${unitPlural}`}
                  />
                ) : (
                  <div className="chart-empty">No urges recorded in this window.</div>
                )}
                <div className="tiny insights-chart-note">
                  Bars show the recorded average (0–10) for each {unit}; periods without urges leave a zero mark.
                </div>
              </Card>
            </div>
          </section>

          <Card className="card-pad insights-window-card">
            <div className="insights-kicker">IN THIS WINDOW</div>
            <div className="insights-window-counts">
              <span>
                <strong>{totals?.lapses ?? 0}</strong> lapses
              </span>
              <span>
                <strong>{totals?.urges ?? 0}</strong> urges
              </span>
              <span>
                <strong>{totals?.journal ?? 0}</strong> journal
              </span>
              <span>
                <strong>{totals?.checkIns ?? 0}</strong> check-ins
              </span>
            </div>
            <p className="tiny">
              {trackerHasWindowData
                ? `Counted across the ${periodCount} ${unitPlural} shown above. Short windows can be too small to compare.`
                : `No records in the last ${periodCount} ${unitPlural}. Widen the period or add records.`}
            </p>
          </Card>

          <Card className="card-pad insights-records">
            <div className="insights-kicker">FROM YOUR RECORDS</div>
            {insightsView.kind === 'error' ? (
              <div className="notice" role="status">
                {insightsView.message}
              </div>
            ) : insightsView.insights.length === 0 ? (
              <p className="sub">
                No insight rules had enough data for {selected === 'all' ? 'your trackers' : selectionName} yet. Insights appear
                once there are a few records. Each one shows its period and sample size.
              </p>
            ) : (
              <div className="insight-list">
                {insightsView.insights.map((insight) => (
                  <article key={insight.id} className={`insight ${insight.meaningful ? '' : 'insufficient'}`}>
                    <p className="insight-text">{insight.text}</p>
                    <div className="insight-meta">
                      {insight.meaningful ? null : <span className="insight-tag">Not enough data</span>}
                      <span>{insight.periodLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>n = {insight.sampleSize}</span>
                    </div>
                    {insight.caveat ? <p className="tiny insight-caveat">{insight.caveat}</p> : null}
                  </article>
                ))}
              </div>
            )}
            <p className="tiny insights-note">
              Insights are deterministic rules that run on this device. They describe patterns for the stated sample size; they
              do not claim causes and do not predict the future.
            </p>
          </Card>
        </div>
      )}
    </main>
  );
}
