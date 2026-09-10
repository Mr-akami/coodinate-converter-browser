/*
 * Node entry point.
 *
 * The reason this exists is not speed — a native binding would win — but
 * agreement. A server and a browser that disagree about a coordinate are worse
 * than either being slightly slow, and they will disagree if they run
 * different PROJ builds against different data. Here both run the same wasm
 * module, built from the same PROJ tag, against the same proj.db and the same
 * grids, so they select the same operation and return the same numbers.
 *
 * On Node the data is already on the machine, so none of the browser's
 * machinery applies: no Manifest, no downloads, no hashing, no OPFS. The
 * directory is mounted with NODEFS and PROJ reads it directly.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createProjApi } from './proj-api.js';
import { createRpc } from './rpc.js';

export {
  MissingGridError,
  ProjWorkerError,
  DataVerificationError,
} from './errors.js';

const MEMFS_MOUNT = '/proj-data';

let warnedAboutProjLib = false;

/**
 * Where proj-data lives: what the caller said, else PROJ_DATA, else PROJ_LIB.
 * PROJ deprecated PROJ_LIB in favour of PROJ_DATA, but a great many machines
 * still set only the old one, so it is accepted with a warning rather than
 * ignored.
 *
 * @param {string | undefined} explicit
 * @returns {string}
 */
export function resolveDataDir(explicit, env = process.env) {
  const candidates = [
    { value: explicit, from: 'the dataDir option' },
    { value: env.PROJ_DATA, from: 'PROJ_DATA' },
    { value: env.PROJ_LIB, from: 'PROJ_LIB' },
  ];

  const tried = [];
  for (const { value, from } of candidates) {
    if (!value) continue;
    const dir = isAbsolute(value) ? value : resolve(process.cwd(), value);
    if (existsSync(resolve(dir, 'proj.db'))) {
      if (from === 'PROJ_LIB' && !warnedAboutProjLib) {
        warnedAboutProjLib = true;
        console.warn(
          '[proj] found proj-data through PROJ_LIB, which PROJ has deprecated; set PROJ_DATA instead',
        );
      }
      return dir;
    }
    tried.push(`${dir} (from ${from})`);
  }

  throw new Error(
    tried.length
      ? `no proj.db found. Looked in:\n  ${tried.join('\n  ')}`
      : 'no proj-data directory given. Pass dataDir, or set PROJ_DATA to a directory containing proj.db',
  );
}

/**
 * @param {{
 *   dataDir?: string,
 *   inProcess?: boolean,
 *   wasmUrl?: string,
 *   moduleUrl?: string,
 * }} [options]
 */
export async function createProjNode({
  dataDir,
  inProcess = false,
  moduleUrl,
} = {}) {
  const resolvedDataDir = resolveDataDir(dataDir);
  const resolvedModuleUrl = moduleUrl
    ? new URL(moduleUrl, import.meta.url).href
    : new URL('../dist/proj_wasm.js', import.meta.url).href;

  const init = {
    type: 'init',
    node: { dataDir: resolvedDataDir, memfsPath: MEMFS_MOUNT },
    moduleUrl: resolvedModuleUrl,
    wasmUrl: fileURLToPath(new URL('./proj_wasm.wasm', resolvedModuleUrl)),
  };

  const transport = inProcess
    ? await createInProcessTransport()
    : createWorkerThreadTransport();

  const rpc = createRpc(transport);
  let ready;
  try {
    ready = await rpc.request(init);
  } catch (err) {
    rpc.dispose();
    throw err;
  }
  return createProjApi(rpc, ready.manifest);
}

/*
 * A worker thread by default: a server handling requests must not have its
 * event loop blocked by a batch of transforms. inProcess is for scripts and
 * command line tools, where a thread buys nothing.
 */
function createWorkerThreadTransport() {
  const workerPath = fileURLToPath(new URL('./node-worker.js', import.meta.url));
  const worker = new Worker(workerPath);
  worker.unref();

  return {
    addEventListener(type, handler) {
      if (type === 'message') worker.on('message', (data) => handler({ data }));
      else if (type === 'error') worker.on('error', (error) => handler(error));
    },
    postMessage(message, transfer) {
      worker.postMessage(message, transfer);
    },
    terminate() {
      void worker.terminate();
    },
  };
}

/*
 * Same protocol, no thread: the handler is called directly and its reply is
 * delivered on the next tick, so callers cannot tell the difference beyond
 * the event loop being occupied while a transform runs.
 */
async function createInProcessTransport() {
  const require = createRequire(import.meta.url);
  void require;
  const { createNodeSession } = await import('./worker/node-session.js');
  const session = createNodeSession();

  /** @type {Set<(event: {data: unknown}) => void>} */
  const listeners = new Set();

  return {
    addEventListener(type, handler) {
      if (type === 'message') listeners.add(handler);
    },
    postMessage(message) {
      session
        .handle(message)
        .then((reply) => {
          for (const listener of listeners) listener({ data: reply });
        })
        .catch(() => undefined);
    },
    terminate() {
      listeners.clear();
    },
  };
}
