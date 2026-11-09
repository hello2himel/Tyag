/** Map any thrown value to a user-safe message for the Data & Backups screen. */
import { isDeUrgeError, userMessage } from '@deurge/core';

export interface ActionFailure {
  message: string;
  /** True when the feature itself is missing (engine stub), not the user's data. */
  unavailable: boolean;
}

export function describeFailure(error: unknown): ActionFailure {
  if (isDeUrgeError(error)) {
    return { message: userMessage(error), unavailable: error.code === 'UNAVAILABLE' };
  }
  const raw = error instanceof Error ? error.message : '';
  if (/not implemented|not available|is not a function/i.test(raw)) {
    return { message: 'This feature is not available in this build yet. Nothing was changed.', unavailable: true };
  }
  return { message: userMessage(error), unavailable: false };
}
