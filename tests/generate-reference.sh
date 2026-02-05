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
# by checking projinfo WKT for the first AXIS abbreviation and direction.
# Returns 0 (true=needs swap) if first axis is northing/latitude.
# Note: polar stereographic CRS may have direction="north" but abbreviation="(E)" → no swap.
needs_swap() {
  local crs="$1"
  local first_axis_line
  first_axis_line=$(projinfo "$crs" 2>&1 | grep -P 'AXIS\[' | head -1)
  # Check abbreviation: if first axis is labeled (E) or (X), it's easting → no swap
  if echo "$first_axis_line" | grep -qP 'AXIS\["\(E\)"|AXIS\["[Ee]asting'; then
    return 1  # easting first → no swap
  fi
  # Otherwise fall back to direction check
  local first_dir
  first_dir=$(echo "$first_axis_line" | grep -oP '(north|south|east|west|up)' | tail -1)
  case "$first_dir" in
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
  # For vertical-only CRS (first axis = "up"), PROJ preserves source horizontal
  # axis order, so inherit swap from source CRS.
  local out_x out_y
  local dst_first_line dst_first
  dst_first_line=$(projinfo "$dst" 2>&1 | grep -P 'AXIS\[' | head -1)
  # Check for easting abbreviation first (handles polar stereographic)
  if echo "$dst_first_line" | grep -qP 'AXIS\["\(E\)"|AXIS\["[Ee]asting'; then
    dst_first="east"
  else
    dst_first=$(echo "$dst_first_line" | grep -oP '(north|south|east|west|up)' | tail -1)
  fi
  if [ "$dst_first" = "up" ]; then
    # vertical-only dst: output horizontal order = source order
    if needs_swap "$src"; then
      out_x="$c2"; out_y="$c1"
    else
      out_x="$c1"; out_y="$c2"
    fi
  elif needs_swap "$dst"; then
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

###############################################################################
# SOUTH AMERICA — Brazil, Argentina
###############################################################################
# Brazil: SAD69→SIRGAS2000 (grid: br_ibge_SAD69_003.tif)
transform "BR:SaoPaulo SAD69→SIRGAS"     EPSG:4618 EPSG:4674 -46.633  -23.550  0   >> "$OUT"
# Brazil: WGS84→UTM23S
transform "BR:SaoPaulo WGS84→UTM23S"     EPSG:4326 EPSG:31983 -46.633 -23.550  0   >> "$OUT"
# Argentina: WGS84→POSGAR2007 zone5
transform "AR:BuenosAires WGS84→POSGAR5" EPSG:4326 EPSG:5347 -58.382  -34.604  0   >> "$OUT"

###############################################################################
# EUROPE — additional countries
###############################################################################
# Spain: ED50→ETRS89 (grid: es_ign_SPED2ETV2.tif)
transform "ES:Madrid ED50→ETRS89"        EPSG:4230 EPSG:4258 -3.704   40.417   0   >> "$OUT"
# Portugal: D73→ETRS89 (grid: pt_dgt_D73_ETRS89_geo.tif)
transform "PT:Lisbon D73→ETRS89"         EPSG:4274 EPSG:4258 -9.139   38.722   0   >> "$OUT"
# Czech Republic: S-JTSK→ETRS89 (grid: cz_cuzk_table_jtsk)
transform "CZ:Prague SJTSK→ETRS89"       EPSG:4156 EPSG:4258 14.418   50.076   0   >> "$OUT"
# Denmark: WGS84→ETRS89/UTM32N
transform "DK:Copenhagen WGS84→UTM32"    EPSG:4326 EPSG:25832 12.568   55.676   0   >> "$OUT"
# Finland: KKJ→EUREF-FIN (grid: fi_nls_ykj_etrs35fin.json)
transform "FI:Helsinki KKJ→EUREF"        EPSG:2393 EPSG:3067 3385000  6672000  0   >> "$OUT"
# Sweden: WGS84→SWEREF99TM
transform "SE:Stockholm WGS84→SWEREF99"  EPSG:4326 EPSG:3006 18.069   59.329   0   >> "$OUT"
# Poland: WGS84→PUWG2000/zone7
transform "PL:Warsaw WGS84→PUWG2000z7"   EPSG:4326 EPSG:2180 21.012   52.230   0   >> "$OUT"
# Hungary: HD72→ETRS89 (grid: hu_bme_hd72corr.tif)
transform "HU:Budapest HD72→ETRS89"      EPSG:4237 EPSG:4258 19.040   47.498   0   >> "$OUT"
# Iceland: ISN93→ISN2016 (grid: is_lmi_ISN93_ISN2016.tif)
transform "IS:Reykjavik ISN93→ISN2016"   EPSG:4659 EPSG:8086 -21.896  64.146   0   >> "$OUT"

###############################################################################
# MIDDLE EAST / AFRICA
###############################################################################
# Turkey: WGS84→UTM36N
transform "TR:Istanbul WGS84→UTM36N"     EPSG:4326 EPSG:32636 29.009   41.009   0   >> "$OUT"
# Mexico: WGS84→UTM14N
transform "MX:MexicoCity WGS84→UTM14N"   EPSG:4326 EPSG:32614 -99.133  19.433   0   >> "$OUT"
# South Africa: WGS84→Hartebeest Lo29 (axis=wsu)
transform "ZA:Joburg WGS84→Lo29"         EPSG:4326 EPSG:2053 28.047   -26.204  0   >> "$OUT"
# South Africa: Cape→Hartebeest (grid: za_cdngi_sageoid2010.tif)
transform "ZA:Joburg Cape→Hartebeest"    EPSG:4222 EPSG:4148 28.047   -26.204  0   >> "$OUT"

###############################################################################
# CANADA — MTM
###############################################################################
# NAD83(CSRS)→MTM8
transform "CA:Montreal NAD83→MTM8"        EPSG:4617 EPSG:2950 -73.568  45.502   0   >> "$OUT"

###############################################################################
# PROJECTION TYPES — Polar, Albers, LAEA, Krovak
###############################################################################
# Polar Stereographic Antarctic
transform "GL:Antarctic WGS84→3031"       EPSG:4326 EPSG:3031 0        -75      0   >> "$OUT"
# Polar Stereographic Arctic
transform "GL:Arctic WGS84→3995"          EPSG:4326 EPSG:3995 0        85       0   >> "$OUT"
# UPS South
transform "GL:UPS-South WGS84→32761"      EPSG:4326 EPSG:32761 0       -85      0   >> "$OUT"
# UPS North
transform "GL:UPS-North WGS84→32661"      EPSG:4326 EPSG:32661 0       88       0   >> "$OUT"
# Albers Equal Area (NAD83 Conus Albers)
transform "US:Central WGS84→Albers"       EPSG:4326 EPSG:5070 -98      39       0   >> "$OUT"
# LAEA Europe
transform "EU:Center WGS84→LAEA"          EPSG:4326 EPSG:3035 10       52       0   >> "$OUT"
# Krovak (S-JTSK/05)
transform "CZ:Prague WGS84→Krovak"        EPSG:4326 EPSG:5514 14.418   50.076   0   >> "$OUT"
# South-oriented TM (same as Lo29 above, redundant but explicit projection test)

###############################################################################
# EDGE CASES
###############################################################################
# Identity transform
transform "GL:Identity 4326→4326"         EPSG:4326 EPSG:4326 139.767  35.681   0   >> "$OUT"
# WGS72→WGS84
transform "GL:WGS72→WGS84"               EPSG:4322 EPSG:4326 139.767  35.681   0   >> "$OUT"
# Antimeridian
transform "GL:Antimeridian UTM1N"         EPSG:4326 EPSG:32601 177     5        0   >> "$OUT"
# Antimeridian south
transform "GL:Antimeridian UTM60S"        EPSG:4326 EPSG:32760 179     -45      0   >> "$OUT"
# Very high latitude
transform "GL:HighLat 89.99→3031"         EPSG:4326 EPSG:3031 0        -89.99   0   >> "$OUT"
# UTM boundary (84°N)
transform "GL:UTM-north-limit"            EPSG:4326 EPSG:32632 9       84       0   >> "$OUT"
# Cross-hemisphere: Sydney → LAEA Europe
transform "GL:Sydney→LAEA-EU"             EPSG:4326 EPSG:3035 151.2    -33.9    0   >> "$OUT"

###############################################################################
# GLOBAL — EGM2008 geoid
###############################################################################
transform "GL:Tokyo WGS84→EGM2008"        EPSG:4979 EPSG:3855 139.7671 35.6812  80  >> "$OUT"
transform "GL:NYC WGS84→EGM2008"          EPSG:4979 EPSG:3855 -74.006  40.7128  30  >> "$OUT"
transform "GL:London WGS84→EGM2008"       EPSG:4979 EPSG:3855 -0.1278  51.5074  80  >> "$OUT"
transform "GL:Sydney WGS84→EGM2008"       EPSG:4979 EPSG:3855 151.2093 -33.8688 80  >> "$OUT"

###############################################################################
# INVERSE: projected → geographic
###############################################################################
# Japan Plane Rectangular → WGS84
transform "JP:IX→WGS84 Tokyo"             EPSG:6677 EPSG:4326 -5995.19 -35367.23 0  >> "$OUT"
transform "JP:VI→WGS84 Osaka"             EPSG:6674 EPSG:4326 -45598.42 -144802.79 0 >> "$OUT"
transform "JP:XII→WGS84 Sapporo"          EPSG:6680 EPSG:4326 -73558.30 -103797.33 0 >> "$OUT"
# UTM → WGS84
transform "US:UTM18N→WGS84 NYC"           EPSG:32618 EPSG:4326 583959.37 4507350.99 0 >> "$OUT"
transform "US:UTM10N→WGS84 SF"            EPSG:32610 EPSG:4326 551130.77 4180998.88 0 >> "$OUT"
transform "EU:UTM32N→WGS84 Berlin"        EPSG:32632 EPSG:4326 798812.80 5828000.00 0 >> "$OUT"
# European projections → WGS84
transform "FR:Lambert93→WGS84 Paris"      EPSG:2154 EPSG:4326 652469.02 6862035.26 0  >> "$OUT"
transform "UK:BNG→WGS84 Edinburgh"        EPSG:27700 EPSG:4326 325000   674000     0  >> "$OUT"
transform "CH:LV95→WGS84 Bern"            EPSG:2056 EPSG:4326 2600667.47 1199668.43 0 >> "$OUT"
# Southern hemisphere
transform "AU:MGA56→WGS84 Sydney"         EPSG:28356 EPSG:4326 334368.63 6250948.35 0 >> "$OUT"
transform "NZ:NZTM→WGS84 Wellington"      EPSG:2193 EPSG:4326 1748735.55 5427916.48 0 >> "$OUT"
transform "BR:UTM23S→WGS84 SaoPaulo"      EPSG:31983 EPSG:4326 333317.91 7394644.04 0 >> "$OUT"

###############################################################################
# PROJECTED → PROJECTED (cross-zone, cross-system)
###############################################################################
# Japan zone to zone
transform "JP:IX→VI Tokyo-to-Osaka"       EPSG:6677 EPSG:6674 -5995.19 -35367.23 0  >> "$OUT"
transform "JP:XII→XI Sapporo-to-Otaru"    EPSG:6680 EPSG:6679 -73558.30 -103797.33 0 >> "$OUT"
# UTM zone to zone
transform "US:UTM18N→UTM17N NYC"          EPSG:32618 EPSG:32617 583959.37 4507350.99 0 >> "$OUT"
transform "EU:UTM32N→UTM33N Berlin"       EPSG:32632 EPSG:32633 798812.80 5828000.00 0 >> "$OUT"
# Cross-system Europe
transform "EU:BNG→Lambert93"              EPSG:27700 EPSG:2154 530000   180000     0  >> "$OUT"
transform "EU:Lambert93→UTM31N"           EPSG:2154 EPSG:32631 652469.02 6862035.26 0 >> "$OUT"
transform "EU:GK4→LV95 Berlin-to-Bern"    EPSG:31468 EPSG:2056 4587442  5822377    0  >> "$OUT"
# Cross-hemisphere projected
transform "AU:MGA56→NZTM Sydney-to-NZ"    EPSG:28356 EPSG:2193 334368.63 6250948.35 0 >> "$OUT"

###############################################################################
# 3D WITH HEIGHT — ellipsoidal height transforms
###############################################################################
# WGS84 3D → Japan Plane Rectangular (height passthrough)
transform "JP:4979→6677 Z=100"            EPSG:4979 EPSG:6677 139.7671 35.6812  100  >> "$OUT"
transform "JP:4979→6677 Z=500"            EPSG:4979 EPSG:6677 139.7671 35.6812  500  >> "$OUT"
transform "JP:4979→6677 Z=3776"           EPSG:4979 EPSG:6677 138.7274 35.3606  3776 >> "$OUT"
# Various heights for geoid
transform "JP:GSIGEO Z=0"                 EPSG:6667 EPSG:6697 139.7671 35.6812  0    >> "$OUT"
transform "JP:GSIGEO Z=100"               EPSG:6667 EPSG:6697 139.7671 35.6812  100  >> "$OUT"
transform "JP:GSIGEO Z=500"               EPSG:6667 EPSG:6697 139.7671 35.6812  500  >> "$OUT"
transform "JP:GSIGEO Z=-50 (below geoid)" EPSG:6667 EPSG:6697 139.7671 35.6812  -50  >> "$OUT"
# EGM96 various heights
transform "GL:EGM96 NYC Z=0"              EPSG:4979 EPSG:5773 -74.006  40.7128  0    >> "$OUT"
transform "GL:EGM96 NYC Z=500"            EPSG:4979 EPSG:5773 -74.006  40.7128  500  >> "$OUT"
# Inverse geoid (compound with orthometric → 3D ellipsoidal)
transform "JP:6697→6667 Tokyo"            EPSG:6697 EPSG:6667 139.7671 35.6812  39.34 >> "$OUT"
# Note: 5773 is vertical-only, cannot be used as standalone source in cs2cs

###############################################################################
# COMPOUND CRS — explicit compound transforms
###############################################################################
# JGD2011 3D → JGD2011 + JGD2011(vertical) compound (6697)
transform "JP:6667→6697 compound"         EPSG:6667 EPSG:6697 139.7671 35.6812  76   >> "$OUT"
# WGS84 → WGS84+EGM2008 compound (9518)
transform "GL:4979→9518 Tokyo"            EPSG:4979 EPSG:9518 139.7671 35.6812  80   >> "$OUT"
transform "GL:4979→9518 NYC"              EPSG:4979 EPSG:9518 -74.006  40.7128  30   >> "$OUT"
# ETRS89 + EVRF2000 (European, 7409)
transform "EU:4937→7409 Berlin"           EPSG:4937 EPSG:7409 13.405   52.520   80   >> "$OUT"
# NAD83 3D + NAVD88 (US, 5498)
transform "US:4152→5498 NYC"              EPSG:4152 EPSG:5498 -74.006  40.7128  30   >> "$OUT"

###############################################################################
# SOUTHERN HEMISPHERE — additional coverage
###############################################################################
# Australia additional cities
transform "AU:Perth WGS84→MGA50"          EPSG:4326 EPSG:28350 115.8605 -31.9505 0  >> "$OUT"
transform "AU:Brisbane WGS84→MGA56"       EPSG:4326 EPSG:28356 153.0251 -27.4698 0  >> "$OUT"
transform "AU:Adelaide WGS84→MGA54"       EPSG:4326 EPSG:28354 138.6007 -34.9285 0  >> "$OUT"
# New Zealand additional
transform "NZ:Auckland WGS84→NZTM"        EPSG:4326 EPSG:2193 174.7633 -36.8485 0  >> "$OUT"
transform "NZ:Christchurch WGS84→NZTM"    EPSG:4326 EPSG:2193 172.6362 -43.5321 0  >> "$OUT"
# South America additional
transform "CL:Santiago WGS84→UTM19S"      EPSG:4326 EPSG:32719 -70.6693 -33.4489 0  >> "$OUT"
transform "AR:Mendoza WGS84→POSGAR5"      EPSG:4326 EPSG:5347 -68.8272 -32.8895 0  >> "$OUT"
# Antarctica
transform "GL:McMurdo WGS84→3031"         EPSG:4326 EPSG:3031 166.6667 -77.8500 0  >> "$OUT"
transform "GL:Vostok WGS84→3031"          EPSG:4326 EPSG:3031 106.8667 -78.4500 0  >> "$OUT"

###############################################################################
# ASIA — additional countries
###############################################################################
# China: WGS84→CGCS2000
transform "CN:Beijing WGS84→CGCS2000"     EPSG:4326 EPSG:4490 116.4074 39.9042  0   >> "$OUT"
transform "CN:Shanghai WGS84→CGCS2000"    EPSG:4326 EPSG:4490 121.4737 31.2304  0   >> "$OUT"
# Korea: WGS84→Korea2000
transform "KR:Seoul WGS84→Korea2000"      EPSG:4326 EPSG:4737 126.9780 37.5665  0   >> "$OUT"
transform "KR:Busan WGS84→Korea2000"      EPSG:4326 EPSG:4737 129.0756 35.1796  0   >> "$OUT"
# Taiwan: WGS84→TWD97
transform "TW:Taipei WGS84→TWD97"         EPSG:4326 EPSG:3824 121.5654 25.0330  0   >> "$OUT"
# India: WGS84→UTM44N
transform "IN:Delhi WGS84→UTM44N"         EPSG:4326 EPSG:32644 77.2090  28.6139  0   >> "$OUT"
transform "IN:Mumbai WGS84→UTM43N"        EPSG:4326 EPSG:32643 72.8777  19.0760  0   >> "$OUT"
# Thailand: WGS84→UTM47N
transform "TH:Bangkok WGS84→UTM47N"       EPSG:4326 EPSG:32647 100.5018 13.7563  0   >> "$OUT"
# Vietnam: WGS84→UTM48N
transform "VN:Hanoi WGS84→UTM48N"         EPSG:4326 EPSG:32648 105.8342 21.0278  0   >> "$OUT"
# Singapore: WGS84→SVY21
transform "SG:Singapore WGS84→SVY21"      EPSG:4326 EPSG:3414 103.8198 1.3521   0   >> "$OUT"
# Philippines: WGS84→PRS92
transform "PH:Manila WGS84→PRS92"         EPSG:4326 EPSG:4683 120.9842 14.5995  0   >> "$OUT"
# Indonesia: WGS84→UTM49S
transform "ID:Jakarta WGS84→UTM49S"       EPSG:4326 EPSG:32749 106.8456 -6.2088  0   >> "$OUT"

###############################################################################
# MIDDLE EAST — additional
###############################################################################
# UAE: WGS84→UTM40N
transform "AE:Dubai WGS84→UTM40N"         EPSG:4326 EPSG:32640 55.2708  25.2048  0   >> "$OUT"
# Saudi Arabia: WGS84→UTM37N
transform "SA:Riyadh WGS84→UTM37N"        EPSG:4326 EPSG:32637 46.6753  24.7136  0   >> "$OUT"
# Israel: WGS84→ITM
transform "IL:TelAviv WGS84→ITM"          EPSG:4326 EPSG:2039 34.7818  32.0853  0   >> "$OUT"
# Egypt: WGS84→UTM36N
transform "EG:Cairo WGS84→UTM36N"         EPSG:4326 EPSG:32636 31.2357  30.0444  0   >> "$OUT"

###############################################################################
# AFRICA — additional
###############################################################################
# Nigeria: WGS84→UTM32N
transform "NG:Lagos WGS84→UTM32N"         EPSG:4326 EPSG:32632 3.3792   6.5244   0   >> "$OUT"
# Kenya: WGS84→UTM37S
transform "KE:Nairobi WGS84→UTM37S"       EPSG:4326 EPSG:32737 36.8219  -1.2921  0   >> "$OUT"
# Morocco: WGS84→Morocco Lambert
transform "MA:Casablanca WGS84→MorcLamb"  EPSG:4326 EPSG:26191 -7.5898  33.5731  0   >> "$OUT"

###############################################################################
# RUSSIA / EASTERN EUROPE
###############################################################################
# Russia: WGS84→UTM zone
transform "RU:Moscow WGS84→UTM37N"        EPSG:4326 EPSG:32637 37.6173  55.7558  0   >> "$OUT"
transform "RU:StPetersburg WGS84→UTM36N"  EPSG:4326 EPSG:32636 30.3351  59.9343  0   >> "$OUT"
# Ukraine: WGS84→UTM36N
transform "UA:Kyiv WGS84→UTM36N"          EPSG:4326 EPSG:32636 30.5234  50.4501  0   >> "$OUT"
# Romania: WGS84→Stereo70
transform "RO:Bucharest WGS84→Stereo70"   EPSG:4326 EPSG:3844 26.1025  44.4268  0   >> "$OUT"
# Greece: WGS84→GGRS87
transform "GR:Athens WGS84→GGRS87"        EPSG:4326 EPSG:2100 23.7275  37.9838  0   >> "$OUT"

###############################################################################
# SPECIAL PROJECTIONS — additional
###############################################################################
# Web Mercator (EPSG:3857)
transform "GL:Tokyo WGS84→WebMercator"    EPSG:4326 EPSG:3857 139.7671 35.6812  0   >> "$OUT"
transform "GL:NYC WGS84→WebMercator"      EPSG:4326 EPSG:3857 -74.006  40.7128  0   >> "$OUT"
transform "GL:London WGS84→WebMercator"   EPSG:4326 EPSG:3857 -0.1278  51.5074  0   >> "$OUT"
transform "GL:Sydney WGS84→WebMercator"   EPSG:4326 EPSG:3857 151.2093 -33.8688 0   >> "$OUT"
# Inverse Web Mercator
transform "GL:WebMerc→WGS84 Tokyo"        EPSG:3857 EPSG:4326 15554550 4257384  0   >> "$OUT"
transform "GL:WebMerc→WGS84 NYC"          EPSG:3857 EPSG:4326 -8238310 4970072  0   >> "$OUT"
# Note: Equidistant Cylindrical (4087/32662) has ~21km Y-axis discrepancy in WASM
# cs2cs: Y=3972013, WASM: Y=3950169 (diff=21843m, ~0.196° lat)
# Bug in WASM proj_normalize_for_visualization or eqc projection - needs investigation
# Note: Sinusoidal (54008), Mollweide (54009), Robinson (54030) are ESRI codes, not EPSG

###############################################################################
# DATUM SHIFT — legacy systems
###############################################################################
# Pulkovo 1942 → WGS84 (Eastern Europe/Russia)
transform "RU:Moscow Pulkovo42→WGS84"     EPSG:4284 EPSG:4326 37.6173  55.7558  0   >> "$OUT"
# AGD66 → GDA2020 (Australia old→new)
transform "AU:Sydney AGD66→GDA2020"       EPSG:4202 EPSG:7844 151.2093 -33.8688 0   >> "$OUT"
# SAD69 → WGS84 (South America)
transform "BR:SaoPaulo SAD69→WGS84"       EPSG:4618 EPSG:4326 -46.633  -23.550  0   >> "$OUT"
# ED50 → WGS84 (Europe legacy)
transform "ES:Madrid ED50→WGS84"          EPSG:4230 EPSG:4326 -3.704   40.417   0   >> "$OUT"
transform "IT:Rome ED50→WGS84"            EPSG:4230 EPSG:4326 12.4964  41.9028  0   >> "$OUT"
# NAD27 → WGS84 (North America)
transform "US:NYC NAD27→WGS84"            EPSG:4267 EPSG:4326 -74.006  40.7128  0   >> "$OUT"
transform "US:LA NAD27→WGS84"             EPSG:4267 EPSG:4326 -118.2437 33.9425 0   >> "$OUT"

###############################################################################
# EXTREME COORDINATES
###############################################################################
# Near date line
transform "GL:Fiji WGS84→UTM60S"          EPSG:4326 EPSG:32760 178.0650 -17.7134 0   >> "$OUT"
transform "GL:Tonga WGS84→UTM1S"          EPSG:4326 EPSG:32701 -175.198 -21.179  0   >> "$OUT"
# Very high latitude
transform "GL:Svalbard WGS84→UTM33N"      EPSG:4326 EPSG:32633 15.6356  78.2232  0   >> "$OUT"
transform "GL:NorthPole WGS84→UPS-N"      EPSG:4326 EPSG:32661 0        89       0   >> "$OUT"
# Equator crossings
transform "GL:Quito WGS84→UTM17S"         EPSG:4326 EPSG:32717 -78.4678 -0.1807  0   >> "$OUT"
transform "GL:Nairobi WGS84→UTM37S"       EPSG:4326 EPSG:32737 36.8219  -1.2921  0   >> "$OUT"

# Note: Vertical-only CRS (5790 OSGM15, 5799 DVR90, 5621 EVRF2007, 5711 AHD, 7839 NZVD2016)
# cannot be used directly as cs2cs destination - need compound CRS

###############################################################################
# 3D GEOGRAPHIC — ellipsoidal height variations
###############################################################################
transform "JP:Tokyo 4979 Z=1000"          EPSG:4979 EPSG:6677 139.7671 35.6812  1000 >> "$OUT"
transform "GL:Everest 4979 Z=8849"        EPSG:4979 EPSG:32645 86.9250  27.9881  8849 >> "$OUT"
transform "GL:DeadSea 4979 Z=-430"        EPSG:4979 EPSG:32636 35.4732  31.5000  -430 >> "$OUT"
transform "GL:MarianaTrench 4979 Z=-10994" EPSG:4979 EPSG:32655 142.1991 11.3493 -10994 >> "$OUT"

COUNT=$(tail -n +2 "$OUT" | wc -l)
echo "Generated $COUNT test cases → $OUT" >&2
