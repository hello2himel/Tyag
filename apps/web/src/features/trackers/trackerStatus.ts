/** Small presentation helpers for tracker status, shared by the trackers UI. */
import type { TrackerStatus } from '@deurge/core';

export const TRACKER_STATUS_LABEL: Record<TrackerStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

/** Class for a `<span className={...} />` status dot (global `.dot` styles). */
export function trackerStatusDotClass(status: TrackerStatus): string {
  return status === 'active' ? 'dot' : `dot ${status}`;
}
