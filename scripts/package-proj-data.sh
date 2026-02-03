#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJ_DATA_DIR="${PROJ_DATA_DIR:-${1:-}}"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/assets}"
OUT_NAME="${OUT_NAME:-proj-data.tar.gz}"

find_proj_data() {
  local candidates=()

  if [[ -n "${PROJ_DATA_DIR}" ]]; then
    candidates+=("${PROJ_DATA_DIR}")
  fi
  if [[ -n "${PROJ_LIB:-}" ]]; then
    candidates+=("${PROJ_LIB}")
  fi
  if [[ -n "${PROJ_DATA:-}" ]]; then
    candidates+=("${PROJ_DATA}")
  fi

  if command -v pkg-config >/dev/null 2>&1; then
    local datadir
    datadir="$(pkg-config --variable=datadir proj 2>/dev/null || true)"
    if [[ -n "${datadir}" ]]; then
      candidates+=("${datadir}/proj")
    fi
  fi

  if command -v nix >/dev/null 2>&1; then
    local proj_path
    proj_path="$(nix eval --raw nixpkgs#proj 2>/dev/null || true)"
    if [[ -n "${proj_path}" ]]; then
      candidates+=("${proj_path}/share/proj")
    fi
    local proj_data_path
    proj_data_path="$(nix eval --raw nixpkgs#proj-data 2>/dev/null || true)"
    if [[ -n "${proj_data_path}" ]]; then
      candidates+=("${proj_data_path}/share/proj")
    fi
  fi

  for dir in "${candidates[@]}"; do
    if [[ -f "${dir}/proj.db" ]]; then
      echo "${dir}"
      return 0
    fi
  done

  return 1
}

RESOLVED_DIR="$(find_proj_data || true)"

if [[ -z "${RESOLVED_DIR}" ]]; then
  echo "proj-data directory not found."
  echo "Set one of:"
  echo "  PROJ_DATA_DIR=/path/to/proj-data"
  echo "  PROJ_LIB=/path/to/share/proj"
  echo "Usage:"
  echo "  PROJ_DATA_DIR=/path/to/proj-data ./scripts/package-proj-data.sh"
  echo "  ./scripts/package-proj-data.sh /path/to/proj-data"
  exit 1
fi

if [[ ! -d "${RESOLVED_DIR}" ]]; then
  echo "Directory not found: ${RESOLVED_DIR}"
  exit 1
fi

if [[ ! -f "${RESOLVED_DIR}/proj.db" ]]; then
  echo "proj.db not found in ${RESOLVED_DIR}."
  echo "Make sure you point to the root of the proj-data directory."
  exit 1
fi

mkdir -p "${OUT_DIR}"
OUT_PATH="${OUT_DIR}/${OUT_NAME}"

tar -czf "${OUT_PATH}" -C "${RESOLVED_DIR}" .

echo "Created ${OUT_PATH}"
