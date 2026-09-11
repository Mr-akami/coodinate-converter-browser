/*
 * Entry point for tests and the demo page, not for applications.
 *
 * Preloading every grid in the Manifest downloads close to a gigabyte, which
 * is only reasonable when checking offline behaviour or filling a cache before
 * a benchmark. It is kept out of the public surface so no application reaches
 * for it by accident.
 */

import type { Proj } from './proj-api.js';
import type { PairSpec, Rpc } from './types.js';

export const INTERNAL_RPC: unique symbol = Symbol.for(
  'proj-wasm.internal.rpc',
) as never;

export interface PreloadOptions {
  onProgress?: (event: { done: number; total: number }) => void;
  signal?: AbortSignal;
}

export function preloadGrids(
  proj: Proj,
  spec: 'all' | PairSpec[],
  options: PreloadOptions = {},
): Promise<{ fetched: number }> {
  const rpc = (proj as unknown as Record<symbol, Rpc | undefined>)[INTERNAL_RPC];
  if (!rpc) throw new TypeError('preloadGrids: not a proj instance');
  return rpc.request(
    { type: 'preloadGrids', spec },
    { onProgress: options.onProgress as never, signal: options.signal },
  );
}
