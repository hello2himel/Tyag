/** Error taxonomy for deUrge. Messages are safe to show to users. */
export type DeUrgeErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE'
  | 'IMPORT_INVALID'
  | 'IMPORT_UNSUPPORTED_VERSION'
  | 'IMPORT_CONFLICT'
  | 'CRYPTO'
  | 'UNAVAILABLE';

export interface DeUrgeErrorDetails {
  [field: string]: string;
}

export class DeUrgeError extends Error {
  readonly code: DeUrgeErrorCode;
  readonly details: DeUrgeErrorDetails;

  constructor(code: DeUrgeErrorCode, message: string, details: DeUrgeErrorDetails = {}) {
    super(message);
    this.name = 'DeUrgeError';
    this.code = code;
    this.details = details;
  }
}

export function isDeUrgeError(error: unknown): error is DeUrgeError {
  return error instanceof DeUrgeError;
}

export function fail(code: DeUrgeErrorCode, message: string, details?: DeUrgeErrorDetails): never {
  throw new DeUrgeError(code, message, details);
}

/** Convert any thrown value into a user-safe message (never leaks file paths). */
export function userMessage(error: unknown): string {
  if (isDeUrgeError(error)) return error.message;
  if (error instanceof Error && /quota|storage/i.test(error.message)) {
    return 'Your device could not save the change. Free up some storage space and try again.';
  }
  return 'Something went wrong while saving. Your existing data was left untouched.';
}
