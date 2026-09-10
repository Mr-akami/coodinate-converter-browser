/*
 * Error types shared by the main thread and the worker.
 *
 * A worker reply carries `errorKind`; the RPC layer turns that single value
 * back into the error the caller sees, so the classification exists once.
 */

/** Reasons that identify a MissingGridError across the worker boundary. */
export const MISSING_GRID_REASONS = ['missing_grid', 'ballpark_only', 'fetch_failed', 'hash_mismatch'];

export class MissingGridError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   reason: 'missing_grid' | 'ballpark_only' | 'fetch_failed' | 'hash_mismatch',
   *   missingGrids?: Array<{shortName: string, fullName: string, url: string}>,
   *   cause?: unknown,
   * }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'MissingGridError';
    this.reason = info.reason;
    this.missingGrids = info.missingGrids;
    if (info.cause !== undefined) this.cause = info.cause;
  }
}

/** The worker died; every request on that instance is unrecoverable. */
export class ProjWorkerError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown}} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'ProjWorkerError';
  }
}

/** Downloaded bytes did not match the size / sha256 the Manifest declares. */
export class DataVerificationError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown}} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'DataVerificationError';
  }
}
