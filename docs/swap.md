# Axis Swap 調査結果

## 1. cs2cs (ローカルPROJ) の軸順

cs2cs は常に EPSG Authority Axis Order で入出力する。

| CRS | EPSG軸順 | cs2cs入力例 | cs2cs出力例 |
|-----|----------|-----------|-----------|
| 4326 | lat, lon | `35.68 139.77` | `35.68 139.77` |
| 6677 | northing(X), easting(Y) | `N E` | `-35367 -5995` |
| 32618 | easting, northing | `E N` | `583959 4507350` |
| 3031 | (E)north, (N)north | 特殊 | `0 1638783` |

cs2cs単体ではswapは不要。常にEPSG順で入れて、EPSG順で出てくる。

## 2. WASM API の2つのパス

`src/proj_wasm.c` の `proj_get_op()` には2パスある:

### パスA: non-vertical CRS (`has_vert == 0`)

```
proj_create_crs_to_crs → proj_normalize_for_visualization
```

`proj_normalize_for_visualization` がパイプラインのaxisswapステップを除去し、
入力=**lon,lat**、出力=**easting,northing** に正規化。手動swapは不要。

### パスB: vertical CRS (`has_vert == 1`)

```
proj_create_crs_to_crs_from_pj (normalizeなし)
→ crs_obj_is_north_east() で手動軸検出
→ g_swap_in / g_swap_out フラグ設定
```

`proj_normalize_for_visualization` を**使わない**。理由:

> proj_normalize_for_visualization inserts axis-swap steps that
> can interfere with vgridshift grid candidate selection
> (observed in PROJ 9.6-9.8; no upstream fix confirmed as of 9.7.1)

Vertical CRS (ジオイド等) ではnormalizeが挿入するaxisswapがvgridshiftのグリッド検索を妨害するバグがある。

## 3. `crs_obj_is_north_east()` の検出条件

C関数は厳密に `dir0=="north" && dir1=="east"` のみswap=1を返す:

| CRS | dir0 | dir1 | is_north_east | swap? |
|-----|------|------|---------------|-------|
| 4326 | north | east | YES | swap |
| 6677 | north | east | YES | swap |
| 4979 | north | east | YES | swap |
| 6667 | north | east | YES | swap |
| 6697 | north | east | YES | swap |
| 3031 | north | north | no | |
| 3995 | south | south | no | |
| 2053 | west | south | no | |
| 32618 | east | north | no | |

典型的なgeographic CRS (lat,lon) と日本の平面直角座標系 (northing,easting) のみがswap対象。

## 4. generate-reference.sh の `needs_swap()` の役割

cs2cs自体のためではなく、**reference.csvの値をWASM APIの出力形式に揃える**ために存在する。

```
cs2cs出力 (EPSG軸順)     → needs_swap で変換 → CSV (lon,lat / easting,northing)
                                                    ↕ 比較
WASM API出力 (normalize済み)                   → (lon,lat / easting,northing)
```

### needs_swap() のロジック (generate-reference.sh)

1. projinfo WKTの第1軸を取得
2. 略称が `(E)` or `Easting` → easting first → swap不要
3. それ以外: 方向が `north` or `south` → lat/northing first → swap必要
4. それ以外 → swap不要

極投影CRS (EPSG:3031) は第1軸 `AXIS["(E)",north]` で、方向はnorthだが略称は(E)。
略称チェックが先に入るため正しくswap不要と判定される。

## 5. PROJパイプラインのaxisswap構造

```
4326→6677:   [axisswap 2,1] → deg→rad → tmerc → [axisswap 2,1]
             入力: lat,lon→lon,lat    出力: easting,northing→northing,easting

4326→32618:  [axisswap 2,1] → deg→rad → utm
             入力: lat,lon→lon,lat    出力: そのままeasting,northing

4326→3031:   [axisswap 2,1] → deg→rad → stere
             入力: lat,lon→lon,lat    出力: そのまま(E),(N)

4979→5773:   [axisswap 2,1] → deg→rad → inv vgridshift → rad→deg → [axisswap 2,1]
             入力: lat,lon→lon,lat    出力: lon,lat→lat,lon
```

`proj_normalize_for_visualization` は先頭と末尾のaxisswapを除去:
- swaps=2: 両方除去 → 入力lon,lat, 出力easting,northing (or lon,lat)
- swaps=1: 先頭のみ除去 → 入力lon,lat, 出力すでにeasting,northing

## 6. 結論

| 質問 | 回答 |
|------|------|
| ローカルPROJ (cs2cs) にswapは必要? | **不要**。cs2csは常にEPSG軸順 |
| generate-reference.sh のswapが必要な理由 | **WASM APIとの比較のため**。WASM APIは `proj_normalize_for_visualization` で lon,lat/easting,northing に正規化済み。CSVも同じ順序にしないと比較テストが成立しない |
| WASM APIのverticalパスで手動swapが必要な理由 | **PROJバグ回避**。normalizeがvgridshiftのグリッド検索を壊すため、normalizeを使わず `crs_obj_is_north_east()` で手動検出 |
