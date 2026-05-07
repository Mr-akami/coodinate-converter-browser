/*
 * Public JS API for the PROJ wasm runtime.
 *
 * Notable behavior change vs prior versions:
 *   `transform` now performs a two-phase RPC under the hood (prepare → addGrids → transform).
 *   When required grid files are missing or the best-accuracy operation cannot
 *   be instantiated, this throws `MissingGridError` with a structured `reason`.
 *   It never silently falls back to a less-accurate Helmert / ballpark path.
 */

export class MissingGridError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   reason: 'missing_grid' | 'ballpark_only' | 'fetch_failed' | 'hash_mismatch' | 'version_mismatch',
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

let _nextId = 0;
function rpc(worker, msg, transferables) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const handler = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', handler);
      if (e.data.type === 'error') {
        reject(buildErrorFromMessage(e.data));
      } else {
        resolve(e.data);
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...msg, id }, transferables || []);
  });
}

function derivedNameFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const idx = url.lastIndexOf('/');
  if (idx < 0) return '';
  const tail = url.slice(idx + 1);
  // Strip any query string.
  const q = tail.indexOf('?');
  return q >= 0 ? tail.slice(0, q) : tail;
}

function basenameOf(p) {
  if (!p || typeof p !== 'string') return '';
  // PROJ returns fullName as an absolute MEMFS path (e.g.
  // "/proj-data/be_ign_bd72lb72_etrs89lb08.tif") when the grid is found on
  // disk, and "" otherwise. We always want the basename for manifest /
  // OPFS / mountedGridNames lookups.
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function buildErrorFromMessage(msg) {
  if (msg.errorKind === 'missing_grid' || msg.errorKind === 'ballpark_only') {
    return new MissingGridError(msg.error || msg.errorKind, {
      reason: msg.errorKind,
      missingGrids: msg.missingGrids,
    });
  }
  return new Error(msg.error || 'rpc error');
}

/**
 * @param {Worker} worker
 * @param {{
 *   gridsBaseUrl: string,
 *   manifest: { version: string, grids: Record<string, {size: number, sha256: string}> },
 * }} cfg
 */
export function createProjApi(worker, cfg) {
  if (!worker) throw new Error('worker is required');
  if (!cfg || !cfg.gridsBaseUrl || !cfg.manifest) {
    throw new Error('gridsBaseUrl and manifest are required');
  }

  // Single-flight de-dup for grid fetches (Codex: race protection).
  /** @type {Map<string, Promise<{name:string, bytes:Uint8Array}>>} */
  const inFlightFetches = new Map();

  // Serialize transform calls (Codex: race protection on shared C state).
  /** @type {Promise<unknown>} */
  let transformQueue = Promise.resolve();

  // Per-(src,dst) cached "needed grids" list. PROJ proj_create_operations is
  // expensive, so we avoid re-running it for repeated transforms with the
  // same pair (e.g. a benchmark loop or a CSV comparison). Cleared whenever
  // we add grids or explicitly drop the cache.
  /** @type {Map<string, Array<{shortName:string, fullName:string, url:string}>>} */
  const preparedGridSets = new Map();

  // Names of grid files we have already mounted into MEMFS via addGrids.
  /** @type {Set<string>} */
  const mountedGridNames = new Set(cfg.preloadedGridNames || []);

  async function fetchGrid(name) {
    const existing = inFlightFetches.get(name);
    if (existing) return existing;

    const p = (async () => {
      const entry = cfg.manifest.grids[name];
      if (!entry) {
        throw new MissingGridError(`grid not in manifest: ${name}`, {
          reason: 'missing_grid',
          missingGrids: [{ shortName: name, fullName: name, url: '' }],
        });
      }

      const url = cfg.gridsBaseUrl + encodeURIComponent(name);
      let res;
      try {
        res = await fetch(url, { credentials: 'same-origin' });
      } catch (cause) {
        throw new MissingGridError(`fetch failed: ${name}`, {
          reason: 'fetch_failed',
          missingGrids: [{ shortName: name, fullName: name, url }],
          cause,
        });
      }
      if (!res.ok || !res.body) {
        throw new MissingGridError(`fetch failed (${res.status}): ${name}`, {
          reason: 'fetch_failed',
          missingGrids: [{ shortName: name, fullName: name, url }],
        });
      }

      const buf = new Uint8Array(await res.arrayBuffer());

      if (buf.length !== entry.size) {
        throw new MissingGridError(`size mismatch: ${name}`, {
          reason: 'hash_mismatch',
          missingGrids: [{ shortName: name, fullName: name, url }],
        });
      }
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== entry.sha256) {
        throw new MissingGridError(`sha256 mismatch: ${name}`, {
          reason: 'hash_mismatch',
          missingGrids: [{ shortName: name, fullName: name, url }],
        });
      }

      return { name, bytes: buf };
    })();

    inFlightFetches.set(name, p);
    try {
      return await p;
    } finally {
      inFlightFetches.delete(name);
    }
  }

  /**
   * Transform a coordinate.
   * @param {string} src source CRS (e.g. 'EPSG:4326')
   * @param {string} dst target CRS
   * @param {number} x lon / easting
   * @param {number} y lat / northing
   * @param {number} z height (default 0)
   * @param {{strict?: boolean}} [opts]
   *   strict=true: throw MissingGridError when a required grid for the
   *     best non-ballpark op cannot be fetched (no silent Helmert fallback).
   *   strict=false (default): match cs2cs default behavior — try to fetch
   *     and mount required grids, but if a grid is unavailable (not in
   *     manifest, server 404, hash mismatch), continue with the ballpark
   *     fallback that PROJ would have used anyway.
   */
  async function transform(src, dst, x, y, z = 0, opts = {}) {
    if (!src || !dst) throw new Error('src and dst are required');
    const ticket = transformQueue.then(() => doTransform(src, dst, x, y, z, opts));
    transformQueue = ticket.catch(() => undefined);
    return ticket;
  }

  async function doTransform(src, dst, x, y, z, { strict = false } = {}) {
    /*
     * Cache key includes a coarse coordinate bucket because
     * proj_get_suggested_operation returns DIFFERENT regional ops for
     * coords in different cells (e.g. NAD27→WGS84 needs HPGN-NY in the
     * northeast and HPGN-CS in California). Bucketing by ~1° lat/lon keeps
     * neighbouring transforms cache-hot while ensuring distant points
     * trigger a fresh enumeration so we fetch their grids too.
     */
    const bucket = (Number.isFinite(x) && Number.isFinite(y))
      ? `${Math.floor(x)}|${Math.floor(y)}`
      : 'nan';
    const key = `${src}|${dst}|${bucket}`;
    let grids = preparedGridSets.get(key);

    if (!grids) {
      // Phase 1: ask the worker which grids are needed for the best-accuracy op.
      let prepResp;
      try {
        prepResp = await rpc(worker, { type: 'prepare', src, dst, x, y });
      } catch (e) {
        // ballpark_only / CRS resolution errors: fall through to transform,
        // which will use ballpark fallback (or fail if PROJ also can't find
        // any op).
        if (strict && e instanceof MissingGridError) throw e;
        prepResp = { grids: [] };
      }

      grids = (prepResp.grids || []).map((g) => ({
        shortName: g.shortName || '',
        // When the grid is on disk, PROJ returns the full MEMFS path; strip
        // the directory so we always have the basename. When the grid is
        // missing, PROJ returns "" — derive from the CDN URL or fall back
        // to shortName.
        fullName: basenameOf(g.fullName) || derivedNameFromUrl(g.url) || g.shortName || '',
        url: g.url || '',
      }));
      preparedGridSets.set(key, grids);
    }

    let missing = grids.filter((g) => g.fullName && !mountedGridNames.has(g.fullName));

    // If the IDEAL grid set has entries the server can't ship, ask for the
    // grids that pw_transform's actual fallback op would use instead. This
    // is how we fetch e.g. the 2.5x2.5 EGM2008 grid when PROJ's preferred
    // 1x1 grid isn't in the bundle.
    const idealUnshippable = missing.filter((g) => !cfg.manifest.grids[g.fullName]);
    if (idealUnshippable.length > 0 && !strict) {
      try {
        const fbResp = await rpc(worker, {
          type: 'prepare', src, dst, x, y, discardMissing: 1,
        });
        const fbGrids = (fbResp.grids || [])
          .map((g) => basenameOf(g.fullName) || derivedNameFromUrl(g.url) || g.shortName || '')
          .filter(Boolean)
          .filter((name) => cfg.manifest.grids[name] && !mountedGridNames.has(name));
        for (const name of fbGrids) {
          if (!missing.some((m) => m.fullName === name)) {
            missing.push({ shortName: name, fullName: name, url: '' });
          }
        }
      } catch {
        /* fallback enumeration failed — proceed with whatever we have */
      }
    }

    if (missing.length > 0) {
      // Pre-flight: any required grid that the server doesn't have in its
      // manifest cannot be fetched. In strict mode this is fatal; otherwise
      // we just skip the fetch and let pw_transform use the ballpark fallback.
      const notInManifest = missing.filter((g) => !cfg.manifest.grids[g.fullName]);
      if (notInManifest.length > 0 && strict) {
        throw new MissingGridError(
          `grid(s) not in manifest: ${notInManifest.map((g) => g.fullName).join(', ')}`,
          { reason: 'missing_grid', missingGrids: notInManifest },
        );
      }

      // Fetch the grids that ARE in the manifest. In strict mode any failure
      // is fatal; in default mode we log and proceed to ballpark fallback.
      const fetchable = missing.filter((g) => cfg.manifest.grids[g.fullName]);
      const fetched = [];
      for (const g of fetchable) {
        try {
          fetched.push(await fetchGrid(g.fullName));
        } catch (e) {
          if (strict) throw e;
          // Suppress: ballpark fallback in pw_transform will handle the missing grid.
        }
      }

      if (fetched.length > 0) {
        // Persist BEFORE handing the buffer off to the worker — the worker
        // transfer detaches the underlying ArrayBuffer on this side, so any
        // OPFS write attempted afterwards would see zero bytes.
        if (cfg.persistGridsToOpfs) {
          await Promise.all(fetched.map((f) =>
            cfg.persistGridsToOpfs(f.name, f.bytes).catch((err) => {
              console.warn('[proj-api] OPFS persist failed:', f.name, err);
            })
          ));
        }
        const transferables = fetched.map((f) => f.bytes.buffer);
        await rpc(worker, {
          type: 'addGrids',
          grids: fetched.map((f) => ({ name: f.name, bytes: f.bytes })),
        }, transferables);
        for (const f of fetched) mountedGridNames.add(f.name);
      }
    }

    // In strict mode, ask the worker to verify the best non-ballpark op is
    // instantiable. In default mode skip this — pw_transform will pick the
    // best AVAILABLE op (including ballpark) the same way cs2cs does.
    if (strict) {
      const verify = await rpc(worker, {
        type: 'transform', src, dst, x, y, z, _strict: true,
      });
      return { x: verify.x, y: verify.y, z: verify.z };
    }

    const result = await rpc(worker, { type: 'transform', src, dst, x, y, z });
    return { x: result.x, y: result.y, z: result.z };
  }

  /*
   * Pre-fetch a set of grids and mount them all into the wasm worker before
   * any subsequent transform. Pass `'all'` to load every grid in the
   * manifest, or an array of CRS pairs `[{src, dst, x?, y?}, ...]` to load
   * only what those transforms would need.
   *
   * Errors propagate (fetch_failed, hash_mismatch). On success the worker
   * has run pw_refresh_after_grid_write once at the end so all loaded grids
   * are immediately visible to PROJ.
   *
   * Serializes against transform() via the same queue.
   */
  async function preloadGrids(spec, options = {}) {
    const ticket = transformQueue.then(() => doPreload(spec, options));
    transformQueue = ticket.catch(() => undefined);
    return ticket;
  }

  async function doPreload(spec, { onProgress } = {}) {
    let names;
    if (spec === 'all') {
      names = Object.keys(cfg.manifest.grids);
    } else if (Array.isArray(spec)) {
      const set = new Set();
      for (const pair of spec) {
        const prepResp = await rpc(worker, {
          type: 'prepare',
          src: pair.src,
          dst: pair.dst,
          x: pair.x,
          y: pair.y,
        });
        for (const g of prepResp.grids || []) {
          const fullName = g.fullName || derivedNameFromUrl(g.url) || g.shortName || '';
          if (fullName && !g.available) set.add(fullName);
        }
      }
      names = [...set];
    } else {
      throw new Error('preloadGrids: spec must be "all" or an array of {src,dst,x?,y?}');
    }

    if (names.length === 0) {
      if (onProgress) onProgress({ done: 0, total: 0 });
      return { fetched: 0 };
    }

    const total = names.length;
    let done = 0;

    // Fetch in parallel batches of N (avoid overwhelming network).
    const batchSize = 6;
    /** @type {Array<{name:string, bytes:Uint8Array}>} */
    const fetched = [];
    for (let i = 0; i < names.length; i += batchSize) {
      const slice = names.slice(i, i + batchSize);
      const got = await Promise.all(slice.map((name) => fetchGrid(name)));
      fetched.push(...got);
      done += got.length;
      if (onProgress) onProgress({ done, total });
    }

    // Persist to OPFS before transferring to the worker (transfer detaches
    // the buffer on this side).
    if (cfg.persistGridsToOpfs) {
      await Promise.all(fetched.map((f) =>
        cfg.persistGridsToOpfs(f.name, f.bytes).catch((err) => {
          console.warn('[proj-api] OPFS persist failed:', f.name, err);
        })
      ));
    }

    // Hand all bytes off to the worker in one batch (single context refresh).
    const transferables = fetched.map((f) => f.bytes.buffer);
    await rpc(worker, {
      type: 'addGrids',
      grids: fetched.map((f) => ({ name: f.name, bytes: f.bytes })),
    }, transferables);

    for (const f of fetched) mountedGridNames.add(f.name);
    return { fetched: fetched.length };
  }

  function clearPrepareCache() {
    preparedGridSets.clear();
  }

  return {
    transform,
    preloadGrids,
    manifest: cfg.manifest,
    clearPrepareCache,
    _fetchGrid: fetchGrid,
  };
}
