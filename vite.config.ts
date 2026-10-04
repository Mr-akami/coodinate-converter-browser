import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/*
 * Library build.
 *
 * Module structure is preserved rather than bundled, because the worker is
 * reached with `new URL('./proj-worker.js', import.meta.url)` and that only
 * resolves if the worker is still its own file next to its caller. Bundling
 * would inline it and break the reference at runtime, silently, only in a
 * built consumer.
 *
 * The Emscripten module is not built here. It is a generated artifact with its
 * own .wasm beside it, loaded with a dynamic import at runtime so the URL can
 * be overridden; Vite must leave that import alone.
 */
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist/lib',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/proj-runtime.ts'),
        node: resolve(import.meta.dirname, 'src/node.ts'),
        testing: resolve(import.meta.dirname, 'src/testing.ts'),
        embedded: resolve(import.meta.dirname, 'src/embedded.ts'),
        'proj-worker': resolve(import.meta.dirname, 'src/proj-worker.ts'),
        'node-worker': resolve(import.meta.dirname, 'src/node-worker.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^node:/],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
      },
    },
  },
});
