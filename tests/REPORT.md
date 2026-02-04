# Host vs WASM 座標変換比較テスト結果

## テスト手順

1. `tests/generate-reference.sh` でホスト側 cs2cs (PROJ 9.7.0) を使い21件の変換結果をCSV出力
   - `PROJ_DATA=third_party/sc-proj-data/proj` でWASMと同一グリッド使用
   - cs2csはEPSG軸順(lat,lon)で入出力 → スクリプト内でlon,lat順に正規化して保存
2. `tests/comparison.html` でブラウザWASM (PROJ 9.8.0) 変換を実行し、CSVのホスト結果と比較
   - 許容誤差: 地理座標 1e-6°, 投影座標 0.01m, 高さ 0.01m
3. `python3 -m http.server 8765` で配信、ブラウザで確認

## テスト結果（修正前）

**14/21 PASS, 7 FAIL**

### PASS (14件) — 差分 1e-11 以下

| カテゴリ | 件数 | 備考 |
|---------|------|------|
| WGS84→JGD2011平面直角 (IX,VI,XII,XV,X系) | 5 | 完全一致 |
| 旧日本測地系→JGD2011 (東京,大阪,札幌) | 3 | Ballpark変換(グリッドなし)だが一致 |
| JGD2000→JGD2011 (東京,仙台,大阪) | 3 | 同上、入力=出力(identity) |
| GSIGEO2011ジオイド (東京,大阪,札幌) | 3 | Z値も完全一致 |

### FAIL (7件) — X,Yが入れ替わっている

| カテゴリ | 件数 | 症状 |
|---------|------|------|
| EPSG:6667→EPSG:6695 (JPGEO2024ジオイド) | 4 | lon,latが逆 |
| EPSG:4979→CZM:JGD2024 (JGD2024標高) | 3 | lon,latが逆 |

全7件ともZ値(高さ)は完全一致。水平成分のlon/latが入れ替わっている。

## 原因分析

`src/proj_wasm.c` の自作swap処理が原因。

### 正常系の動作 (GSIGEO2011: EPSG:6667→EPSG:6697)

```
EPSG:6697 = COMPOUNDCRS(GEOGRAPHIC_2D + VERTICAL)
  → crs_has_vertical() = 1 → normalize_for_visualization スキップ
  → g_swap_out = crs_is_latlon(EPSG:6697)
    → COMPOUND_CRS → sub_crs(0) = GEOGRAPHIC_2D → return 1
  → 出力を lon,lat にswap ✓
```

### 異常系の動作 (JPGEO2024: EPSG:6667→EPSG:6695, JGD2024: EPSG:4979→CZM:JGD2024)

```
EPSG:6695 = VERTCRS (vertical単体、compound でない)
CZM:JGD2024 = VERTCRS (同上)
  → crs_has_vertical() = 1 → normalize_for_visualization スキップ
  → g_swap_out = crs_is_latlon(EPSG:6695)
    → PJ_TYPE_VERTICAL_CRS → switch default → return 0
  → 出力のswapが行われない
  → PROJの内部軸順 lat,lon がそのままJSに返る ✗
```

### 問題箇所

`crs_is_latlon()` (proj_wasm.c:29) は `GEOGRAPHIC_2D`, `GEOGRAPHIC_3D`, `COMPOUND_CRS` の3タイプしか処理していない。`VERTICAL_CRS` はdefaultに落ちて `return 0` になる。

しかし実際にはdst CRSがvertical単体でも、PROJの変換パイプライン内部では水平成分がlat,lon順で流れている。dstのCRS型だけでは出力軸順を判定できない。

### PASSするGSIGEO2011との違い

- EPSG:6697 = `JGD2011 + JGD2011(vertical) height` → **COMPOUND_CRS** → sub_crs(0)がgeographic → swap_out=1 ✓
- EPSG:6695 = `JGD2011(vertical) height` → **VERTICAL_CRS** → swap処理なし ✗

同じジオイド変換でも、dst CRSが compound か vertical 単体かでswap判定が分かれる。

### 修正方針

`crs_is_latlon()` でdstがVERTICAL_CRSの場合、**ソースCRS側の水平成分の軸順を引き継ぐ**ようにするか、あるいは `proj_normalize_for_visualization` をvertical CRSでも安全に使える条件を調査して適用する。

## 修正内容

- `crs_has_vertical()` に `PJ_TYPE_VERTICAL_CRS` を追加し、vertical 単体 CRS でも normalize をスキップするようにした。
- dst が `VERTICAL_CRS` の場合は `g_swap_out` を **src の軸順 (`g_swap_in`) に合わせる**ようにした。
  - これにより、vertical 単体の CRS でも PROJ 内部の水平成分の軸順（lat,lon）を正しく補正できる。

対象ファイル: `src/proj_wasm.c`

## テスト結果（修正後）

**21/21 PASS**

再テスト手順:
- `nix develop -c scripts/build-proj-wasm.sh`
- `npm run test:browser`（Playwright headless で `tests/comparison.html` を実行）
