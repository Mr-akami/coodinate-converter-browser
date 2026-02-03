#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ_DIR="${ROOT_DIR}/third_party/proj"
BUILD_DIR="${ROOT_DIR}/build/proj-wasm"
DIST_DIR="${ROOT_DIR}/dist"
WRAPPER_SRC="${ROOT_DIR}/src/proj_wasm.c"

if [[ ! -d "${PROJ_DIR}" ]]; then
  echo "PROJ submodule not found at ${PROJ_DIR}."
  echo "Run:"
  echo "  git submodule update --init --recursive"
  exit 1
fi

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake not found. Please activate emsdk first."
  exit 1
fi

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not found. Please activate emsdk first."
  exit 1
fi

mkdir -p "${BUILD_DIR}"
mkdir -p "${DIST_DIR}"

emcmake cmake -S "${PROJ_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTING=OFF

cmake --build "${BUILD_DIR}" -j

if [[ ! -f "${WRAPPER_SRC}" ]]; then
  echo "Wrapper not found at ${WRAPPER_SRC}."
  echo "Library build is complete. Add wrapper and re-run to produce Wasm bundle."
  exit 0
fi

emcc "${WRAPPER_SRC}" "${BUILD_DIR}/src/libproj.a" \
  -O3 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker \
  -sWASMFS=1 \
  -sFILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_proj_init,_proj_transform,_proj_clear_cache,_proj_cleanup \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS \
  -o "${DIST_DIR}/proj_wasm.js"

echo "Wasm bundle created at ${DIST_DIR}/proj_wasm.js"
