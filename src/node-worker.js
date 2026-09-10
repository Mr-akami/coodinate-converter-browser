/*
 * Worker-thread host for the Node session. It exists so a server's event loop
 * is not blocked while a batch of coordinates is transformed; the session
 * itself is environment-agnostic.
 */

import { parentPort } from 'node:worker_threads';

import { createNodeSession } from './worker/node-session.js';

const session = createNodeSession();

parentPort.on('message', async (message) => {
  const reply = await session.handle(message);
  const { transfer, ...body } = reply;
  parentPort.postMessage(body, transfer || []);
});
