/*
 * The transform and preload flow, owned by the worker.
 *
 * Order matters here: which grids the operation needs, which of those the
 * Data Origin ships, when the strict check runs and when PROJ's caches are
 * invalidated together decide what the browser suite observes. The default
 * mode matches cs2cs — an unavailable grid falls through to the ballpark
 * operation — while strict mode refuses to answer instead.
 */

import { MissingGridError } from '../errors.js';
import { createLru } from './lru.js';

// One entry per (CRS pair, 1 degree cell). Bounded so a long session cannot
// grow it without limit; large enough to keep neighbouring points cache-hot.
const PREPARE_CACHE_CAPACITY = 64;
const PRELOAD_BATCH_SIZE = 6;

function basenameOf(path) {
  if (!path || typeof path !== 'string') return '';
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function nameFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const slash = url.lastIndexOf('/');
  if (slash < 0) return '';
  const tail = url.slice(slash + 1);
  const query = tail.indexOf('?');
  return query >= 0 ? tail.slice(0, query) : tail;
}

// PROJ reports fullName as an absolute path when the grid is on disk and as
// "" when it is not, so the Manifest name comes from whichever field has it.
function resolveGridName(grid) {
  return basenameOf(grid.fullName) || nameFromUrl(grid.url) || grid.shortName || '';
}

/**
 * @param {{
 *   projModule: {
 *     gridsNeeded: (src: string, dst: string, x: number, y: number, discardMissing: number) => Array<object>,
 *     strictCheck: (src: string, dst: string, x: number, y: number) => number,
 *     transform: (src: string, dst: string, x: number, y: number, z: number) => {x: number, y: number, z: number},
 *     refreshAfterGridWrite: () => void,
 *   },
 *   gridProvider: {
 *     isMounted: (name: string) => boolean,
 *     ensureGrid: (name: string, options?: {signal?: AbortSignal}) => Promise<void>,
 *   },
 *   manifest: {grids: Record<string, {size: number, sha256: string}>},
 * }} deps
 */
export function createTransformFlow({ projModule, gridProvider, manifest }) {
  const preparedGridSets = createLru(PREPARE_CACHE_CAPACITY);
  // Once a pair is known to have an instantiable non-ballpark operation with
  // the mounted grids, repeat calls skip the check until grids change.
  const strictCheckedOk = new Set();

  function refreshMounts() {
    projModule.refreshAfterGridWrite();
    strictCheckedOk.clear();
  }

  function prepareGridSet(src, dst, x, y, strict) {
    /*
     * The cache key carries a coarse coordinate cell because PROJ picks a
     * different regional operation per point (NAD27 to WGS84 needs HPGN-NY in
     * the northeast and HPGN-CS in California). The cell only decides how
     * often grids are re-enumerated; PROJ still picks the operation per point.
     */
    const cell = (Number.isFinite(x) && Number.isFinite(y))
      ? `${Math.floor(x)}|${Math.floor(y)}`
      : 'nan';
    const key = `${src}|${dst}|${cell}`;
    const cached = preparedGridSets.get(key);
    if (cached) return cached;

    let enumerated;
    try {
      enumerated = projModule.gridsNeeded(src, dst, x, y, 0);
    } catch (err) {
      // Ballpark-only pairs and CRS resolution failures still go to
      // pw_transform, which decides; strict mode keeps the classified error.
      if (strict && err instanceof MissingGridError) throw err;
      enumerated = [];
    }

    const grids = enumerated.map((grid) => ({
      shortName: grid.shortName || '',
      fullName: resolveGridName(grid),
      url: grid.url || '',
    }));
    preparedGridSets.set(key, grids);
    return grids;
  }

  function followUpGrids(src, dst, x, y, missing) {
    let enumerated;
    try {
      enumerated = projModule.gridsNeeded(src, dst, x, y, 1);
    } catch {
      // This second enumeration only widens what we can fetch; without it the
      // transform still runs with whatever is mounted.
      return [];
    }

    const extra = [];
    for (const grid of enumerated) {
      const name = resolveGridName(grid);
      if (!name || !manifest.grids[name] || gridProvider.isMounted(name)) continue;
      if (missing.some((entry) => entry.fullName === name)) continue;
      if (extra.some((entry) => entry.fullName === name)) continue;
      extra.push({ shortName: name, fullName: name, url: '' });
    }
    return extra;
  }

  function verifyStrictOperation(src, dst, x, y) {
    const pairKey = `${src}|${dst}`;
    if (strictCheckedOk.has(pairKey)) return;

    if (projModule.strictCheck(src, dst, x, y) === 1) {
      strictCheckedOk.add(pairKey);
      return;
    }

    const missing = projModule
      .gridsNeeded(src, dst, x, y, 0)
      .filter((grid) => !grid.available && grid.fullName);
    throw new MissingGridError(
      missing.length
        ? `missing grid(s): ${missing.map((grid) => grid.fullName).join(', ')}`
        : 'no non-ballpark operation available (ballpark only)',
      {
        reason: missing.length ? 'missing_grid' : 'ballpark_only',
        missingGrids: missing.map((grid) => ({
          shortName: grid.shortName,
          fullName: grid.fullName,
          url: grid.url,
        })),
      },
    );
  }

  /**
   * @param {{src: string, dst: string, x: number, y: number, z: number,
   *          strict?: boolean, signal?: AbortSignal}} request
   */
  async function transform({ src, dst, x, y, z, strict = false, signal }) {
    const grids = prepareGridSet(src, dst, x, y, strict);
    const missing = grids.filter(
      (grid) => grid.fullName && !gridProvider.isMounted(grid.fullName),
    );

    const unshippable = missing.filter((grid) => !manifest.grids[grid.fullName]);
    if (unshippable.length > 0 && !strict) {
      missing.push(...followUpGrids(src, dst, x, y, missing));
    }

    if (missing.length > 0) {
      const notInManifest = missing.filter((grid) => !manifest.grids[grid.fullName]);
      if (notInManifest.length > 0 && strict) {
        throw new MissingGridError(
          `grid(s) not in manifest: ${notInManifest.map((grid) => grid.fullName).join(', ')}`,
          { reason: 'missing_grid', missingGrids: notInManifest },
        );
      }

      let ensured = 0;
      for (const grid of missing.filter((entry) => manifest.grids[entry.fullName])) {
        try {
          await gridProvider.ensureGrid(grid.fullName, { signal });
          ensured += 1;
        } catch (err) {
          // Default mode keeps cs2cs behaviour and lets pw_transform fall back.
          if (strict) throw err;
        }
      }
      if (ensured > 0) refreshMounts();
    }

    if (strict) verifyStrictOperation(src, dst, x, y);
    return projModule.transform(src, dst, x, y, z);
  }

  function resolvePreloadNames(spec) {
    if (spec === 'all') return Object.keys(manifest.grids);
    if (!Array.isArray(spec)) {
      throw new Error('preloadGrids: spec must be "all" or an array of {src,dst,x?,y?}');
    }

    const names = new Set();
    for (const pair of spec) {
      for (const grid of projModule.gridsNeeded(pair.src, pair.dst, pair.x, pair.y, 0)) {
        const name = resolveGridName(grid);
        if (name && !grid.available) names.add(name);
      }
    }
    return [...names];
  }

  /**
   * @param {'all' | Array<{src: string, dst: string, x?: number, y?: number}>} spec
   * @param {{onProgress?: (event: {done: number, total: number}) => void, signal?: AbortSignal}} [options]
   */
  async function preloadGrids(spec, options = {}) {
    const { onProgress, signal } = options;
    const names = resolvePreloadNames(spec);
    if (names.length === 0) {
      if (onProgress) onProgress({ done: 0, total: 0 });
      return { fetched: 0 };
    }

    const total = names.length;
    let done = 0;
    for (let start = 0; start < names.length; start += PRELOAD_BATCH_SIZE) {
      const batch = names.slice(start, start + PRELOAD_BATCH_SIZE);
      await Promise.all(batch.map((name) => gridProvider.ensureGrid(name, { signal })));
      done += batch.length;
      if (onProgress) onProgress({ done, total });
    }
    refreshMounts();
    return { fetched: done };
  }

  function clearPrepareCache() {
    preparedGridSets.clear();
  }

  return { transform, preloadGrids, clearPrepareCache };
}
