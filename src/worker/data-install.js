/*
 * Installing a Data Version.
 *
 * The Manifest names the version to run; its files go into that version's own
 * directory and the previous directories are deleted only once the new one is
 * complete, so a failed download never leaves the page with nothing. When the
 * Manifest cannot be fetched at all the newest complete local Data Version is
 * used instead, which is what makes the second visit work offline.
 *
 * Everything runs inside one Web Lock so two tabs cannot install at once.
 */

import { selectNewestCompleteVersion } from './data-version.js';
import { responseChunks, writeVerifiedFile } from './verified-write.js';

const INSTALL_LOCK = 'proj-data-install';
const MANIFEST_FILE = 'manifest.json';
const PROJ_DB_FILE = 'proj.db';

const manifestPath = (version) => `${version}/${MANIFEST_FILE}`;
const projDbPath = (version) => `${version}/${PROJ_DB_FILE}`;

function assertManifestShape(manifest) {
  if (!manifest || !manifest.version || !manifest.projDb || !manifest.grids) {
    throw new Error('manifest is missing version, projDb or grids');
  }
}

/**
 * Classifies the Manifest request once: either we have a Manifest, or we have
 * the reason we do not.
 */
async function requestManifest(fetchImpl, manifestUrl) {
  try {
    const response = await fetchImpl(manifestUrl, { cache: 'no-cache', redirect: 'follow' });
    if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`);
    const manifest = await response.json();
    assertManifestShape(manifest);
    return { manifest, unavailable: null };
  } catch (unavailable) {
    return { manifest: null, unavailable };
  }
}

async function collectGenerations(store) {
  const generations = [];
  for (const version of await store.list('')) {
    const manifestPublished = await store.isPublished(manifestPath(version));
    const projDbPublished = await store.isPublished(projDbPath(version));
    generations.push({
      version,
      manifestPublished,
      projDbPublished,
      // The sidecar is written when the install finished, so its timestamp is
      // the install time. Incomplete generations are dropped before any
      // comparison, so the placeholder is never read.
      installedAt: manifestPublished ? await store.lastModified(`${manifestPath(version)}.ok`) : 0,
    });
  }
  return generations;
}

async function startFromLocalVersion(store, unavailable) {
  const version = selectNewestCompleteVersion(await collectGenerations(store));
  if (!version) {
    throw new Error('proj-data manifest is unavailable and no complete local Data Version exists', {
      cause: unavailable,
    });
  }
  const manifest = JSON.parse(await store.readText(manifestPath(version)));
  return { dataVersion: version, manifest };
}

async function ensureManifestFile(store, manifest) {
  const path = manifestPath(manifest.version);
  if (await store.isPublished(path)) return;
  await writeVerifiedFile({
    store,
    path,
    source: [new TextEncoder().encode(JSON.stringify(manifest))],
    expected: null,
  });
}

async function ensureProjDb(store, manifest, fetchImpl, projDbUrlPattern, onProgress) {
  const path = projDbPath(manifest.version);
  if (await store.isPublished(path)) return;

  const url = projDbUrlPattern.replace('{version}', encodeURIComponent(manifest.version));
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`proj.db fetch failed: ${response.status}`);
  }
  const total = Number(response.headers.get('Content-Length') || 0);

  await writeVerifiedFile({
    store,
    path,
    source: responseChunks(response),
    expected: manifest.projDb,
    onBytes: onProgress
      ? (received) => onProgress({ stage: 'proj-db', bytes: received, total })
      : undefined,
  });
}

async function removeOtherVersions(store, version) {
  for (const entry of await store.list('')) {
    if (entry !== version) await store.remove(entry);
  }
}

/**
 * @param {{
 *   store: object,
 *   lock: {request: (name: string, callback: () => Promise<any>) => Promise<any>},
 *   fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
 *   manifestUrl: string,
 *   projDbUrlPattern: string,
 *   onProgress?: (event: {stage: string, bytes: number, total: number}) => void,
 * }} params
 * @returns {Promise<{dataVersion: string, manifest: object}>}
 */
export function installProjData({
  store, lock, fetchImpl, manifestUrl, projDbUrlPattern, onProgress,
}) {
  return lock.request(INSTALL_LOCK, async () => {
    const { manifest, unavailable } = await requestManifest(fetchImpl, manifestUrl);
    if (!manifest) return startFromLocalVersion(store, unavailable);

    await ensureManifestFile(store, manifest);
    await ensureProjDb(store, manifest, fetchImpl, projDbUrlPattern, onProgress);
    await removeOtherVersions(store, manifest.version);

    return { dataVersion: manifest.version, manifest };
  });
}
