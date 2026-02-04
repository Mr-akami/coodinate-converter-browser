#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ_DIR="${ROOT_DIR}/third_party/proj"
BUILD_DIR="${ROOT_DIR}/build/proj-wasm"
DIST_DIR="${ROOT_DIR}/dist"
WRAPPER_SRC="${ROOT_DIR}/src/proj_wasm.c"
DEPS_DIR="${ROOT_DIR}/build/wasm-deps"
DEPS_SRC_DIR="${DEPS_DIR}/src"
DEPS_INSTALL_DIR="${DEPS_DIR}/install"

WITH_TIFF="${WITH_TIFF:-1}"
WITH_ZLIB="${WITH_ZLIB:-1}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"

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

EXE_SQLITE3="$(command -v sqlite3 || true)"
if [[ -z "${EXE_SQLITE3}" ]]; then
  echo "sqlite3 binary not found. Install sqlite3 and retry."
  exit 1
fi

mkdir -p "${BUILD_DIR}"
mkdir -p "${DIST_DIR}"
mkdir -p "${DEPS_SRC_DIR}"
mkdir -p "${DEPS_INSTALL_DIR}/lib"
mkdir -p "${DEPS_INSTALL_DIR}/include"

SQLITE_VERSION="${SQLITE_VERSION:-3440200}"
SQLITE_AMALGAMATION_DIR="${DEPS_SRC_DIR}/sqlite3_amalgamation"
SQLITE_ZIP="sqlite-amalgamation-${SQLITE_VERSION}.zip"
SQLITE_LIB="${DEPS_INSTALL_DIR}/lib/libsqlite3.a"
SQLITE_INC="${DEPS_INSTALL_DIR}/include/sqlite3.h"

if [[ "${FORCE_REBUILD}" == "1" ]]; then
  rm -f "${SQLITE_LIB}" "${SQLITE_INC}"
fi

if [[ ! -f "${SQLITE_LIB}" || ! -f "${SQLITE_INC}" ]]; then
  echo "Building SQLite3 (amalgamation)..."
  mkdir -p "${SQLITE_AMALGAMATION_DIR}"
  pushd "${SQLITE_AMALGAMATION_DIR}" >/dev/null
  if [[ ! -f "${SQLITE_ZIP}" ]]; then
    curl -L -o "${SQLITE_ZIP}" "https://sqlite.org/2023/${SQLITE_ZIP}"
  fi
  unzip -qo "${SQLITE_ZIP}"
  mv "sqlite-amalgamation-${SQLITE_VERSION}"/* .
  rmdir "sqlite-amalgamation-${SQLITE_VERSION}"

  emcc sqlite3.c \
    -c \
    -O3 \
    -DSQLITE_THREADSAFE=1 \
    -o sqlite3.o
  emar rcs "${SQLITE_LIB}" sqlite3.o
  cp sqlite3.h "${SQLITE_INC}"
  popd >/dev/null
fi

ZLIB_LIB="${DEPS_INSTALL_DIR}/lib/libz.a"
ZLIB_INC="${DEPS_INSTALL_DIR}/include/zlib.h"
if [[ "${WITH_ZLIB}" == "1" ]]; then
  if [[ "${FORCE_REBUILD}" == "1" ]]; then
    rm -f "${ZLIB_LIB}" "${ZLIB_INC}"
  fi
  if [[ ! -f "${ZLIB_LIB}" || ! -f "${ZLIB_INC}" ]]; then
    echo "Building zlib..."
    ZLIB_DIR="${DEPS_SRC_DIR}/zlib-1.3.1"
    mkdir -p "${DEPS_SRC_DIR}"
    pushd "${DEPS_SRC_DIR}" >/dev/null
    if [[ ! -f "v1.3.1.zip" ]]; then
      curl -L -o "v1.3.1.zip" "https://github.com/madler/zlib/archive/refs/tags/v1.3.1.zip"
    fi
    unzip -qo v1.3.1.zip
    popd >/dev/null

    pushd "${ZLIB_DIR}" >/dev/null
    rm -rf build_wasm
    mkdir -p build_wasm

    # Avoid SHARED target name collision on emscripten/ninja
    sed -i '/add_library(zlib SHARED/d' CMakeLists.txt
    sed -i '/target_include_directories(zlib /d' CMakeLists.txt
    sed -i '/set_target_properties(zlib /d' CMakeLists.txt
    sed -i 's/install(TARGETS zlib zlibstatic/install(TARGETS zlibstatic/g' CMakeLists.txt

    emcmake cmake -S . -B build_wasm \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="${DEPS_INSTALL_DIR}" \
      -DBUILD_SHARED_LIBS=OFF \
      -DZLIB_BUILD_EXAMPLES=OFF
    cmake --build build_wasm -j
    cmake --install build_wasm

    if [[ -f "${DEPS_INSTALL_DIR}/lib/libzlibstatic.a" ]]; then
      cp "${DEPS_INSTALL_DIR}/lib/libzlibstatic.a" "${ZLIB_LIB}"
    fi
    popd >/dev/null
  fi
fi

TIFF_LIB="${DEPS_INSTALL_DIR}/lib/libtiff.a"
TIFF_INC="${DEPS_INSTALL_DIR}/include/tiff.h"
if [[ "${WITH_TIFF}" == "1" ]]; then
  if [[ "${WITH_ZLIB}" != "1" ]]; then
    echo "WITH_TIFF=1 requires WITH_ZLIB=1."
    exit 1
  fi
  if [[ "${FORCE_REBUILD}" == "1" ]]; then
    rm -f "${TIFF_LIB}" "${TIFF_INC}"
  fi
  if [[ ! -f "${TIFF_LIB}" || ! -f "${TIFF_INC}" ]]; then
    echo "Building libtiff..."
    TIFF_VERSION="4.7.0"
    TIFF_DIR="${DEPS_SRC_DIR}/tiff-${TIFF_VERSION}"
    pushd "${DEPS_SRC_DIR}" >/dev/null
    if [[ ! -f "tiff-${TIFF_VERSION}.tar.gz" ]]; then
      curl -L -o "tiff-${TIFF_VERSION}.tar.gz" "https://download.osgeo.org/libtiff/tiff-${TIFF_VERSION}.tar.gz"
    fi
    tar -xzf "tiff-${TIFF_VERSION}.tar.gz"
    popd >/dev/null

    pushd "${TIFF_DIR}" >/dev/null
    rm -rf build_wasm
    mkdir -p build_wasm
    emcmake cmake -S . -B build_wasm \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="${DEPS_INSTALL_DIR}" \
      -DBUILD_SHARED_LIBS=OFF \
      -Dtiff-tools=OFF \
      -Dtiff-tests=OFF \
      -Dtiff-contrib=OFF \
      -Dtiff-docs=OFF \
      -Djpeg=OFF \
      -Dzlib=ON \
      -Dlzma=OFF \
      -Dzstd=OFF \
      -Dwebp=OFF \
      -Djbig=OFF \
      -DCMAKE_PREFIX_PATH="${DEPS_INSTALL_DIR}"
    cmake --build build_wasm -j
    cmake --install build_wasm
    popd >/dev/null
  fi
fi

PROJ_CMAKE_ARGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DBUILD_TESTING=OFF
  -DBUILD_APPS=OFF
  -DENABLE_CURL=OFF
  -DENABLE_TIFF=$( [[ "${WITH_TIFF}" == "1" ]] && echo ON || echo OFF )
  -DEXE_SQLITE3="${EXE_SQLITE3}"
  -DSQLite3_INCLUDE_DIR="${DEPS_INSTALL_DIR}/include"
  -DSQLite3_LIBRARY="${SQLITE_LIB}"
)

if [[ "${WITH_TIFF}" == "1" ]]; then
  PROJ_CMAKE_ARGS+=(
    -DTIFF_INCLUDE_DIR="${DEPS_INSTALL_DIR}/include"
    -DTIFF_LIBRARY_RELEASE="${TIFF_LIB}"
    -DZLIB_INCLUDE_DIR="${DEPS_INSTALL_DIR}/include"
    -DZLIB_LIBRARY="${ZLIB_LIB}"
  )
fi

emcmake cmake -S "${PROJ_DIR}" -B "${BUILD_DIR}" "${PROJ_CMAKE_ARGS[@]}"

cmake --build "${BUILD_DIR}" -j

if [[ ! -f "${WRAPPER_SRC}" ]]; then
  echo "Wrapper not found at ${WRAPPER_SRC}."
  echo "Library build is complete. Add wrapper and re-run to produce Wasm bundle."
  exit 0
fi

FINAL_LIBS=("${BUILD_DIR}/lib/libproj.a" "${SQLITE_LIB}")
if [[ "${WITH_TIFF}" == "1" ]]; then
  FINAL_LIBS+=("${TIFF_LIB}" "${ZLIB_LIB}")
fi

emcc "${WRAPPER_SRC}" "${FINAL_LIBS[@]}" \
  -O3 \
  -I "${BUILD_DIR}/src" \
  -I "${PROJ_DIR}/src" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker \
  -sASYNCIFY=1 \
  -sFILESYSTEM=1 \
  -sFORCE_FILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS='["_pw_init","_pw_transform","_pw_clear_cache","_pw_cleanup","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS","HEAPF64","WORKERFS"]' \
  -lworkerfs.js \
  -o "${DIST_DIR}/proj_wasm.js"

echo "Wasm bundle created at ${DIST_DIR}/proj_wasm.js"
