#!/usr/bin/env bash
# Native cs2cs performance benchmark
set -euo pipefail

PROJ_DATA="$PWD/third_party/sc-proj-data/proj"
export PROJ_DATA
ITERATIONS=1000

benchmark() {
  local label="$1" src="$2" dst="$3" x="$4" y="$5" z="${6:-0}"

  # Warm-up (1 call)
  echo "$y $x $z" | cs2cs "$src" "$dst" > /dev/null 2>&1

  # Measure
  local start end total_ms avg_ms ops_sec
  start=$(date +%s%N)
  for ((i=0; i<ITERATIONS; i++)); do
    echo "$y $x $z" | cs2cs "$src" "$dst" > /dev/null 2>&1
  done
  end=$(date +%s%N)

  total_ms=$(( (end - start) / 1000000 ))
  avg_ms=$(echo "scale=3; $total_ms / $ITERATIONS" | bc)
  ops_sec=$(echo "scale=1; 1000 / $avg_ms" | bc)

  echo "$label,$avg_ms,$ops_sec"
}

echo "label,avg_ms,ops_sec"
benchmark "Simple UTM"       EPSG:4326 EPSG:32654 139.77 35.68 0
benchmark "Web Mercator"     EPSG:4326 EPSG:3857  139.77 35.68 0
benchmark "Japan Plane IX"   EPSG:4326 EPSG:6677  139.77 35.68 0
benchmark "NAD27→NAD83(2011)" EPSG:4267 EPSG:6318 -74.0  40.7  0
benchmark "JGD2000→JGD2011"  EPSG:4612 EPSG:6668  139.77 35.68 0
benchmark "GSIGEO2011"       EPSG:6667 EPSG:6697  139.77 35.68 76
benchmark "EGM96"            EPSG:4979 EPSG:5773  139.77 35.68 80
benchmark "Identity"         EPSG:4326 EPSG:4326  139.77 35.68 0
