# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based coordinate transformation using PROJ compiled to WebAssembly. proj-data stored in OPFS (Origin Private File System) for offline use after initial load. Chrome-targeted PoC.

## Dev Environment

Requires Nix:
```bash
nix develop          # enter dev shell (emscripten, cmake, ninja, nodejs, etc.)
```

PROJ is a git submodule:
```bash
git submodule update --init --recursive
```

## Build

```bash
# full build (sqlite3 + zlib + libtiff + PROJ + wasm bundle)
./scripts/build-proj-wasm.sh

# skip optional deps
WITH_TIFF=0 WITH_ZLIB=0 ./scripts/build-proj-wasm.sh

# force rebuild everything
FORCE_REBUILD=1 ./scripts/build-proj-wasm.sh
```

Output: `dist/proj_wasm.js` + `dist/proj_wasm.wasm` (ES6 module, MODULARIZE=1)

## Architecture

**Build chain:** Emscripten cross-compiles SQLite3, zlib, libtiff, then PROJ as static libs. `src/proj_wasm.c` wraps PROJ's C API into 4 exported functions, linked into final wasm bundle by `emcc`.

**WASM API** (`src/proj_wasm.c`):
- `proj_init(data_dir)` — init context, set search paths + DB
- `proj_transform(src, dst, x, y, z)` — coordinate transform between CRS IDs
- `proj_clear_cache()` — flush cached projection operation
- `proj_cleanup()` — destroy context

Caches last-used projection (src/dst pair) to avoid recreation on repeated transforms.

**Data flow (planned):** Download compressed proj-data → extract in Worker → store in OPFS → mount via Emscripten FS → PROJ reads `proj.db` + grid files

## Key Files

- `src/proj_wasm.c` — C wrapper exposing PROJ to JS
- `scripts/build-proj-wasm.sh` — full build orchestration (~240 lines)
- `agent.md` — project goals/architecture (Japanese)
- `docs/proj-wasm-build.md` — build details and API notes
- `third_party/proj/` — PROJ submodule
