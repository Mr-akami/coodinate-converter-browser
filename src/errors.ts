/*
 * Error types shared by the main thread and the worker.
 *
 * A worker reply carries `errorKind`; the RPC layer turns that single value
 * back into the error the caller sees, so the classification exists once.
 */

import type { GridRef } from './types.js';

/** Why an accurate transform could not be answered. */
export type MissingGridReason =
  | 'missing_grid'
  | 'ballpark_only'
  | 'fetch_failed'
  | 'hash_mismatch';

/** Reasons that identify a MissingGridError across the worker boundary. */
export const MISSING_GRID_REASONS: MissingGridReason[] = [
  'missing_grid', 'ballpark_only', 'fetch_failed', 'hash_mismatch',
];

export interface MissingGridInfo {
  reason: MissingGridReason;
  missingGrids?: GridRef[];
  /** Where a strict transform needed them (input axis order), when known. */
  point?: { x: number; y: number };
  cause?: unknown;
}

export class MissingGridError extends Error {
  readonly name = 'MissingGridError';
  readonly reason: MissingGridReason;
  readonly missingGrids: GridRef[] | undefined;
  readonly point: { x: number; y: number } | undefined;

  constructor(message: string, info: MissingGridInfo) {
    super(message);
    this.reason = info.reason;
    this.missingGrids = info.missingGrids;
    this.point = info.point;
    if (info.cause !== undefined) this.cause = info.cause;
  }
}

/** The worker died; every request on that instance is unrecoverable. */
export class ProjWorkerError extends Error {
  readonly name = 'ProjWorkerError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Downloaded bytes did not match the size / sha256 the Manifest declares. */
export class DataVerificationError extends Error {
  readonly name = 'DataVerificationError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
