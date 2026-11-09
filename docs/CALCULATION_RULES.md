# deUrge — Streak and statistics calculation rules

All calculations are deterministic functions of the stored records and the
current timestamp. Nothing is cached as a source of truth, and no calculation
depends on timers, device uptime or the order in which events were entered.

## 1. Stored data used by the engine

- `tracker.startedAt` — the original commitment start, in UTC epoch ms.
- `tracker_sessions` — half-open active intervals `[startedAt, endedAt)`.
  A `null` end means the tracker is running. A tracker has at most one open
  session (enforced by a partial unique index).
- `lapse_events` — `occurred_at` timestamps only; they are instantaneous
  events, not intervals.
- `urge_events`, `journal_entries`, `check_ins` — informational; urges never
  affect streak math.

Pausing closes the current session at the pause instant. Resuming opens a new
session at the resume instant. Archiving closes the session and freezes the
tracker; restoring returns it **paused** so the user explicitly chooses when
time starts counting again. Deleting a tracker permanently removes its
sessions, lapses, urges and tracker-scoped history (journal writing is kept and
detached), after an explicit confirmation.

## 2. Active time

```
activeIntervals = union( sessions ∩ [startedAt, now] )
activeTrackedMs = Σ (end - start) over activeIntervals
```

- Overlapping/corrupt sessions are merged defensively, never double counted.
- Future session ends are clipped to `now`.
- If `now < startedAt` (device clock moved backwards), elapsed and active time
  are clamped to 0; no negative durations are ever shown.

## 3. Uninterrupted intervals

Lapses are sorted by `occurredAt` (ties broken by id) — never by entry order.
Lapses before `startedAt` are invalid (the service rejects new ones and the
engine ignores any that arrive through a hand-edited import).

```
boundaries = [startedAt, L1, L2, …, Ln]
interval i = [boundaries[i], boundaries[i+1])   (last interval ends at now)
intervalActiveMs = activeOverlap(interval, activeIntervals)
```

For the current (last) interval, the end is `now`; active time inside it stops
while the tracker is paused.

### Definitions

| Metric | Definition |
| --- | --- |
| Current streak | `activeMs` of the last interval |
| Current streak start | last lapse time, or `startedAt` if no lapse |
| Longest streak | maximum `activeMs` across all intervals (earliest on ties) |
| Longest streak bounds | the interval's start/end timestamps |
| Total accumulated abstinence | `Σ activeMs` over **all** intervals = all non-paused time since `startedAt` |
| Completed abstinence | accumulated − current streak |
| Total elapsed since start | `now − startedAt` (wall clock, **includes paused intervals**) |
| Elapsed since tracker created | `now − createdAt` |
| Paused time | `max(0, elapsedSinceStart − accumulated)` |
| Number of streaks | number of intervals = `lapses + 1` |
| Average streak duration | accumulated ÷ number of intervals |
| Average/median between lapses | mean/median of `activeMs` for intervals that both start and end at a lapse (requires ≥ 2 lapses; otherwise `null`) |
| Time since previous lapse | `now − lastLapse.occurredAt` (wall clock; `null` with no lapses) |
| Lapses per active week | `lapses ÷ (accumulated ÷ 7 days)` |
| Lapses per active month | `lapses ÷ (accumulated ÷ 30.436875 days)` |

A period of abstinence is not invalidated by a lapse: earlier intervals remain
in accumulated abstinence, longest streak, averages and analytics.

## 4. Pauses — precise effects

- Paused wall time is never counted in current streak, longest streak,
  accumulated abstinence, streak durations or lapse spacing.
- Paused time **is** counted in "time since start", because that is wall-clock
  time since the commitment began. This is why accumulated and elapsed are
  always displayed separately.
- A lapse can be recorded while paused; it sets the anchor for the next streak.
  While still paused, no active time accrues after it.
- Archiving closes the session (like a pause) and freezes progress until the
  tracker is restored and explicitly resumed.

## 5. Percentages (denominator defined)

deUrge reports:

```
abstinent share of elapsed time = accumulatedAbstinenceMs ÷ elapsedSinceStartMs
```

- The **denominator is wall-clock time since the original start** and includes
  paused intervals, so pausing is visible in the number.
- The numerator is active (non-paused) abstinence time.
- Because a lapse is an instantaneous event and time immediately starts
  counting toward the next streak, every active second is abstinence time.
  There is therefore no separate "lapsed duration" to subtract. This is why
  the UI must not say "100% good" or use the number as a score.
- The same ratio is also exposed internally as `activeShareOfElapsed`
  (active tracked time ÷ elapsed); it is mathematically equal to the abstinent
  share by definition and is documented here to avoid confusion.
- "Percentage of tracked active time spent abstinent" is therefore **not**
  reported as a second number, because its denominator would be the same
  active time and the result would always be 100%. The precise, non-trivial
  denominator is wall-clock time since start.

## 6. Clock, timezone, DST and restarts

- All instants are UTC epoch milliseconds; durations use real elapsed
  milliseconds. A 23.5-hour gap is reported as 23 hours 30 minutes even when it
  crosses midnight or a DST boundary.
- Calendar grouping (analytics periods, weekday/hour distributions) uses the
  **effective timezone** from Settings (device timezone by default, or a fixed
  zone). Changing the timezone only changes calendar bucketing/display, never
  stored timestamps or durations.
- The IANA zone and UTC offset recorded with each event preserve the local
  context in which it happened.
- Temporal (DST- and leap-year-correct) is used for local day/week/month/
  quarter/year boundaries.
- Application restarts, device clock changes and suspended timers cannot alter
  history: every value is recomputed from stored timestamps on each render.
- Negative results are clamped to zero.

## 7. Backdating, edits and deletions

- A tracker start can be backdated. Moving the start earlier extends the first
  active session; moving it later trims/removes active time before it.
- Moving the start after a recorded lapse is rejected with a validation error
  until the conflicting events are edited.
- A lapse can be backdated within `[startedAt, now + 5 min]`. The dataset is
  always sorted chronologically, so a backdated event updates current/longest/
  accumulated/average statistics immediately.
- Editing a lapse timestamp or deleting a lapse recalculates every dependent
  value. Deleting a lapse does not delete the fact that it was recorded: a
  `lapse_deleted` entry (without notes) remains in the activity log.
- `retrospective` is true when an event's `occurredAt` is more than one hour
  before its `createdAt`.

## 8. Continuous progress recognition

Recognition messages are generated from the metrics above — there are no
milestones, badges, levels, trophies, completion targets or finite progression
systems anywhere in the application.

- Headline: current streak duration in human words (e.g. "Congratulations!
  You've stayed away from Social media for 12 days, 7 hours. Your progress
  continues.").
- A second sentence states accumulated abstinence across periods when it is
  greater than the current streak, without diminishing the new streak.
- After a lapse the new streak is acknowledged and earlier progress remains
  visible; no shame-based wording is used.
- Optional local notifications (disabled by default) repeat the same
  dynamic acknowledgement on a user-chosen interval. They never use
  thresholds or remote push services.

## 9. Analytics

- Period buckets: day/week/month/quarter/year in the effective timezone with
  the configured first day of week. Weekly buckets are DST-safe (Temporal).
- Per bucket: lapses, urges, journal entries, check-ins, average urge
  intensity, active tracking time and abstinent time overlapping the bucket.
- Combined view sums each tracker's metrics as *tracker-time* (it does not
  invent a de-duplicated wall-clock total; two trackers running simultaneously
  contribute twice).
- Trigger/reason/context distributions count recorded values only. Weekday and
  hour-of-day distributions use the local timezone and are descriptive.
- "Sample size" is shown wherever a rate/average is displayed (n = …).
- An unrecorded urge is never assumed to mean no urge occurred.

## 10. Insights

Rules only state what the records show, name the period, include the sample
size and explicitly say when there is not enough data. They never claim
causation, never diagnose, never predict future behaviour and never use
network or AI services.
