import { describe, expect, it } from 'vitest';

describe('unit test runner', () => {
  it('runs a TypeScript test file and evaluates its assertion', () => {
    const parts: string[] = ['proj', 'wasm'];

    expect(parts.join('-')).toBe('proj-wasm');
  });
});
