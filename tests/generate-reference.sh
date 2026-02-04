#!/usr/bin/env bash
# Generate reference coordinate transformations using host cs2cs.
# Uses sc-proj-data so host and WASM use identical grids.
# Run inside nix develop.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$SCRIPT_DIR/reference.csv"

export PROJ_DATA="$ROOT_DIR/third_party/sc-proj-data/proj"

if ! command -v cs2cs &>/dev/null; then
  echo "cs2cs not found" >&2; exit 1
fi
echo "PROJ: $(cs2cs --version 2>&1)" >&2
echo "PROJ_DATA: $PROJ_DATA" >&2

# cs2cs uses EPSG axis order:
#   geographic input:  lat lon [h]
#   geographic output: lat lon [h]
#   projected output:  northing easting [h] (Japan Plane Rectangular)
#
# Our WASM API always uses lon,lat / easting,northing order.
# All cs2cs output is swapped (c2,c1) to match WASM convention.
# This works because:
#   - geographic: lat,lon → lon,lat
#   - Japan projected: northing,easting → easting,northing
#   - vertical/compound with geographic horiz: lat,lon,h → lon,lat,h

transform() {
  local label="$1" src="$2" dst="$3" lon="$4" lat="$5" z="${6:-0}"

  local result
  result=$(echo "$lat $lon $z" | cs2cs "$src" "$dst" -f "%.10f" 2>&1)

  if echo "$result" | grep -q "Error\|failed\|inf"; then
    echo "SKIP: $label ($src→$dst): $result" >&2
    return
  fi

  local c1 c2 c3
  read -r c1 c2 c3 <<< "$result"

  # Always swap c1,c2: works for geographic (lat,lon→lon,lat)
  # and Japan Plane Rectangular (northing,easting→easting,northing)
  echo "$label,$src,$dst,$lon,$lat,$z,$c2,$c1,$c3"
}

echo "label,src_crs,dst_crs,in_x,in_y,in_z,expected_x,expected_y,expected_z" > "$OUT"

###############################################################################
# 1. Plane Rectangular — boundary / edge / extreme
###############################################################################
# Zone origins:
#   I(6669):33N,129.5E  II(6670):33N,131E  III(6671):36N,132.167E
#   IV(6672):33N,133.5E V(6673):36N,134.333E VI(6674):36N,136E
#   VII(6675):36N,137.167E VIII(6676):36N,138.5E IX(6677):36N,139.833E
#   X(6678):40N,140.833E XI(6679):44N,140.25E XII(6680):44N,142.25E
#   XIII(6681):44N,144.25E XIV(6682):26N,142E XV(6683):26N,127.5E
#   XVI(6684):26N,124E XVII(6685):26N,131E XVIII(6686):20N,136E
#   XIX(6687):26N,154E

# --- Zone I (長崎) near origin + edge ---
transform "ZoneI origin"               EPSG:4326 EPSG:6669 129.5    33.0    0  >> "$OUT"
transform "ZoneI Nagasaki"             EPSG:4326 EPSG:6669 129.8733 32.7503 0  >> "$OUT"
transform "ZoneI far-east"             EPSG:4326 EPSG:6669 130.4    34.2    0  >> "$OUT"

# --- Zone II (福岡) ---
transform "ZoneII Fukuoka"             EPSG:4326 EPSG:6670 130.4017 33.5902 0  >> "$OUT"
transform "ZoneII origin"              EPSG:4326 EPSG:6670 131.0    33.0    0  >> "$OUT"

# --- Zone III (山口・島根) ---
transform "ZoneIII Yamaguchi"          EPSG:4326 EPSG:6671 131.4714 34.1861 0  >> "$OUT"

# --- Zone VI (大阪・京都) near origin + boundary ---
transform "ZoneVI origin"              EPSG:4326 EPSG:6674 136.0    36.0    0  >> "$OUT"
transform "ZoneVI Osaka"               EPSG:4326 EPSG:6674 135.5023 34.6937 0  >> "$OUT"
transform "ZoneVI far-west"            EPSG:4326 EPSG:6674 134.5    33.5    0  >> "$OUT"
transform "ZoneVI far-east"            EPSG:4326 EPSG:6674 137.0    37.0    0  >> "$OUT"

# --- Zone IX (東京) origin / boundary / edge ---
transform "ZoneIX origin"              EPSG:4326 EPSG:6677 139.8333 36.0    0  >> "$OUT"
transform "ZoneIX Tokyo"               EPSG:4326 EPSG:6677 139.7671 35.6812 0  >> "$OUT"
transform "ZoneIX north-edge"          EPSG:4326 EPSG:6677 139.8333 37.5    0  >> "$OUT"
transform "ZoneIX south-edge"          EPSG:4326 EPSG:6677 139.0    34.5    0  >> "$OUT"
transform "ZoneIX far-east"            EPSG:4326 EPSG:6677 141.0    36.0    0  >> "$OUT"
transform "ZoneIX far-west"            EPSG:4326 EPSG:6677 138.5    35.5    0  >> "$OUT"
# IX/X boundary: ~140.5E付近
transform "ZoneIX east-boundary"       EPSG:4326 EPSG:6677 140.5    36.5    0  >> "$OUT"

# --- Zone X (青森・秋田) boundary stress ---
transform "ZoneX Aomori"               EPSG:4326 EPSG:6678 140.7400 40.8244 0  >> "$OUT"
transform "ZoneX origin"               EPSG:4326 EPSG:6678 140.8333 40.0    0  >> "$OUT"
transform "ZoneX south-boundary"       EPSG:4326 EPSG:6678 140.5    38.0    0  >> "$OUT"

# --- Zone XI (小樽) ---
transform "ZoneXI Otaru"               EPSG:4326 EPSG:6679 140.9946 43.1907 0  >> "$OUT"

# --- Zone XII (札幌・旭川) ---
transform "ZoneXII Sapporo"            EPSG:4326 EPSG:6680 141.3469 43.0621 0  >> "$OUT"
transform "ZoneXII origin"             EPSG:4326 EPSG:6680 142.25   44.0    0  >> "$OUT"
transform "ZoneXII Wakkanai north"     EPSG:4326 EPSG:6680 141.6806 45.4153 0  >> "$OUT"

# --- Zone XIII (北見・択捉) far from central meridian ---
transform "ZoneXIII origin"            EPSG:4326 EPSG:6681 144.25   44.0    0  >> "$OUT"
transform "ZoneXIII Etorofu east"      EPSG:4326 EPSG:6681 148.8    45.5    0  >> "$OUT"
transform "ZoneXIII Nemuro"            EPSG:4326 EPSG:6681 145.5736 43.3302 0  >> "$OUT"

# --- Zone XIV (小笠原) ---
transform "ZoneXIV Chichijima"         EPSG:4326 EPSG:6682 142.1924 27.0908 0  >> "$OUT"
transform "ZoneXIV Hahajima"           EPSG:4326 EPSG:6682 142.1514 26.6568 0  >> "$OUT"

# --- Zone XV (沖縄本島) ---
transform "ZoneXV Naha"                EPSG:4326 EPSG:6683 127.6811 26.2124 0  >> "$OUT"
transform "ZoneXV origin"              EPSG:4326 EPSG:6683 127.5    26.0    0  >> "$OUT"

# --- Zone XVI (宮古・八重山) — 与那国 (日本最西端) ---
transform "ZoneXVI Yonaguni west"      EPSG:4326 EPSG:6684 122.9333 24.4667 0  >> "$OUT"
transform "ZoneXVI Ishigaki"           EPSG:4326 EPSG:6684 124.1556 24.3422 0  >> "$OUT"
transform "ZoneXVI origin"             EPSG:4326 EPSG:6684 124.0    26.0    0  >> "$OUT"

# --- Zone XVII (沖大東島) ---
transform "ZoneXVII Okidaitojima"      EPSG:4326 EPSG:6685 131.0    24.0    0  >> "$OUT"

# --- Zone XVIII (沖ノ鳥島 日本最南端) ---
transform "ZoneXVIII Okinotorishima"   EPSG:4326 EPSG:6686 136.0819 20.4222 0  >> "$OUT"
transform "ZoneXVIII origin"           EPSG:4326 EPSG:6686 136.0    20.0    0  >> "$OUT"

# --- Zone XIX (南鳥島 日本最東端) ---
transform "ZoneXIX Minamitorishima"    EPSG:4326 EPSG:6687 153.9811 24.2867 0  >> "$OUT"
transform "ZoneXIX origin"             EPSG:4326 EPSG:6687 154.0    26.0    0  >> "$OUT"

# --- "Wrong zone" stress: same point in correct vs adjacent zone ---
# Tokyo(139.77,35.68) is Zone IX. Put it in Zone VIII and VI to see large offsets.
transform "Tokyo in-ZoneVIII(wrong)"   EPSG:4326 EPSG:6676 139.7671 35.6812 0  >> "$OUT"
transform "Tokyo in-ZoneVI(wrong)"     EPSG:4326 EPSG:6674 139.7671 35.6812 0  >> "$OUT"

###############################################################################
# 2. Height variations (Z ≠ 0)
###############################################################################
transform "Tokyo Z=50m IX"             EPSG:4326 EPSG:6677 139.7671 35.6812  50   >> "$OUT"
transform "Fujisan Z=3776m VIII"       EPSG:4326 EPSG:6676 138.7274 35.3606  3776 >> "$OUT"
transform "Osaka Z=100m VI"            EPSG:4326 EPSG:6674 135.5023 34.6937  100  >> "$OUT"
transform "Sapporo Z=30m XII"          EPSG:4326 EPSG:6680 141.3469 43.0621  30   >> "$OUT"

# 3D geographic with height
transform "Tokyo 4979→6677 Z=50"       EPSG:4979 EPSG:6677 139.7671 35.6812  50   >> "$OUT"
transform "Tokyo 4979→6677 Z=3776"     EPSG:4979 EPSG:6677 139.7671 35.6812  3776 >> "$OUT"

###############################################################################
# 3. Datum transformations — expanded
###############################################################################
# --- Tokyo datum → JGD2011 (multiple points) ---
transform "Tokyo Tokyo→JGD2011"        EPSG:4301 EPSG:6668 139.7671 35.6812 0  >> "$OUT"
transform "Osaka Tokyo→JGD2011"        EPSG:4301 EPSG:6668 135.5023 34.6937 0  >> "$OUT"
transform "Sapporo Tokyo→JGD2011"      EPSG:4301 EPSG:6668 141.3469 43.0621 0  >> "$OUT"
transform "Fukuoka Tokyo→JGD2011"      EPSG:4301 EPSG:6668 130.4017 33.5902 0  >> "$OUT"
transform "Sendai Tokyo→JGD2011"       EPSG:4301 EPSG:6668 140.8719 38.2682 0  >> "$OUT"
transform "Naha Tokyo→JGD2011"         EPSG:4301 EPSG:6668 127.6811 26.2124 0  >> "$OUT"

# --- Tokyo datum → WGS84 ---
transform "Tokyo Tokyo→WGS84"         EPSG:4301 EPSG:4326 139.7671 35.6812 0  >> "$OUT"
transform "Osaka Tokyo→WGS84"         EPSG:4301 EPSG:4326 135.5023 34.6937 0  >> "$OUT"

# --- JGD2000 → JGD2011 ---
transform "Tokyo JGD2000→JGD2011"      EPSG:4612 EPSG:6668 139.7671 35.6812 0  >> "$OUT"
transform "Sendai JGD2000→JGD2011"     EPSG:4612 EPSG:6668 140.8719 38.2682 0  >> "$OUT"
transform "Osaka JGD2000→JGD2011"      EPSG:4612 EPSG:6668 135.5023 34.6937 0  >> "$OUT"
transform "Sapporo JGD2000→JGD2011"    EPSG:4612 EPSG:6668 141.3469 43.0621 0  >> "$OUT"
transform "Fukuoka JGD2000→JGD2011"    EPSG:4612 EPSG:6668 130.4017 33.5902 0  >> "$OUT"

# --- JGD2011 → WGS84 ---
transform "Tokyo JGD2011→WGS84"       EPSG:6668 EPSG:4326 139.7671 35.6812 0  >> "$OUT"
transform "Osaka JGD2011→WGS84"       EPSG:6668 EPSG:4326 135.5023 34.6937 0  >> "$OUT"

# --- WGS84 → JGD2000 ---
transform "Tokyo WGS84→JGD2000"       EPSG:4326 EPSG:4612 139.7671 35.6812 0  >> "$OUT"

###############################################################################
# 4. Geoid models
###############################################################################
# --- GSIGEO2011 (mainland only, various Z) ---
transform "Tokyo GSIGEO2011 Z=76"      EPSG:6667 EPSG:6697 139.7671 35.6812  76   >> "$OUT"
transform "Osaka GSIGEO2011 Z=50"      EPSG:6667 EPSG:6697 135.5023 34.6937  50   >> "$OUT"
transform "Sapporo GSIGEO2011 Z=42"    EPSG:6667 EPSG:6697 141.3469 43.0621  42   >> "$OUT"
transform "Fujisan GSIGEO2011 Z=3816"  EPSG:6667 EPSG:6697 138.7274 35.3606  3816 >> "$OUT"

# --- JPGEO2024 (nationwide) ---
transform "Tokyo JPGEO2024 Z=76"       EPSG:6667 EPSG:6695 139.7671 35.6812  76   >> "$OUT"
transform "Osaka JPGEO2024 Z=50"       EPSG:6667 EPSG:6695 135.5023 34.6937  50   >> "$OUT"
transform "Sapporo JPGEO2024 Z=42"     EPSG:6667 EPSG:6695 141.3469 43.0621  42   >> "$OUT"
transform "Naha JPGEO2024 Z=50"        EPSG:6667 EPSG:6695 127.6811 26.2124  50   >> "$OUT"
transform "Ishigaki JPGEO2024 Z=30"    EPSG:6667 EPSG:6695 124.1556 24.3422  30   >> "$OUT"

# --- WGS84 3D → JGD2024 vertical ---
transform "Tokyo WGS84→JGD2024 Z=76"  EPSG:4979 CZM:JGD2024 139.7671 35.6812 76  >> "$OUT"
transform "Osaka WGS84→JGD2024 Z=50"  EPSG:4979 CZM:JGD2024 135.5023 34.6937 50  >> "$OUT"
transform "Sapporo WGS84→JGD2024 Z=42" EPSG:4979 CZM:JGD2024 141.3469 43.0621 42 >> "$OUT"

###############################################################################
# 5. 3D CRS mixing (EPSG:4979 ↔ EPSG:4326)
###############################################################################
transform "Tokyo 4979→4326 Z=50"       EPSG:4979 EPSG:4326 139.7671 35.6812  50   >> "$OUT"
transform "Tokyo 4326→4979 Z=0"        EPSG:4326 EPSG:4979 139.7671 35.6812  0    >> "$OUT"
transform "Tokyo 6667→4979 Z=76"       EPSG:6667 EPSG:4979 139.7671 35.6812  76   >> "$OUT"
transform "Tokyo 6667→6668 Z=76"       EPSG:6667 EPSG:6668 139.7671 35.6812  76   >> "$OUT"

COUNT=$(tail -n +2 "$OUT" | wc -l)
echo "Generated $COUNT test cases → $OUT" >&2
