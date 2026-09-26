/*
 * Manifest fixtures. The shape mirrors what the server actually serves
 * (`server/routes/proj-data.ts`: version, generatedAt, projDb, grids), and
 * hashes are derived from the fixture bytes so a manifest and its files are
 * never inconsistent by accident.
 */

import { createHash } from 'node:crypto';

interface ManifestEntry {
  size: number;
  sha256: string;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  projDb: ManifestEntry;
  grids: Record<string, ManifestEntry>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function entryFor(bytes: Uint8Array): ManifestEntry {
  return { size: bytes.length, sha256: sha256Hex(bytes) };
}

/** Deterministic filler bytes; `seed` makes two fixtures differ. */
export function fixtureBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed * 2654435761 + 1;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[i] = (state >>> 16) & 0xff;
  }
  return bytes;
}

export function makeManifest(
  version: string,
  projDbBytes: Uint8Array,
  grids: Record<string, Uint8Array> = {},
): Manifest {
  return {
    version,
    generatedAt: '2026-01-01T00:00:00.000Z',
    projDb: entryFor(projDbBytes),
    grids: Object.fromEntries(
      Object.entries(grids).map(([name, bytes]) => [name, entryFor(bytes)]),
    ),
  };
}
