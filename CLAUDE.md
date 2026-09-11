# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`@mr-akami/proj-wasm-proj-data`: PROJ compiled to WebAssembly, for coordinate
transformation in the browser and on Node. It ships code, not data. The host
application serves `proj.db` and the grids as static files; there is no server
component in production.

Read `docs/refactor-plan.md` for the design and the reasoning behind it,
`CONTEXT.md` for the vocabulary, and `docs/adr/` for the three decisions that
are hard to reverse.

## Development

Requires Nix. `emcc` and `cmake` exist only inside the shell.

```bash
nix develop
git submodule update --init --recursive

./scripts/build-proj-wasm.sh      # wasm module; FORCE_REBUILD=1 for a clean one
npm run build:data                # Data Origin from third_party/sc-proj-data
npm run dev                       # dev server on :3000
```

A full rebuild takes several minutes and `-flto` uses a lot of memory at link
time; cap parallelism with `MAKEFLAGS=-j4 CMAKE_BUILD_PARALLEL_LEVEL=4` on a
machine under load. Run it in the background and poll rather than blocking.

## Tests

```bash
npm run test:native    # C++ wrapper, AddressSanitizer and UndefinedBehaviorSanitizer
npm run test:unit      # vitest, including the Node runtime
npm run test:browser    # end-to-end against tests/reference.csv
npm run typecheck
```

The native tests link the PROJ submodule directly and run in seconds, so they
are the right place to pin wrapper behaviour. The browser suite is slow and
needs a built wasm module and a built Data Origin.

## Architecture

**`src/proj_wasm.cpp`** wraps PROJ's C API in C++17 with RAII. It does not use
`osgeo::proj`, whose API and ABI PROJ does not guarantee. Operation selection
is delegated to `proj_create_crs_to_crs_from_pj`, the same entry point `cs2cs`
uses; hand-rolled selection disagreed with `cs2cs` in both directions on real
data, and the commit history explains each case.

**`src/proj-worker.ts`** is the only owner of OPFS, MEMFS and the PROJ context.
The main thread never holds grid bytes. **`src/worker/`** holds the pieces it
composes: installing a Data Version, providing grids, the transform flow.

**`src/proj-api.ts`** is the public surface, reached through
`src/proj-runtime.ts` in a browser and `src/node.ts` on Node. Both build on the
same worker protocol and the same transform flow.

**Grids are mounted, not loaded.** WORKERFS in the browser, NODEFS on Node.
Nothing copies a grid into wasm memory.

## Things that will bite you

**The PROJ pin is not free to move.** `third_party/proj` is pinned to the tag
that generated the `proj.db` in use. Upstream raised the database layout from 6
to 7 in April 2026 and every build after that refuses our layout-6 database;
moving to it took the end-to-end suite from 335 passes to 5.

**`transform` refuses by default.** A missing grid is an error, not a quietly
approximate answer. Tests that compare against `cs2cs` output must pass
`allowBallpark: true`, because `cs2cs` approximates.

**Reference values come from `cs2cs` built from the submodule.** The `cs2cs` on
`PATH` is a different version. `scripts/build-proj-native.sh` builds the right
one.

**`FORCE_REBUILD=1` matters after a flag change.** Without it the PROJ build
directory keeps its CMake cache and the new flags never reach PROJ.

## Key files

- `src/proj_wasm.cpp`, `src/proj_wasm.h` — the wasm module's C ABI
- `src/worker/transform-flow.ts` — grid fetching, strict checking, ordering
- `scripts/build-proj-wasm.sh` — wasm build
- `scripts/build-proj-native.sh` — host build for the native tests
- `scripts/build-data-dist.mjs` — generates a Data Origin
- `docs/refactor-plan.md` — design and rationale
- `docs/adr/` — static hosting, WORKERFS, refusing rather than approximating
