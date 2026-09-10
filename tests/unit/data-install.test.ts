/*
 * Installing a Data Version into OPFS, against an in-memory store.
 *
 * Contracts under test (order.md Scope 3, 4, 5, 6 and the Verification item
 * "Add vitest coverage for the version-generation logic, the offline
 * fallback ... against an in-memory storage backend rather than real OPFS"):
 *   CT-VERDIR  a new Data Version is complete in its own directory before the
 *              old one is deleted; no startup re-verification
 *   CT-PUBLISH written under the final name once, `<name>.ok` published only
 *              after the bytes verify, no `move()` and no `.part` double write
 *   CT-OFFLINE manifest requested with `no-cache`; when it cannot be fetched,
 *              start from the newest complete local Data Version
 *   CT-LOCK    the install and the deletion of the old Data Version happen
 *              inside one Web Lock
 *   CT-PROGRESS `onProgress` keeps reporting `{stage:'proj-db', bytes, total}`
 */

import { describe, expect, it } from 'vitest';

import { installProjData } from '../../src/worker/data-install.js';

import {
  bytesResponse,
  createFakeFetch,
  deferredBytesResponse,
  jsonResponse,
  statusResponse,
} from './support/fake-fetch';
import { createFakeLock } from './support/fake-lock';
import { createMemoryStore, type MemoryStore } from './support/memory-store';
import { createOpLog, type OpLog } from './support/op-log';
import { fixtureBytes, makeManifest, type Manifest } from './support/manifest-factory';

const MANIFEST_URL = 'https://data.test/api/proj-data/manifest';
const PROJ_DB_URL_PATTERN = 'https://data.test/api/proj-data/v/{version}/proj.db';

const projDbUrl = (version: string) => PROJ_DB_URL_PATTERN.replace('{version}', version);

interface Harness {
  log: OpLog;
  store: MemoryStore;
  lock: ReturnType<typeof createFakeLock>;
}

function harness(): Harness {
  const log = createOpLog();
  return { log, store: createMemoryStore(log), lock: createFakeLock(log) };
}

function install(
  h: Harness,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  onProgress?: (event: { stage: string; bytes: number; total: number }) => void,
) {
  return installProjData({
    store: h.store,
    lock: h.lock,
    fetchImpl,
    manifestUrl: MANIFEST_URL,
    projDbUrlPattern: PROJ_DB_URL_PATTERN,
    onProgress,
  });
}

function serving(manifest: Manifest, projDb: Uint8Array, chunkSize = 16) {
  return createFakeFetch({
    [MANIFEST_URL]: () => jsonResponse(manifest),
    [projDbUrl(manifest.version)]: () => bytesResponse(projDb, chunkSize),
  });
}

function offlineFetch() {
  return createFakeFetch({});
}

describe('installProjData — remote Data Version', () => {
  it('requests the manifest with no-cache', async () => {
    const h = harness();
    const db = fixtureBytes(1, 128);
    const remote = serving(makeManifest('v1', db), db);

    await install(h, remote.fetchImpl);

    expect(remote.calls[0]!.url).toBe(MANIFEST_URL);
    expect(remote.calls[0]!.init?.cache).toBe('no-cache');
  });

  it('installs the Data Version into its own directory', async () => {
    const h = harness();
    const db = fixtureBytes(1, 128);
    const manifest = makeManifest('v1', db);

    const result = await install(h, serving(manifest, db).fetchImpl);

    expect(result.dataVersion).toBe('v1');
    expect(result.manifest.version).toBe('v1');
    expect(h.store.bytes('v1/proj.db')).toEqual(db);
    expect(JSON.parse(h.store.text('v1/manifest.json')).version).toBe('v1');
    expect(await h.store.isPublished('v1/proj.db')).toBe(true);
    expect(await h.store.isPublished('v1/manifest.json')).toBe(true);
  });

  it('writes each file once under its final name', async () => {
    const h = harness();
    const db = fixtureBytes(1, 128);

    await install(h, serving(makeManifest('v1', db), db).fetchImpl);

    expect(h.store.paths().filter((path) => path.includes('.part'))).toEqual([]);
    expect(h.log.entries.filter((op) => op === 'writeStream:v1/proj.db')).toHaveLength(1);
  });

  it('clears the stale sidecar before the body is written and publishes only after it closes', async () => {
    const h = harness();
    const db = fixtureBytes(1, 128);

    await install(h, serving(makeManifest('v1', db), db).fetchImpl);

    const removeSidecar = h.log.indexOf('remove:v1/proj.db.ok');
    const openBody = h.log.indexOf('writeStream:v1/proj.db');
    const closeBody = h.log.indexOf('close:v1/proj.db');
    const publish = h.log.indexOf('publish:v1/proj.db');

    expect(removeSidecar).toBeGreaterThanOrEqual(0);
    expect(removeSidecar).toBeLessThan(openBody);
    expect(closeBody).toBeLessThan(publish);
  });

  it('reports proj.db download progress with cumulative bytes and the total', async () => {
    const h = harness();
    const db = fixtureBytes(1, 128);
    const events: Array<{ stage: string; bytes: number; total: number }> = [];

    await install(h, serving(makeManifest('v1', db), db, 16).fetchImpl, (event) => {
      events.push(event);
    });

    const projDbEvents = events.filter((event) => event.stage === 'proj-db');
    expect(projDbEvents.map((event) => event.bytes)).toEqual([16, 32, 48, 64, 80, 96, 112, 128]);
    expect(projDbEvents.every((event) => event.total === 128)).toBe(true);
  });
});

describe('installProjData — verification before publish', () => {
  it('does not publish proj.db when the bytes do not match the manifest hash', async () => {
    const h = harness();
    const expected = fixtureBytes(1, 128);
    const served = fixtureBytes(2, 128);
    const manifest = makeManifest('v1', expected);
    const remote = createFakeFetch({
      [MANIFEST_URL]: () => jsonResponse(manifest),
      [projDbUrl('v1')]: () => bytesResponse(served),
    });

    await expect(install(h, remote.fetchImpl)).rejects.toThrow();

    expect(await h.store.isPublished('v1/proj.db')).toBe(false);
    expect(h.store.paths().filter((path) => path.includes('.part'))).toEqual([]);
  });

  it('does not publish proj.db when the download is short', async () => {
    const h = harness();
    const expected = fixtureBytes(1, 128);
    const manifest = makeManifest('v1', expected);
    const remote = createFakeFetch({
      [MANIFEST_URL]: () => jsonResponse(manifest),
      [projDbUrl('v1')]: () => bytesResponse(expected.subarray(0, 100)),
    });

    await expect(install(h, remote.fetchImpl)).rejects.toThrow();

    expect(await h.store.isPublished('v1/proj.db')).toBe(false);
  });

  it('overwrites the unverified body on the next attempt and publishes it', async () => {
    const h = harness();
    const expected = fixtureBytes(1, 128);
    const manifest = makeManifest('v1', expected);
    const failing = createFakeFetch({
      [MANIFEST_URL]: () => jsonResponse(manifest),
      [projDbUrl('v1')]: () => bytesResponse(fixtureBytes(2, 128)),
    });

    await expect(install(h, failing.fetchImpl)).rejects.toThrow();
    await install(h, serving(manifest, expected).fetchImpl);

    expect(h.store.bytes('v1/proj.db')).toEqual(expected);
    expect(await h.store.isPublished('v1/proj.db')).toBe(true);
  });
});

describe('installProjData — Data Version switch on one store', () => {
  it('keeps the current Data Version until the new one is complete', async () => {
    const h = harness();
    const db1 = fixtureBytes(1, 128);
    await install(h, serving(makeManifest('v1', db1), db1).fetchImpl);

    const db2 = fixtureBytes(2, 128);
    const manifest2 = makeManifest('v2', db2);
    const download = deferredBytesResponse(db2.length);
    const remote = createFakeFetch({
      [MANIFEST_URL]: () => jsonResponse(manifest2),
      [projDbUrl('v2')]: () => download.response,
    });

    const pending = install(h, remote.fetchImpl);
    download.push(db2.subarray(0, 64));
    await h.log.waitFor((op) => op === 'write:v2/proj.db');

    expect(await h.store.isPublished('v1/proj.db')).toBe(true);
    expect(h.store.bytes('v1/proj.db')).toEqual(db1);

    download.push(db2.subarray(64));
    download.close();
    const result = await pending;

    expect(result.dataVersion).toBe('v2');
    expect(await h.store.list('')).toEqual(['v2']);
  });

  it('leaves the current Data Version usable when the new one fails to install', async () => {
    const h = harness();
    const db1 = fixtureBytes(1, 128);
    const manifest1 = makeManifest('v1', db1);
    await install(h, serving(manifest1, db1).fetchImpl);

    const db2 = fixtureBytes(2, 128);
    const broken = createFakeFetch({
      [MANIFEST_URL]: () => jsonResponse(makeManifest('v2', db2)),
      [projDbUrl('v2')]: () => bytesResponse(fixtureBytes(3, 128)),
    });
    await expect(install(h, broken.fetchImpl)).rejects.toThrow();

    expect(await h.store.isPublished('v1/proj.db')).toBe(true);
    expect(await h.store.isPublished('v2/proj.db')).toBe(false);

    const offline = await install(h, offlineFetch().fetchImpl);

    expect(offline.dataVersion).toBe('v1');
    expect(h.store.bytes('v1/proj.db')).toEqual(db1);
  });

  it('does not re-download or re-read published files of the current Data Version', async () => {
    const h = harness();
    const db = fixtureBytes(1, 128);
    const manifest = makeManifest('v1', db);
    await install(h, serving(manifest, db).fetchImpl);

    const mark = h.log.entries.length;
    const remote = serving(manifest, db);
    await install(h, remote.fetchImpl);
    const ops = h.log.entries.slice(mark);

    expect(remote.urls()).toEqual([MANIFEST_URL]);
    expect(ops.filter((op) => /^(writeStream|write|close|getFile|readText):v1\/proj\.db$/.test(op)))
      .toEqual([]);
  });

  it('takes one Web Lock and performs every store mutation inside it', async () => {
    const h = harness();
    const db1 = fixtureBytes(1, 128);
    const manifest1 = makeManifest('v1', db1);
    h.store.seedPublished('v1/manifest.json', JSON.stringify(manifest1), 100);
    h.store.seedPublished('v1/proj.db', db1, 100);

    const db2 = fixtureBytes(2, 128);
    await install(h, serving(makeManifest('v2', db2), db2).fetchImpl);

    expect(h.lock.names).toHaveLength(1);
    expect(h.lock.held).toBe(false);

    const acquire = h.log.entries.findIndex((op) => op.startsWith('lock:acquire:'));
    const release = h.log.entries.findIndex((op) => op.startsWith('lock:release:'));
    const mutations = h.log.entries
      .map((op, index) => ({ op, index }))
      .filter(({ op }) => /^(writeStream|write|close|publish|remove):/.test(op));

    expect(mutations.some(({ op }) => op === 'remove:v1')).toBe(true);
    const outsideLock = mutations
      .filter(({ index }) => index < acquire || index > release)
      .map(({ op }) => op);
    expect(outsideLock).toEqual([]);
  });
});

describe('installProjData — offline start', () => {
  function seedGenerations(store: MemoryStore) {
    const db1 = fixtureBytes(1, 128);
    const db2 = fixtureBytes(2, 128);
    const db3 = fixtureBytes(3, 128);
    store.seedPublished('v1/manifest.json', JSON.stringify(makeManifest('v1', db1)), 100);
    store.seedPublished('v1/proj.db', db1, 100);
    store.seedPublished('v2/manifest.json', JSON.stringify(makeManifest('v2', db2)), 200);
    store.seedPublished('v2/proj.db', db2, 200);
    // Newest on disk but never finished installing: proj.db has no sidecar.
    store.seedPublished('v3/manifest.json', JSON.stringify(makeManifest('v3', db3)), 300);
    store.seedUnpublished('v3/proj.db', db3, 300);
  }

  it('starts from the newest complete local Data Version when the manifest request fails', async () => {
    const h = harness();
    seedGenerations(h.store);

    const result = await install(h, offlineFetch().fetchImpl);

    expect(result.dataVersion).toBe('v2');
    expect(result.manifest.version).toBe('v2');
  });

  it('treats a manifest error response as unavailable', async () => {
    const h = harness();
    seedGenerations(h.store);
    const remote = createFakeFetch({ [MANIFEST_URL]: () => statusResponse(503) });

    const result = await install(h, remote.fetchImpl);

    expect(result.dataVersion).toBe('v2');
  });

  it('keeps every local Data Version when the manifest cannot be fetched', async () => {
    const h = harness();
    seedGenerations(h.store);
    const before = h.store.paths();

    await install(h, offlineFetch().fetchImpl);

    expect(h.store.paths()).toEqual(before);
  });

  it('fails when the manifest cannot be fetched and no local Data Version is complete', async () => {
    const h = harness();
    const db = fixtureBytes(1, 128);
    h.store.seedUnpublished('v1/manifest.json', JSON.stringify(makeManifest('v1', db)), 100);
    h.store.seedUnpublished('v1/proj.db', db, 100);

    await expect(install(h, offlineFetch().fetchImpl)).rejects.toThrow();
  });
});
