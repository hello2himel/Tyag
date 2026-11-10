/** Error taxonomy for Tyag. Messages are safe to show to users. */
export type TyagErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE'
  | 'IMPORT_INVALID'
  | 'IMPORT_UNSUPPORTED_VERSION'
  | 'IMPORT_CONFLICT'
  | 'CRYPTO'
  | 'UNAVAILABLE';

export interface TyagErrorDetails {
  [field: string]: string;
}

export class TyagError extends Error {
  readonly code: TyagErrorCode;
  readonly details: TyagErrorDetails;

  constructor(code: TyagErrorCode, message: string, details: TyagErrorDetails = {}) {
    super(message);
    this.name = 'TyagError';
    this.code = code;
    this.details = details;
  }
}

export function isTyagError(error: unknown): error is TyagError {
  return error instanceof TyagError;
}

export function fail(code: TyagErrorCode, message: string, details?: TyagErrorDetails): never {
  throw new TyagError(code, message, details);
}

/** Convert any thrown value into a user-safe message (never leaks file paths). */
export function userMessage(error: unknown): string {
  if (isTyagError(error)) return error.message;
  if (error instanceof Error && /quota|storage/i.test(error.message)) {
    return 'Your device could not save the change. Free up some storage space and try again.';
  }
  return 'Something went wrong while saving. Your existing data was left untouched.';
}
