import { defineConfig } from 'vitest/config';

// The default glob would walk third_party/proj (the whole PROJ source tree)
// and build/, so collection is restricted to the unit-test directory.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
