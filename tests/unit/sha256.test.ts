/*
 * CT-DEDUP-HASH — the single sha256 implementation hashes incrementally.
 * Source: order.md Scope 2 ("Streaming the response straight to OPFS in the
 * worker, hashing as it goes") and Scope 9 ("`sha256Hex` is defined three
 * times").
 *
 * The reference is node:crypto, so a chunk-wise `crypto.subtle.digest`
 * (digesting each chunk separately) cannot pass.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createSha256 } from '../../src/worker/sha256.js';

import { fixtureBytes } from './support/manifest-factory';

function reference(chunks: Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

function hashChunks(chunks: Uint8Array[]): string {
  const hasher = createSha256();
  for (const chunk of chunks) hasher.update(chunk);
  return hasher.hex();
}

function split(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.subarray(offset));
  return chunks;
}

describe('createSha256', () => {
  it('matches node:crypto for empty input', () => {
    expect(hashChunks([])).toBe(reference([]));
  });

  it('matches node:crypto for a single short update', () => {
    const bytes = new TextEncoder().encode('proj-data');

    expect(hashChunks([bytes])).toBe(reference([bytes]));
  });

  it('matches node:crypto when chunks straddle the 64-byte block boundary', () => {
    const bytes = fixtureBytes(1, 200);
    const chunks = split(bytes, [1, 62, 1, 1, 63, 5]);

    expect(hashChunks(chunks)).toBe(reference([bytes]));
  });

  it('matches node:crypto at the padding boundary lengths', () => {
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120]) {
      const bytes = fixtureBytes(length, length);

      expect(hashChunks(split(bytes, [7]))).toBe(reference([bytes]));
    }
  });

  it('matches node:crypto for a multi-megabyte stream fed in chunks', () => {
    const bytes = fixtureBytes(9, 3 * 1024 * 1024 + 37);
    const chunks = split(bytes, Array.from({ length: 40 }, () => 65_536));

    expect(hashChunks(chunks)).toBe(reference([bytes]));
  });

  it('keeps two hashers independent', () => {
    const a = createSha256();
    const b = createSha256();
    const bytes = fixtureBytes(3, 128);

    a.update(bytes);

    expect(b.hex()).toBe(reference([]));
    expect(a.hex()).toBe(reference([bytes]));
  });
});
