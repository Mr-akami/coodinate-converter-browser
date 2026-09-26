/*
 * CT-VER-SELECT — choosing which locally stored Data Version to start from.
 * Source: order.md Scope 3 (a Data Version becomes current only once its own
 * directory is complete) and Scope 4 ("start from the newest complete local
 * version"), plus the Verification item "vitest coverage for the
 * version-generation logic".
 *
 * A generation counts as complete only when both `manifest.json` and
 * `proj.db` carry their `.ok` sidecar; grids are fetched on demand and are
 * therefore not part of completeness.
 */

import { describe, expect, it } from 'vitest';

import { selectNewestCompleteVersion } from '../../src/worker/data-version.js';

interface Generation {
  version: string;
  manifestPublished: boolean;
  projDbPublished: boolean;
  installedAt: number;
}

function generation(overrides: Partial<Generation> & { version: string }): Generation {
  return {
    manifestPublished: true,
    projDbPublished: true,
    installedAt: 1,
    ...overrides,
  };
}

describe('selectNewestCompleteVersion', () => {
  it('returns null when nothing is stored locally', () => {
    expect(selectNewestCompleteVersion([])).toBeNull();
  });

  it('returns null when the only generation never finished installing', () => {
    const generations = [generation({ version: 'v1', projDbPublished: false })];

    expect(selectNewestCompleteVersion(generations)).toBeNull();
  });

  it('skips a generation whose manifest was never published', () => {
    const generations = [
      generation({ version: 'v1', installedAt: 10 }),
      generation({ version: 'v2', installedAt: 20, manifestPublished: false }),
    ];

    expect(selectNewestCompleteVersion(generations)).toBe('v1');
  });

  it('skips a generation whose proj.db was never published', () => {
    const generations = [
      generation({ version: 'v1', installedAt: 10 }),
      generation({ version: 'v2', installedAt: 20, projDbPublished: false }),
    ];

    expect(selectNewestCompleteVersion(generations)).toBe('v1');
  });

  it('picks the most recently installed complete generation', () => {
    const generations = [
      generation({ version: 'v1', installedAt: 10 }),
      generation({ version: 'v3', installedAt: 30 }),
      generation({ version: 'v2', installedAt: 20 }),
    ];

    expect(selectNewestCompleteVersion(generations)).toBe('v3');
  });

  it('breaks a tie on install time by the higher version identifier', () => {
    const generations = [
      generation({ version: 'a1', installedAt: 42 }),
      generation({ version: 'b2', installedAt: 42 }),
    ];

    expect(selectNewestCompleteVersion(generations)).toBe('b2');
    expect(selectNewestCompleteVersion([...generations].reverse())).toBe('b2');
  });
});
