#!/usr/bin/env bash
set -euo pipefail

# Builds the PROJ submodule for the host and links the native test binary
# against the wrapper. Runs from inside or outside the Nix dev shell.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# cmake, sqlite3, zlib and libtiff come from the Nix dev shell, so re-enter it
# when the caller is outside. Entering it is keyed on IN_NIX_SHELL rather than
# on a missing cmake: a host cmake would otherwise build PROJ and link the tests
# with a different toolchain and different libtiff than the one this project
# pins. PW_NATIVE_NIX_REEXEC stops a second hop.
if [[ -z "${IN_NIX_SHELL:-}" && -z "${PW_NATIVE_NIX_REEXEC:-}" ]] &&
   command -v nix >/dev/null 2>&1; then
  export PW_NATIVE_NIX_REEXEC=1
  exec nix develop "${ROOT_DIR}" --command bash "${ROOT_DIR}/scripts/build-proj-native.sh" "$@"
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake not found. Install nix so this script can enter the dev shell,"
  echo "or run it from a shell that provides cmake and the PROJ dependencies."
  exit 1
fi

PROJ_DIR="${ROOT_DIR}/third_party/proj"
BUILD_DIR="${ROOT_DIR}/build/proj-native"
TEST_DIR="${ROOT_DIR}/tests/native"
TEST_BUILD_DIR="${ROOT_DIR}/build/native-tests"
TEST_BIN="${TEST_BUILD_DIR}/proj_wasm_tests"
WRAPPER_SRC="${ROOT_DIR}/src/proj_wasm.cpp"
DATA_DIR="${PROJ_TEST_DATA_DIR:-${ROOT_DIR}/third_party/sc-proj-data/proj}"

FORCE_REBUILD="${FORCE_REBUILD:-0}"

# The wrapper and the tests carry the sanitizers; PROJ itself is built without
# them. ASan's allocator interceptor is process-wide, so reads of memory that
# non-instrumented PROJ code freed are still reported from instrumented frames.
SAN_FLAGS="-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer"

for tool in pkg-config sqlite3; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "${tool} not found; it should come from the Nix dev shell (flake.nix)."
    exit 1
  fi
done

for package in sqlite3 zlib libtiff-4; do
  if ! pkg-config --exists "${package}"; then
    echo "${package} not found by pkg-config; it should come from flake.nix."
    exit 1
  fi
done

if [[ ! -f "${PROJ_DIR}/CMakeLists.txt" ]]; then
  echo "PROJ submodule not found at ${PROJ_DIR}."
  echo "Run:"
  echo "  git submodule update --init --recursive"
  exit 1
fi

if [[ "${FORCE_REBUILD}" == "1" ]]; then
  rm -rf "${BUILD_DIR}" "${TEST_BUILD_DIR}"
fi

mkdir -p "${BUILD_DIR}" "${TEST_BUILD_DIR}"

SQLITE_INC="$(pkg-config --variable=includedir sqlite3)"
SQLITE_LIBDIR="$(pkg-config --variable=libdir sqlite3)"
ZLIB_INC="$(pkg-config --variable=includedir zlib)"
ZLIB_LIBDIR="$(pkg-config --variable=libdir zlib)"
TIFF_INC="$(pkg-config --variable=includedir libtiff-4)"
TIFF_LIBDIR="$(pkg-config --variable=libdir libtiff-4)"

if [[ ! -f "${BUILD_DIR}/lib/libproj.a" ]]; then
  echo "Building PROJ for the host..."
  # Every grid in the data directory is a GeoTIFF, so TIFF support is not
  # optional for these tests.
  cmake -S "${PROJ_DIR}" -B "${BUILD_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="-g" \
    -DCMAKE_CXX_FLAGS="-g" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_APPS=OFF \
    -DENABLE_CURL=OFF \
    -DENABLE_TIFF=ON \
    -DEMBED_RESOURCE_FILES=OFF \
    -DEXE_SQLITE3="$(command -v sqlite3)" \
    -DSQLite3_INCLUDE_DIR="${SQLITE_INC}" \
    -DSQLite3_LIBRARY="${SQLITE_LIBDIR}/libsqlite3.so" \
    -DTIFF_INCLUDE_DIR="${TIFF_INC}" \
    -DTIFF_LIBRARY_RELEASE="${TIFF_LIBDIR}/libtiff.so" \
    -DZLIB_INCLUDE_DIR="${ZLIB_INC}" \
    -DZLIB_LIBRARY="${ZLIB_LIBDIR}/libz.so"
  cmake --build "${BUILD_DIR}" -j
fi

if [[ ! -f "${WRAPPER_SRC}" ]]; then
  echo "Wrapper source not found at ${WRAPPER_SRC}."
  exit 1
fi

if [[ ! -d "${DATA_DIR}" ]]; then
  echo "proj-data directory not found at ${DATA_DIR}."
  echo "Set PROJ_TEST_DATA_DIR to a directory holding proj.db and the grids."
  exit 1
fi

# The submodule headers must win over the dev shell's nixpkgs PROJ, which is on
# the implicit -isystem path and reports the same version string. -I is
# searched before -isystem, so the PROJ directories lead this list.
INCLUDES=(-I "${PROJ_DIR}/src" -I "${BUILD_DIR}/src" -I "${ROOT_DIR}/src" -I "${TEST_DIR}")

TEST_SOURCES=("${TEST_DIR}"/*.cpp)

echo "Building native tests..."
c++ -std=c++17 -O1 -g ${SAN_FLAGS} \
  -Wall -Wextra \
  "${INCLUDES[@]}" \
  -DPW_TEST_DATA_DIR="\"${DATA_DIR}\"" \
  -DPW_TEST_WORK_DIR="\"${TEST_BUILD_DIR}\"" \
  "${WRAPPER_SRC}" "${TEST_SOURCES[@]}" \
  "${BUILD_DIR}/lib/libproj.a" \
  -L"${TIFF_LIBDIR}" -ltiff \
  -L"${SQLITE_LIBDIR}" -lsqlite3 \
  -L"${ZLIB_LIBDIR}" -lz \
  -lpthread -ldl -lm \
  -o "${TEST_BIN}"

# Guards against picking up the dev shell's PROJ, which carries the same
# version string as the submodule and would make that mix-up invisible.
if ldd "${TEST_BIN}" | grep -q "libproj"; then
  echo "Test binary links a shared PROJ; it must link ${BUILD_DIR}/lib/libproj.a only."
  ldd "${TEST_BIN}" | grep "libproj"
  exit 1
fi

echo "Native test binary built at ${TEST_BIN}"
