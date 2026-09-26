/*
 * The Node side of the worker protocol.
 *
 * It speaks the same messages as the browser worker so the API layer above is
 * identical, but the setup underneath is much shorter: the data is already on
 * the machine, so there is nothing to install, verify, fetch or mount on
 * demand. NODEFS gives PROJ the directory as it is.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createProjModule } from './proj-module.js';
import { createTransformFlow, type TransformFlow } from './transform-flow.js';
import type { GridProvider } from '../types.js';

/*
 * Every grid the directory holds is already visible to PROJ, so the flow's
 * fetch-and-mount step has nothing to do. Saying so here, rather than
 * special-casing Node inside the flow, keeps the transform path identical in
 * both environments.
 */
const everythingPresent: GridProvider = {
  isMounted: () => true,
  ensureGrid: async () => undefined,
};

/*
 * The browser's Data Version is the hash of proj.db, and using the same rule
 * here means a server and a browser reporting the same version really are
 * reading the same database.
 */
async function dataVersionOf(dbPath: string): Promise<string> {
  const bytes = await readFile(dbPath);
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function createNodeSession() {
  let flow: TransformFlow | null = null;
  let dataVersion: string | null = null;

  function requireFlow(): TransformFlow {
    if (!flow) throw new Error('proj runtime is not initialised');
    return flow;
  }

  async function init(message: any) {
    const { dataDir, memfsPath } = message.node;
    dataVersion = await dataVersionOf(join(dataDir, 'proj.db'));

    const projModule = await createProjModule({
      moduleUrl: message.moduleUrl,
      // Emscripten resolves a bare "proj_wasm.wasm" against the process
      // working directory on Node, which is wherever the caller happened to
      // start. The module sits next to its own loader, so say so.
      wasmUrl: message.wasmUrl,
      memfsPath,
      nodeDataDir: dataDir,
    });

    flow = createTransformFlow({
      projModule,
      gridProvider: everythingPresent,
      // The flow consults the Manifest only to decide whether a missing grid
      // is worth fetching, and nothing here is ever missing.
      manifest: { version: dataVersion, grids: {}, projDb: { size: 0, sha256: '' } },
    });

    return { type: 'ready', manifest: { version: dataVersion }, dataVersion };
  }

  async function handle(message: any) {
    const reply = await route(message);
    return { ...reply, id: message.id };
  }

  async function route(message: any): Promise<any> {
    switch (message.type) {
      case 'init':
        return init(message);
      case 'transform': {
        const result = await requireFlow().transform({
          src: message.src,
          dst: message.dst,
          x: message.x,
          y: message.y,
          z: message.z,
          allowBallpark: message.allowBallpark === true,
        });
        return { type: 'result', x: result.x, y: result.y, z: result.z };
      }
      case 'transformMany': {
        const xyz = new Float64Array(message.xyz);
        await requireFlow().transformMany({
          src: message.src,
          dst: message.dst,
          xyz,
          allowBallpark: message.allowBallpark === true,
        });
        return { type: 'resultMany', xyz: xyz.buffer, transfer: [xyz.buffer] };
      }
      case 'describe': {
        const info = await requireFlow().describe({
          src: message.src,
          dst: message.dst,
          x: message.x,
          y: message.y,
          allowBallpark: message.allowBallpark !== false,
        });
        return { type: 'described', info };
      }
      case 'listCrs':
        return {
          type: 'crsList',
          crs: requireFlow().listCrs({
            lon: message.lon,
            lat: message.lat,
            kinds: message.kinds,
            authorities: message.authorities,
          }),
        };
      case 'preloadGrids':
        // Nothing to fetch: the directory is already complete.
        return { type: 'preloaded', fetched: 0 };
      default:
        throw new Error(`unknown message type: ${message.type}`);
    }
  }

  return {
    handle: async (message: any) => {
      try {
        return await handle(message);
      } catch (err) {
        return {
          type: 'error',
          id: message.id,
          error: err instanceof Error ? err.message : String(err),
          errorKind: (err as any)?.reason,
          missingGrids: (err as any)?.missingGrids,
        };
      }
    },
  };
}
