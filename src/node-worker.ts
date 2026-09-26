/*
 * Worker-thread host for the Node session. It exists so a server's event loop
 * is not blocked while a batch of coordinates is transformed; the session
 * itself is environment-agnostic.
 */

import { parentPort } from 'node:worker_threads';

import { createNodeSession } from './worker/node-session.js';

const session = createNodeSession();

if (!parentPort) throw new Error('node-worker must run as a worker thread');
const port = parentPort;

port.on('message', async (message: unknown) => {
  const reply = await session.handle(message);
  const { transfer, ...body } = reply as { transfer?: Transferable[] };
  port.postMessage(body, (transfer as never) || []);
});
