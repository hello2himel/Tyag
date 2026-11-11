/**
 * Continuous progress recognition.
 *
 * There are no milestones, badges, levels or completion targets anywhere in
 * Tyag. The message below is generated from the same metrics the streak
 * engine produces, so it is accurate to the second and works for every
 * duration, from seconds to years. After a lapse the new streak is
 * acknowledged while accumulated progress is still stated.
 */
import type { Recognition, Tracker, TrackerMetrics } from '../domain';
import { formatDurationLong } from '../time/duration';

export interface RecognitionOptions {
  /** Optional shorter format for compact surfaces. */
  short?: boolean;
}

export function buildRecognition(
  tracker: Tracker,
  metrics: TrackerMetrics,
  options: RecognitionOptions = {},
): Recognition {
  const current = metrics.currentStreakMs;
  const accumulated = metrics.accumulatedAbstinenceMs;
  const name = tracker.name;

  if (tracker.status === 'archived') {
    return {
      headline: `You've archived ${name}. Your history and ${formatDurationLong(accumulated, { maxUnits: 2 })} of accumulated abstinence are still here.`,
      accumulated: null,
      currentStreakMs: current,
      accumulatedMs: accumulated,
    };
  }

  if (tracker.status === 'paused') {
    return {
      headline: `You've paused ${name}. Your ${formatDurationLong(accumulated, { maxUnits: 2 })} of accumulated progress is preserved.`,
      accumulated: null,
      currentStreakMs: current,
      accumulatedMs: accumulated,
    };
  }

  if (metrics.lapseCount === 0 && current > 0) {
    const duration = formatDurationLong(current, { maxUnits: options.short ? 1 : 2 });
    return {
      headline: `Congratulations! You've stayed away from ${name} for ${duration}.`,
      accumulated: options.short
        ? null
        : `Every moment of it counts: this is ${duration} of uninterrupted progress.`,
      currentStreakMs: current,
      accumulatedMs: accumulated,
    };
  }

  if (current > 0) {
    const duration = formatDurationLong(current, { maxUnits: options.short ? 1 : 2 });
    const accumulatedText =
      accumulated > current
        ? `You've also accumulated ${formatDurationLong(accumulated, { maxUnits: 2 })} across ${metrics.streakCount} abstinence periods. That progress is yours to keep.`
        : null;
    return {
      headline: `Congratulations! You've stayed away from ${name} for ${duration}. Your progress continues.`,
      accumulated: options.short ? null : accumulatedText,
      currentStreakMs: current,
      accumulatedMs: accumulated,
    };
  }

  // Zero-length streak: either just started, just recorded a lapse, or paused
  // before any active time was recorded.
  return {
    headline: `Your next moment of progress for ${name} starts now. All earlier progress (${formatDurationLong(accumulated, { maxUnits: 2 })}) stays in your history.`,
    accumulated: null,
    currentStreakMs: current,
    accumulatedMs: accumulated,
  };
}
