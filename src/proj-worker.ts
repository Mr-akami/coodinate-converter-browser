/*
 * PROJ worker: the only owner of OPFS, MEMFS and the PROJ context.
 *
 * It installs the Data Version, loads the wasm module, mounts grids and runs
 * transforms. The main thread never holds grid bytes. Requests run one at a
 * time because they share the PROJ context and the mount table; an abort
 * message jumps that queue so it can reach work already in flight.
 */

import { MissingGridError } from './errors.js';
import { installProjData } from './worker/data-install.js';
import { createGridProvider } from './worker/grid-provider.js';
import { createOpfsStore, createWebLock } from './worker/opfs-store.js';
import { createProjModule } from './worker/proj-module.js';
import { createTransformFlow, type TransformFlow } from './worker/transform-flow.js';
import type { FetchImpl, ProgressEvent } from './types.js';

let flow: TransformFlow | null = null;
let queue = Promise.resolve();
const running = new Map<unknown, AbortController>();

const fetchImpl: FetchImpl = (url, init) => fetch(url, init);

function postProgress(id: unknown, event: ProgressEvent) {
  self.postMessage({ type: 'progress', id, ...event });
}

function requireFlow(): TransformFlow {
  if (!flow) throw new Error('proj runtime is not initialised');
  return flow;
}

async function handleInit(message: any) {
  const { apiBaseUrl, dataDirName, memfsPath, wasmUrl, moduleUrl } = message;

  const store = await createOpfsStore(dataDirName);
  const { dataVersion, manifest } = await installProjData({
    store,
    lock: createWebLock(),
    fetchImpl,
    manifestUrl: `${apiBaseUrl}/manifest`,
    projDbUrlPattern: `${apiBaseUrl}/v/{version}/proj.db`,
    onProgress: (event) => postProgress(message.id, event),
  });

  const projDbFile = await store.getFile(`${dataVersion}/proj.db`);
  const projModule = await createProjModule({
    moduleUrl,
    wasmUrl,
    memfsPath,
    projDbBytes: new Uint8Array(await projDbFile.arrayBuffer()),
  });

  const gridProvider = createGridProvider({
    store,
    fs: projModule.fs,
    memfsPath,
    dataVersion,
    gridsBaseUrl: `${apiBaseUrl}/v/${encodeURIComponent(dataVersion)}/grids/`,
    manifest,
    fetchImpl,
  });
  const alreadyStored = await gridProvider.mountPublishedGrids();
  if (alreadyStored > 0) projModule.refreshAfterGridWrite();

  flow = createTransformFlow({ projModule, gridProvider, manifest });
  return { type: 'ready', manifest, dataVersion };
}

async function handleTransform(message: any, signal?: AbortSignal) {
  const result = await requireFlow().transform({
    src: message.src,
    dst: message.dst,
    x: message.x,
    y: message.y,
    z: message.z,
    allowBallpark: message.allowBallpark === true,
    signal,
  });
  return { type: 'result', x: result.x, y: result.y, z: result.z };
}

async function handleTransformMany(message: any, signal?: AbortSignal) {
  // The array arrives as a transferred buffer and goes back the same way, so
  // a large batch is never copied between threads.
  const xyz = new Float64Array(message.xyz);
  await requireFlow().transformMany({
    src: message.src,
    dst: message.dst,
    xyz,
    allowBallpark: message.allowBallpark === true,
    signal,
  });
  return { type: 'resultMany', xyz: xyz.buffer, transfer: [xyz.buffer] };
}

async function handleDescribe(message: any, signal?: AbortSignal) {
  const info = await requireFlow().describe({
    src: message.src,
    dst: message.dst,
    x: message.x,
    y: message.y,
    allowBallpark: message.allowBallpark !== false,
    signal,
  });
  return { type: 'described', info };
}

function handleListCrs(message: any) {
  return {
    type: 'crsList',
    crs: requireFlow().listCrs({
      lon: message.lon,
      lat: message.lat,
      kinds: message.kinds,
      authorities: message.authorities,
    }),
  };
}

async function handlePreloadGrids(message: any, signal?: AbortSignal) {
  const result = await requireFlow().preloadGrids(message.spec, {
    signal,
    onProgress: (event) => postProgress(message.id, event),
  });
  return { type: 'preloaded', fetched: result.fetched };
}

function handleClearPrepareCache() {
  requireFlow().clearPrepareCache();
  return { type: 'prepareCacheCleared' };
}

function route(message: any, signal?: AbortSignal): Promise<any> | any {
  switch (message.type) {
    case 'init':
      return handleInit(message);
    case 'transform':
      return handleTransform(message, signal);
    case 'transformMany':
      return handleTransformMany(message, signal);
    case 'describe':
      return handleDescribe(message, signal);
    case 'listCrs':
      return handleListCrs(message);
    case 'preloadGrids':
      return handlePreloadGrids(message, signal);
    case 'clearPrepareCache':
      return handleClearPrepareCache();
    default:
      throw new Error(`unknown message type: ${message.type}`);
  }
}

function errorReply(id: unknown, err: any) {
  const reply: {
    type: string;
    id: unknown;
    error: string;
    errorKind?: string;
    missingGrids?: unknown;
  } = {
    type: 'error',
    id,
    error: err instanceof Error ? err.message : String(err),
  };
  if (err instanceof MissingGridError) {
    reply.errorKind = err.reason;
    reply.missingGrids = err.missingGrids;
  }
  return reply;
}

async function dispatch(message: any, controller: AbortController) {
  try {
    const payload = await route(message, controller.signal);
    // A reply may hand back an ArrayBuffer it wants transferred rather than
    // copied; `transfer` carries that list and is not part of the reply.
    const { transfer, ...reply } = payload;
    self.postMessage({ ...reply, id: message.id }, transfer || []);
  } catch (err) {
    self.postMessage(errorReply(message.id, err));
  } finally {
    running.delete(message.id);
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;

  if (message.type === 'abort') {
    running.get(message.id)?.abort();
    return;
  }

  const controller = new AbortController();
  running.set(message.id, controller);
  const ticket = queue.then(() => dispatch(message, controller));
  queue = ticket.catch(() => undefined);
});
