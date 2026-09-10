/*
 * The one place that puts a file into the store.
 *
 * `FileSystemFileHandle.move()` is Chrome-only, so there is no rename to make
 * a write atomic. Instead the bytes go straight to the final name and a
 * `<name>.ok` sidecar is published only once they verify; a file without its
 * sidecar counts as absent and is overwritten. The stale sidecar therefore has
 * to disappear before the body is touched, or a half-written file would look
 * verified.
 */

import { DataVerificationError } from '../errors.js';
import { createSha256 } from './sha256.js';

/**
 * @param {{
 *   store: object,
 *   path: string,
 *   source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
 *   expected: {size: number, sha256: string} | null,
 *   onBytes?: (received: number) => void,
 * }} params
 *   `expected` is null for the Manifest itself, whose validation is that it
 *   parsed as JSON before this call.
 */
export async function writeVerifiedFile({ store, path, source, expected, onBytes }) {
  await store.remove(`${path}.ok`);

  const writable = await store.writeStream(path);
  const hash = createSha256();
  let received = 0;

  for await (const chunk of source) {
    if (chunk.length === 0) continue;
    hash.update(chunk);
    received += chunk.length;
    await writable.write(chunk);
    if (onBytes) onBytes(received);
  }
  await writable.close();

  if (expected) {
    if (received !== expected.size) {
      throw new DataVerificationError(
        `${path}: expected ${expected.size} bytes, received ${received}`,
      );
    }
    const digest = hash.hex();
    if (digest !== expected.sha256) {
      throw new DataVerificationError(`${path}: sha256 mismatch`);
    }
  }

  await store.publish(path);
}

/**
 * @param {Response} response
 * @returns {AsyncIterable<Uint8Array>}
 */
export async function* responseChunks(response) {
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}
