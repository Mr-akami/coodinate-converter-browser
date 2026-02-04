#!/usr/bin/env bash
# Generate reference coordinate transformations using host cs2cs.
# Uses sc-proj-data so host and WASM use identical grids.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$SCRIPT_DIR/reference.csv"

export PROJ_DATA="$ROOT_DIR/third_party/sc-proj-data/proj"

if ! command -v cs2cs &>/dev/null; then echo "cs2cs not found" >&2; exit 1; fi
echo "PROJ: $(cs2cs --version 2>&1)" >&2
echo "PROJ_DATA: $PROJ_DATA" >&2

# Detect if cs2cs output axis 1 is northing/latitude (needs swap to x=lon/easting, y=lat/northing)
# by checking projinfo WKT for the first AXIS direction.
# Returns 0 (true=needs swap) if first axis is north or lat.
needs_swap() {
  local crs="$1"
  local first_axis
  first_axis=$(projinfo "$crs" 2>&1 | grep -oP 'AXIS\[.*?,(north|south|east|west|up)' | head -1 | grep -oP '(north|south|east|west|up)$')
  case "$first_axis" in
    north|south) return 0 ;;  # lat/northing first → swap
    *) return 1 ;;            # easting/east first or vertical → no swap
  esac
}

transform() {
  local label="$1" src="$2" dst="$3" lon="$4" lat="$5" z="${6:-0}"

  # cs2cs input: use source CRS EPSG axis order
  local in1 in2
  if needs_swap "$src"; then
    in1="$lat"; in2="$lon"  # lat,lon for geographic
  else
    in1="$lon"; in2="$lat"  # easting,northing for projected
  fi

  local result
  result=$(echo "$in1 $in2 $z" | cs2cs "$src" "$dst" -f "%.10f" 2>&1)

  if echo "$result" | grep -qi "Error\|failed\|inf\|cannot"; then
    echo "SKIP: $label ($src→$dst): $result" >&2
    return
  fi

  local c1 c2 c3
  read -r c1 c2 c3 <<< "$result"

  # Output: convert from EPSG axis order to (x=lon/easting, y=lat/northing)
  local out_x out_y
  if needs_swap "$dst"; then
    out_x="$c2"; out_y="$c1"  # swap lat,lon → lon,lat / N,E → E,N
  else
    out_x="$c1"; out_y="$c2"  # already easting,northing
  fi

  echo "$label,$src,$dst,$lon,$lat,$z,$out_x,$out_y,$c3"
}

echo "label,src_crs,dst_crs,in_x,in_y,in_z,expected_x,expected_y,expected_z" > "$OUT"

###############################################################################
# JAPAN — Plane Rectangular boundary / edge / extreme
###############################################################################
# Zone I (長崎) 33N,129.5E
transform "JP:ZoneI origin"              EPSG:4326 EPSG:6669 129.5    33.0    0  >> "$OUT"
transform "JP:ZoneI Nagasaki"            EPSG:4326 EPSG:6669 129.8733 32.7503 0  >> "$OUT"
transform "JP:ZoneI far-east"            EPSG:4326 EPSG:6669 130.4    34.2    0  >> "$OUT"

# Zone II (福岡) 33N,131E
transform "JP:ZoneII Fukuoka"            EPSG:4326 EPSG:6670 130.4017 33.5902 0  >> "$OUT"
transform "JP:ZoneII origin"             EPSG:4326 EPSG:6670 131.0    33.0    0  >> "$OUT"

# Zone III (山口) 36N,132.167E
transform "JP:ZoneIII Yamaguchi"         EPSG:4326 EPSG:6671 131.4714 34.1861 0  >> "$OUT"

# Zone VI (大阪) 36N,136E — boundary stress
transform "JP:ZoneVI origin"             EPSG:4326 EPSG:6674 136.0    36.0    0  >> "$OUT"
transform "JP:ZoneVI Osaka"              EPSG:4326 EPSG:6674 135.5023 34.6937 0  >> "$OUT"
transform "JP:ZoneVI far-west"           EPSG:4326 EPSG:6674 134.5    33.5    0  >> "$OUT"
transform "JP:ZoneVI far-east"           EPSG:4326 EPSG:6674 137.0    37.0    0  >> "$OUT"

# Zone IX (東京) 36N,139.833E — origin / boundary / edge
transform "JP:ZoneIX origin"             EPSG:4326 EPSG:6677 139.8333 36.0    0  >> "$OUT"
transform "JP:ZoneIX Tokyo"              EPSG:4326 EPSG:6677 139.7671 35.6812 0  >> "$OUT"
transform "JP:ZoneIX north-edge"         EPSG:4326 EPSG:6677 139.8333 37.5    0  >> "$OUT"
transform "JP:ZoneIX south-edge"         EPSG:4326 EPSG:6677 139.0    34.5    0  >> "$OUT"
transform "JP:ZoneIX far-east"           EPSG:4326 EPSG:6677 141.0    36.0    0  >> "$OUT"
transform "JP:ZoneIX far-west"           EPSG:4326 EPSG:6677 138.5    35.5    0  >> "$OUT"
transform "JP:ZoneIX east-boundary"      EPSG:4326 EPSG:6677 140.5    36.5    0  >> "$OUT"

# Zone X (青森) 40N,140.833E
transform "JP:ZoneX Aomori"              EPSG:4326 EPSG:6678 140.7400 40.8244 0  >> "$OUT"
transform "JP:ZoneX origin"              EPSG:4326 EPSG:6678 140.8333 40.0    0  >> "$OUT"
transform "JP:ZoneX south-boundary"      EPSG:4326 EPSG:6678 140.5    38.0    0  >> "$OUT"

# Zone XI (小樽) 44N,140.25E
transform "JP:ZoneXI Otaru"              EPSG:4326 EPSG:6679 140.9946 43.1907 0  >> "$OUT"

# Zone XII (札幌) 44N,142.25E
transform "JP:ZoneXII Sapporo"           EPSG:4326 EPSG:6680 141.3469 43.0621 0  >> "$OUT"
transform "JP:ZoneXII origin"            EPSG:4326 EPSG:6680 142.25   44.0    0  >> "$OUT"
transform "JP:ZoneXII Wakkanai"          EPSG:4326 EPSG:6680 141.6806 45.4153 0  >> "$OUT"

# Zone XIII (北見・択捉) 44N,144.25E — far from central meridian
transform "JP:ZoneXIII origin"           EPSG:4326 EPSG:6681 144.25   44.0    0  >> "$OUT"
transform "JP:ZoneXIII Etorofu"          EPSG:4326 EPSG:6681 148.8    45.5    0  >> "$OUT"
transform "JP:ZoneXIII Nemuro"           EPSG:4326 EPSG:6681 145.5736 43.3302 0  >> "$OUT"

# Zone XIV (小笠原) 26N,142E
transform "JP:ZoneXIV Chichijima"        EPSG:4326 EPSG:6682 142.1924 27.0908 0  >> "$OUT"

# Zone XV (沖縄本島) 26N,127.5E
transform "JP:ZoneXV Naha"               EPSG:4326 EPSG:6683 127.6811 26.2124 0  >> "$OUT"
transform "JP:ZoneXV origin"             EPSG:4326 EPSG:6683 127.5    26.0    0  >> "$OUT"

# Zone XVI (宮古・八重山) 26N,124E — 与那国(最西端)
transform "JP:ZoneXVI Yonaguni"          EPSG:4326 EPSG:6684 122.9333 24.4667 0  >> "$OUT"
transform "JP:ZoneXVI Ishigaki"          EPSG:4326 EPSG:6684 124.1556 24.3422 0  >> "$OUT"

# Zone XVIII (沖ノ鳥島 最南端) 20N,136E
transform "JP:ZoneXVIII Okinotorishima"  EPSG:4326 EPSG:6686 136.0819 20.4222 0  >> "$OUT"

# Zone XIX (南鳥島 最東端) 26N,154E
transform "JP:ZoneXIX Minamitorishima"   EPSG:4326 EPSG:6687 153.9811 24.2867 0  >> "$OUT"

# Wrong zone stress
transform "JP:Tokyo-in-ZoneVIII(wrong)"  EPSG:4326 EPSG:6676 139.7671 35.6812 0  >> "$OUT"

# Height variations
transform "JP:Tokyo Z=50 IX"             EPSG:4326 EPSG:6677 139.7671 35.6812  50   >> "$OUT"
transform "JP:Fujisan Z=3776 VIII"       EPSG:4326 EPSG:6676 138.7274 35.3606  3776 >> "$OUT"
transform "JP:Tokyo 4979→6677 Z=50"      EPSG:4979 EPSG:6677 139.7671 35.6812  50   >> "$OUT"

# Datum transforms
transform "JP:Tokyo Datum→JGD2011"       EPSG:4301 EPSG:6668 139.7671 35.6812 0  >> "$OUT"
transform "JP:Osaka Datum→JGD2011"       EPSG:4301 EPSG:6668 135.5023 34.6937 0  >> "$OUT"
transform "JP:Sapporo Datum→JGD2011"     EPSG:4301 EPSG:6668 141.3469 43.0621 0  >> "$OUT"
transform "JP:Naha Datum→JGD2011"        EPSG:4301 EPSG:6668 127.6811 26.2124 0  >> "$OUT"
transform "JP:Tokyo Datum→WGS84"         EPSG:4301 EPSG:4326 139.7671 35.6812 0  >> "$OUT"

transform "JP:Tokyo JGD2000→JGD2011"     EPSG:4612 EPSG:6668 139.7671 35.6812 0  >> "$OUT"
transform "JP:Sendai JGD2000→JGD2011"    EPSG:4612 EPSG:6668 140.8719 38.2682 0  >> "$OUT"
transform "JP:Osaka JGD2000→JGD2011"     EPSG:4612 EPSG:6668 135.5023 34.6937 0  >> "$OUT"
transform "JP:JGD2011→WGS84"             EPSG:6668 EPSG:4326 139.7671 35.6812 0  >> "$OUT"

# Geoid
transform "JP:GSIGEO2011 Tokyo Z=76"     EPSG:6667 EPSG:6697 139.7671 35.6812  76   >> "$OUT"
transform "JP:GSIGEO2011 Osaka Z=50"     EPSG:6667 EPSG:6697 135.5023 34.6937  50   >> "$OUT"
transform "JP:GSIGEO2011 Fujisan Z=3816" EPSG:6667 EPSG:6697 138.7274 35.3606  3816 >> "$OUT"
transform "JP:JPGEO2024 Tokyo Z=76"      EPSG:6667 EPSG:6695 139.7671 35.6812  76   >> "$OUT"
transform "JP:JPGEO2024 Naha Z=50"       EPSG:6667 EPSG:6695 127.6811 26.2124  50   >> "$OUT"
transform "JP:WGS84→JGD2024 Tokyo"       EPSG:4979 CZM:JGD2024 139.7671 35.6812 76  >> "$OUT"
transform "JP:WGS84→JGD2024 Osaka"       EPSG:4979 CZM:JGD2024 135.5023 34.6937 50  >> "$OUT"

# 3D mixing
transform "JP:4979→4326 Z=50"            EPSG:4979 EPSG:4326 139.7671 35.6812  50   >> "$OUT"
transform "JP:6667→6668 Z=76"            EPSG:6667 EPSG:6668 139.7671 35.6812  76   >> "$OUT"

###############################################################################
# NORTH AMERICA — NAD27/83 multi-step, State Plane, UTM
###############################################################################
# NAD27→NAD83(2011) via NADCON+NADCON5 chain (4+ steps)
transform "US:NYC NAD27→NAD83(2011)"     EPSG:4267 EPSG:6318 -74.0060 40.7128 0  >> "$OUT"
transform "US:LA NAD27→NAD83(2011)"      EPSG:4267 EPSG:6318 -118.2437 33.9425 0  >> "$OUT"
transform "US:Chicago NAD27→NAD83(2011)" EPSG:4267 EPSG:6318 -87.6298 41.8781 0  >> "$OUT"

# NAD83→NAD83(2011) via HARN+FBN+NADCON5 chain
transform "US:NYC NAD83→NAD83(2011)"     EPSG:4269 EPSG:6318 -74.0060 40.7128 0  >> "$OUT"
transform "US:SF NAD83→NAD83(2011)"      EPSG:4269 EPSG:6318 -122.4194 37.7749 0 >> "$OUT"

# State Plane (feet! EPSG:2260=easting-first, US survey foot)
transform "US:NYC NAD83→StatePlane"      EPSG:4269 EPSG:2260 -74.0060 40.7128 0  >> "$OUT"

# NAD83(2011) → UTM
transform "US:NYC NAD83(2011)→UTM18N"    EPSG:6318 EPSG:6347 -74.0060 40.7128 0  >> "$OUT"
transform "US:SF NAD83(2011)→UTM10N"     EPSG:6318 EPSG:6345 -122.4194 37.7749 0 >> "$OUT"

# NAD27→State Plane (multi-step: datum shift + projection)
transform "US:NYC NAD27→SP-NY-East"      EPSG:4267 EPSG:2260 -74.0060 40.7128 0  >> "$OUT"

# WGS84→UTM (simple)
transform "US:NYC WGS84→UTM18N"          EPSG:4326 EPSG:32618 -74.0060 40.7128 0 >> "$OUT"
transform "US:SF WGS84→UTM10N"           EPSG:4326 EPSG:32610 -122.4194 37.7749 0 >> "$OUT"
transform "US:Honolulu WGS84→UTM4N"      EPSG:4326 EPSG:32604 -157.8583 21.3069 0 >> "$OUT"

# Alaska (NADCON5)
transform "US:Anchorage NAD27→NAD83"     EPSG:4267 EPSG:4269 -149.9003 61.2181 0 >> "$OUT"

# Canada NAD27→NAD83(CSRS)
transform "CA:Toronto NAD27→NAD83CSRS"   EPSG:4267 EPSG:4617 -79.3832 43.6532  0 >> "$OUT"
transform "CA:Vancouver NAD27→NAD83CSRS" EPSG:4267 EPSG:4617 -123.1216 49.2827 0 >> "$OUT"

# WGS84 3D → EGM96 (global geoid model)
transform "US:NYC WGS84→EGM96"           EPSG:4979 EPSG:5773 -74.0060 40.7128  30 >> "$OUT"

###############################################################################
# EUROPE — multi-step datum transforms with grids
###############################################################################
# Belgium: BD72→ETRS89 (grid: bd72lb72_etrs89lb08.tif)
transform "BE:Brussels BD72→ETRS89"      EPSG:4313 EPSG:4258 4.3517   50.8503 0  >> "$OUT"
transform "BE:Antwerp BD72→ETRS89"       EPSG:4313 EPSG:4258 4.4025   51.2194 0  >> "$OUT"
# Belgian Lambert 72 (projected) → Lambert 2008 (multi-step: deproject+grid+reproject)
transform "BE:Brussels BL72→BL2008"      EPSG:31370 EPSG:3812 150327  170563  0  >> "$OUT"
transform "BE:Antwerp BL72→BL2008"       EPSG:31370 EPSG:3812 153093  211536  0  >> "$OUT"

# UK: OSGB36→ETRS89 (OSTN15 grid)
transform "UK:London OSGB36→ETRS89"      EPSG:4277 EPSG:4258 -0.1278  51.5074 0  >> "$OUT"
transform "UK:Edinburgh OSGB36→ETRS89"   EPSG:4277 EPSG:4258 -3.1883  55.9533 0  >> "$OUT"
# British National Grid (projected) → WGS84
transform "UK:London BNG→WGS84"          EPSG:27700 EPSG:4326 530000  180000  0  >> "$OUT"
transform "UK:Edinburgh BNG→WGS84"       EPSG:27700 EPSG:4326 325000  674000  0  >> "$OUT"

# France: NTF→RGF93 (ntf_r93 grid)
transform "FR:Paris NTF→RGF93"           EPSG:4275 EPSG:4171 2.3522   48.8566 0  >> "$OUT"
transform "FR:Lyon NTF→RGF93"            EPSG:4275 EPSG:4171 4.8357   45.7640 0  >> "$OUT"
# Lambert 93 (French national projected)
transform "FR:Paris WGS84→Lambert93"     EPSG:4326 EPSG:2154 2.3522   48.8566 0  >> "$OUT"

# Germany: DHDN→ETRS89 (BETA2007 grid)
transform "DE:Berlin DHDN→ETRS89"        EPSG:4314 EPSG:4258 13.4050  52.5200 0  >> "$OUT"
transform "DE:Munich DHDN→ETRS89"        EPSG:4314 EPSG:4258 11.5820  48.1351 0  >> "$OUT"
# Gauss-Kruger zone 4 → UTM32
transform "DE:Berlin GK4→UTM32"          EPSG:31468 EPSG:25832 4587442 5822377 0 >> "$OUT"

# Switzerland: CH1903+→ETRS89 (CHENyx06 grid)
transform "CH:Bern CH1903+→ETRS89"       EPSG:4150 EPSG:4258 7.4474   46.9481 0  >> "$OUT"
transform "CH:Zurich CH1903+→ETRS89"     EPSG:4150 EPSG:4258 8.5417   47.3769 0  >> "$OUT"
# Swiss LV95 (projected)
transform "CH:Bern WGS84→LV95"           EPSG:4326 EPSG:2056 7.4474   46.9481 0  >> "$OUT"

# Netherlands: RD→ETRS89
transform "NL:Amsterdam RD→ETRS89"       EPSG:4289 EPSG:4258 4.9041   52.3676 0  >> "$OUT"
# RD New (projected) → WGS84
transform "NL:Amsterdam RDNew→WGS84"     EPSG:28992 EPSG:4326 121000  487000  0  >> "$OUT"

# Austria: MGI→ETRS89 (AT_GIS_GRID)
transform "AT:Vienna MGI→ETRS89"         EPSG:4312 EPSG:4258 16.3738  48.2082 0  >> "$OUT"

# Norway: NGO1948→ETRS89
transform "NO:Oslo NGO48→ETRS89"         EPSG:4273 EPSG:4258 10.7522  59.9139 0  >> "$OUT"

# WGS84→UTM worldwide
transform "EU:Berlin WGS84→UTM32N"       EPSG:4326 EPSG:32632 13.4050 52.5200 0  >> "$OUT"
transform "EU:London WGS84→UTM30N"       EPSG:4326 EPSG:32630 -0.1278 51.5074 0  >> "$OUT"
transform "EU:Paris WGS84→UTM31N"        EPSG:4326 EPSG:32631 2.3522  48.8566 0  >> "$OUT"

###############################################################################
# OCEANIA
###############################################################################
# NZ: NZGD49→NZGD2000 (grid-based)
transform "NZ:Wellington NZGD49→2000"    EPSG:4272 EPSG:4167 174.7762 -41.2865 0 >> "$OUT"
transform "NZ:Auckland NZGD49→2000"      EPSG:4272 EPSG:4167 174.7633 -36.8485 0 >> "$OUT"
# NZTM (projected)
transform "NZ:Wellington WGS84→NZTM"     EPSG:4326 EPSG:2193 174.7762 -41.2865 0 >> "$OUT"

# Australia: GDA94→GDA2020 (conformal grid)
transform "AU:Sydney GDA94→GDA2020"      EPSG:4283 EPSG:7844 151.2093 -33.8688 0 >> "$OUT"
transform "AU:Melbourne GDA94→GDA2020"   EPSG:4283 EPSG:7844 144.9631 -37.8136 0 >> "$OUT"
# MGA (Map Grid of Australia) zone 56
transform "AU:Sydney WGS84→MGA56"        EPSG:4326 EPSG:28356 151.2093 -33.8688 0 >> "$OUT"

###############################################################################
# GLOBAL — EGM96 geoid
###############################################################################
transform "GL:London WGS84→EGM96"        EPSG:4979 EPSG:5773 -0.1278  51.5074  80  >> "$OUT"
transform "GL:Tokyo WGS84→EGM96"         EPSG:4979 EPSG:5773 139.7671 35.6812  80  >> "$OUT"
transform "GL:Sydney WGS84→EGM96"        EPSG:4979 EPSG:5773 151.2093 -33.8688 80  >> "$OUT"

COUNT=$(tail -n +2 "$OUT" | wc -l)
echo "Generated $COUNT test cases → $OUT" >&2
