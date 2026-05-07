# Plan v2.1: Client-driven selective proj-data delivery (via Hono server)

> 本 plan は v1 → v2 → **v2.1** で 2 度の Codex CLI 厳格レビューを反映 (重大誤り合計 8 件、抜け 11 件)。

## Context

現状: `assets/proj-data.tar.gz` (893MB圧縮 / 1014MB展開, 526ファイル) を全送信→OPFS→MEMFS。
ほとんどのユーザは数個のgridしか使わないので無駄。

目的: **Honoサーバ**から `proj.db` (~9.4MB) と必要gridのみを個別配信、Client が変換時に必要分だけlazy-fetch。**Helmert/ballpark の silent fallback を完全禁止 (strict mode)**。

### 重大な前提誤りの是正 (v1 → v2)
1. **`proj_grid_cache_clear()` は availability cache を消さない** — network chunk cache 専用 (`networkfilemanager.cpp:2482`)。grid availability は `DatabaseContext::Private::cacheGridInfo_` (`factory.cpp:3436,3552`) に別キャッシュされる。→ Phase 0 で実測、必要なら context 再作成へ。
2. **既存 `g_op` キャッシュ** (`src/proj_wasm.c:81`) を破棄しないと fallback op が残る。
3. **`proj_coordoperation_is_instantiable` は op引数依存** — `proj_create_crs_to_crs` で作った op に呼ぶと既に Helmert fallback 済みの可能性。`IGNORED` 列挙の best op 自体に対して呼ぶ必要。
4. **「先頭op = 最高精度」は座標依存の場合に誤る** — `proj_get_suggested_operation()` で座標毎の選択が必要。
5. **vertical/compound CRS 独自経路** (`src/proj_wasm.c:95`) と enumeration ロジックを共通化必須。
6. **固定URL に `immutable`** はキャッシュ事故。`/api/proj-data/v/<version>/...` と versioned URL にする。

---

## Phase 0: PROJ cache invalidation 実測 (実装前必須)

ヘッドレス (Node + node-emscripten or browser単体) で:
1. proj.db のみマウント、`pw_grids_needed("EPSG:31370","EPSG:4326")` を呼ぶ
2. 結果 + `proj_coordoperation_is_instantiable` 戻り値を記録
3. MEMFS に `be_ign_bd72lb72_etrs89lb08.tif` を `FS.writeFile`
4. **何も呼ばず**に再度 `pw_grids_needed` / `is_instantiable` → 戻り値が変わるか
5. `proj_grid_cache_clear(ctx)` のみ → 変わるか
6. `g_op` 破棄 + `proj_grid_cache_clear` → 変わるか
7. `g_ctx` 破棄 + 新 `proj_context_create` → 変わるか (期待: 必ず変わる)

**output**: `docs/proj-cache-invalidation-test.md` に手順と結果を残す。Phase 1 の cache 戦略を確定する。

最悪ケース (`(7)` でしか効かない) でも対応可能なように、Phase 1 設計は **context 全体再作成** を前提に組む。

---

## Phase 1: C wrapper 抜本改修 (`src/proj_wasm.c`)

### 1a. CRS解決とoperation列挙の共通化

`pw_grids_needed`, `pw_transform`, `pw_is_instantiable` で同じCRS正規化/compound化ロジックを必ず共有。既存 `proj_get_op` (`src/proj_wasm.c:95`) の vertical/compound 経路を以下シグネチャに切り出す:

```c
static int resolve_crs_pair(const char* src, const char* dst,
                            PJ** out_src_crs, PJ** out_dst_crs,
                            int* out_swap_in,    // 1=入力 (x,y)→(y,x) (source が north,east の場合)
                            int* out_swap_out);  // 1=出力 swap (target north,east)
```

**`out_swap_in` は v2.1 追加** (Codex 指摘): `proj_get_suggested_operation` は source CRS の軸順で座標を解釈するため、JS から来た lon/lat を rawで渡すと EPSG:4267 など north/east 軸の geographic CRS で誤選択する。呼び出し側 (1b の `select_best_op`, 1e の `pw_transform`) は `swap_in` フラグを見て `PJ_COORD` を必ず正規化してから PROJ に渡す。

### 1b. best op 取得 (座標依存)

```c
// 内部関数: 入力座標(任意)を考慮した best non-ballpark op を返す
// x,y が NaN の場合は座標非依存 (bbox 全域)
static PJ* select_best_op(PJ* src_crs, PJ* dst_crs, double x, double y);
```

実装:
1. `proj_create_operation_factory_context(g_ctx, NULL)`
2. `proj_operation_factory_context_set_grid_availability_use(..., PROJ_GRID_AVAILABILITY_IGNORED)` — 欠落 grid 想定で列挙
3. `proj_operation_factory_context_set_spatial_criterion(..., PROJ_SPATIAL_CRITERION_PARTIAL_INTERSECTION)` — `proj_create_crs_to_crs` と同等の挙動 (`crs_to_crs.cpp:568`)
4. `proj_operation_factory_context_set_allow_ballpark_transformations(..., 0)` — Helmert近似 fallback 禁止 (`proj.h:1409`)
5. `proj_create_operations(g_ctx, src_crs, dst_crs, factory_ctx)` で候補リスト取得
6. 座標 NaN なら先頭、有効座標なら **swap_in を適用した後** `proj_get_suggested_operation(g_ctx, list, PJ_FWD, coord)` で選択 (`test_c_api.cpp:1922`)。具体的には `coord = swap_in ? proj_coord(y, x, z, t) : proj_coord(x, y, z, t)` (v2.1 修正)
7. `proj_coordoperation_has_ballpark_transformation(op) == 1` なら **NULL を返す** (strict)

### 1c. 公開API: `pw_grids_needed`

```c
int pw_grids_needed(const char* src, const char* dst, double x, double y,
                    char* out_buf, int buf_len);
// 戻り値: 書き込みbyte数 / 負値=エラー
//   -1=arg null, -2=CRS解決失敗, -3=best op無し(ballpark only), -4=buf overflow
// out: '[{"shortName":"...","fullName":"...","url":"...","available":0|1}, ...]'
```

実装:
1. `resolve_crs_pair` → `select_best_op(..., x, y)` (x,y は NaN 可)
2. `proj_coordoperation_get_grid_used_count(g_ctx, op)` でループ
3. `proj_coordoperation_get_grid_used(g_ctx, op, i, &short, &full, &pkg, &url, &direct, &openlic, &avail)` (`proj.h:1527`)
4. **JSON出力は専用 escape関数** で `\` `"` 制御文字を処理 (Codex指摘)
5. 全 PJ*, factory_ctx, list は最後に `proj_destroy` / `proj_operation_factory_context_destroy` / `proj_list_destroy` で解放

### 1d. 公開API: `pw_strict_check`

```c
int pw_strict_check(const char* src, const char* dst, double x, double y);
// 1=best non-ballpark op が instantiable / 0=grid欠落 or ballpark only / 負値=err
```

`select_best_op` で得た op に対して `proj_coordoperation_is_instantiable(g_ctx, op)`。

### 1e. `pw_transform` strict 化

変更内容:
1. **`g_op` キャッシュは座標依存になり得るため、座標毎の単純キャッシュを廃止** (or src/dst + suggested-op-id でkey化)
2. `select_best_op` で best op を取得 → NULL なら error code 6 (no_non_ballpark)
3. `proj_coordoperation_is_instantiable` == 0 なら error code 5 (missing_grid) を返す — Helmert fallback 禁止
4. その op で `proj_trans` 実行 (vertical/compound 既存ロジック保持)

### 1f. cache invalidation API: `pw_refresh_after_grid_write`

Phase 0 結果に応じて中身が決まる:
- ベスト: `proj_grid_cache_clear(g_ctx) + g_op破棄`
- 最悪: `proj_destroy(g_ctx) + proj_context_create() + proj_context_set_database_path + ...` (= `pw_init` 相当の再実行) + `g_op` 破棄

JS は grid 書込後に必ず本関数 1 回だけ呼ぶ。

```c
int pw_refresh_after_grid_write(void);
```

### 1g. EXPORTED_FUNCTIONS

`scripts/build-proj-wasm.sh:222` に追加:
- `_pw_grids_needed`
- `_pw_strict_check`
- `_pw_refresh_after_grid_write`

旧 `_pw_clear_cache` は内部用にして JS API から外す (整合のため)。

### 1h. error code 整理

| code | 意味 |
|---|---|
| 0 | success |
| 1 | init失敗 |
| 2 | null arg |
| 3 | op create失敗 |
| 4 | transform失敗 |
| 5 | missing_grid (strict reject) |
| 6 | ballpark_only (non-ballpark op無し) |
| 7 | buf_overflow |

JS 側 `MissingGridError(reason)` に1:1マップ。

---

## Phase 2: Honoサーバ + manifest生成

### 2a. Hono on Node

ランタイム: **Node.js** + `@hono/node-server` + `tsx` (devDep)。Cloudflare Workers はローカル `third_party/sc-proj-data` を stream できないので Phase 1 範囲外。

ディレクトリ:
```
server/
  index.ts                — Hono entry, port from env
  routes/
    manifest.ts           — GET /api/proj-data/v/:version/manifest
    proj-db.ts            — GET /api/proj-data/v/:version/proj.db
    grids.ts              — GET /api/proj-data/v/:version/grids/:name
    static.ts             — frontend (index.html, dist/*, examples/*)
    dev-fault.ts          — DEV only: GET /__dev/grid-404/:name (toggle)
package.json scripts:
  "dev:server": "tsx server/index.ts"
  "build:manifest": "node scripts/build-manifest.mjs"
```

新規依存: `hono`, `@hono/node-server`, `tsx`。

### 2b. ルート設計 (versioned URL で immutable cache 可)

| Method | Path | 動作 |
|---|---|---|
| GET | `/api/proj-data/manifest` | **redirect 302** to `/v/:current/manifest` (current=server起動時manifest.json読み込み) |
| GET | `/api/proj-data/v/:version/manifest` | manifest.json をJSON返却。`Cache-Control: public, max-age=3600` (短TTL) + ETag |
| GET | `/api/proj-data/v/:version/proj.db` | proj.db を stream。`Cache-Control: public, max-age=31536000, immutable` + ETag (sha256) |
| GET | `/api/proj-data/v/:version/grids/:name` | grid を stream。同 immutable。`:name` allow-list 検証必須 |
| GET | `/__dev/grid-404/:name` | DEV only: 指定 name を 404 にするフラグ ON/OFF |

### 2c. path traversal 多重防御 (Codex 指摘)

`:name` 検証 (`grids.ts`):
1. `decodeURIComponent` 後に `/`, `\`, `\0`, `..`, 空文字を拒否
2. **manifest allow-list** に正確一致する name のみ許可
3. `path.join(PROJ_DATA_DIR, name)` 後に `path.relative(PROJ_DATA_DIR, full)` が `..` 始まりでないことを確認

`:version` 検証: 起動時に固定された 1 値のみ許可 (旧 version は 410 Gone)。

### 2d. manifest 生成 (`scripts/build-manifest.mjs`)

build時1回:
- 入力: `third_party/sc-proj-data/proj/`
- 出力: `server/manifest.json`

```json
{
  "version": "<sha256(proj.db) の先頭16hex 又は third_party/sc-proj-data の git rev-parse HEAD>",
  "projDb":  { "size": 9876543, "sha256": "..." },
  "grids": {
    "be_ign_bd72lb72_etrs89lb08.tif": { "size": 12345, "sha256": "..." },
    ...
  }
}
```

**allow-list 抽出ロジック (v2.1: Codex 指摘で UNION 拡張)**:

```sql
-- DB 由来の grid 名候補 (UNION ALL)
SELECT proj_grid_name FROM grid_alternatives
UNION SELECT original_grid_name FROM grid_alternatives
UNION SELECT old_proj_grid_name FROM grid_alternatives WHERE old_proj_grid_name IS NOT NULL
UNION SELECT grid_name FROM grid_transformation
UNION SELECT grid_name FROM other_transformation WHERE grid_name IS NOT NULL
```

`grid_alternatives` だけだと `grid_transformation.grid_name not in grid_alternatives.original_grid_name` のレコードが 204 件落ちる (例: `czech_bpv.gtx`, `tr_hgm_TG20.gtx`, `geoid96_conus.tif`, `LV14.tif`, `hBG03.gtx` など)。これらが allow-list 外になるとサーバ 404 で正当な変換が失敗する。

手順:
1. 上記 UNION で DB 内の名前候補集合 D を作る
2. `third_party/sc-proj-data/proj/*` の実ファイル集合 F を取る (再帰スキャン、subdirectory 含む)
3. allow-list = D ∩ F (DB に名前があり実体もある)
4. D \ F (DB 参照だが実体無し) は WARN ログを出して manifest 除外 (運用で監視)
5. F \ D (実体だけありDB未参照、`Makefile` `proj.ini` `*README.txt` `usage` など) も manifest 除外
6. 拡張子フィルタは廃止 — 拡張子なし `nad27` `world` 等も DB 参照されていれば拾う

`generatedAt` は version に**含めない** (再現性、Codex 指摘)。

### 2e. 旧 `proj-data.tar.gz` 経路

Phase 1〜3 並走中は旧 `/assets/proj-data.tar.gz` も Hono が serveStatic で配信 (rollback 用)。Phase 5 で削除。

---

## Phase 3: JS runtime 改修

### 3a. proj.db 単独取得 + `.part` 保存 (`src/opfs/proj-data-worker.js`)

`extractTarToOPFS` (現:121-209) を廃止し:
1. `GET /api/proj-data/manifest` (redirect 追従) → version + projDb hash 取得
2. OPFS `version` marker 比較 — 不一致なら全 OPFS 配下削除 (旧 grid を捨てる)
3. `GET /api/proj-data/v/<version>/proj.db` を `proj.db.part` に書く (進捗イベント)
4. ストリーム終了後に sha256 検証 (Codex指摘: 検証前に本名で書かない)
5. 一致時のみ `proj.db.part` → `proj.db` に rename
6. 不一致なら `MissingGridError(reason:'hash_mismatch')` で abort
7. version marker を更新

### 3b. OPFS レイアウト (Codex 指摘の `collectOpfsFiles` 矛盾解消)

現状 `src/proj-runtime.js:7` の `collectOpfsFiles` は subdirectory をエラーにする。改修:
- OPFS root 直下: `version`, `proj.db`, `<grid-name>` (フラット維持)
- gridディレクトリは作らない (Codex 指摘の v1 矛盾を解消)
- `collectOpfsFiles` は最終的に `proj-worker.js` の `transferProjFiles` に渡され MEMFS 直下にフラット展開される (現状維持)

### 3c. 双方向 worker RPC (Codex 指摘)

現 `src/proj-worker.js:69-87` は main → worker 一方向。改修:
- `MessageChannel` で worker → main 要求も可能にするか、
- 単純化: worker が必要 grid を main に問い合わせる代わりに、**main が transform 受付前に `prepare(src, dst, x, y)` を呼ぶ 2 段階 RPC** にする:
  - main: `prepare(src,dst,x,y)` → worker: `pw_grids_needed` → main へ必要 grid リスト返却
  - main: 必要 grid を OPFS/サーバから取得 → worker に `addGrids({name: bytes,...})` で送付 → worker は MEMFS write + `pw_refresh_after_grid_write`
  - main: `transform(src,dst,x,y,z)` → worker: `pw_strict_check` (1) → `pw_transform` → 結果

二段RPCの方が排他制御 (3d) を main 側で書けて単純。

### 3d. レースコンディション対策 (Codex 指摘)

main 側に:
- `inFlightFetches: Map<gridName, Promise<bytes>>` — 同一 grid の二重 fetch 抑止
- `transformQueue` — 1本シリアル化。次 transform は前の `prepare→addGrids→transform` が終わってから (簡易実装、将来 grid set が disjoint なら並列化可能)
- transform 中の `dataVersion` ミスマッチ検出 (server 再起動で version 変わったら全リセット)

### 3e. error型 (`src/proj-api.js`)

```ts
export class MissingGridError extends Error {
  reason: 'missing_grid' | 'ballpark_only' | 'fetch_failed' | 'hash_mismatch' | 'version_mismatch';
  missingGrids?: { shortName: string; fullName: string; url: string }[];
  cause?: unknown;
}
```

### 3f. runtime 入口 (`src/proj-runtime.js`)

```js
initProjRuntime({
  apiBaseUrl: '/api/proj-data',  // versioned subpath は内部で manifest から決定
  wasmUrl:    '/dist/proj_wasm.wasm',
})
```

`index.html:202-208` 更新。

---

## Phase 4: テスト強化 (Codex 指摘の検証漏れ全埋め)

### 4a. C層単体テスト (Phase 0 の延長)

- `pw_grids_needed("EPSG:31370","EPSG:4326", NaN, NaN)` → `["be_ign_bd72lb72_etrs89lb08.tif"]` を含む
- `pw_grids_needed("EPSG:4267","EPSG:6318", -100, 40)` → 該当NADCON5 grid (米国大陸)、`(-150, 60)` (Alaska) では別 grid
- 多段検証: `pw_grids_needed("EPSG:31370","EPSG:4326", NaN, NaN)` 結果が `concatenated_operation` の全ステップを再帰的に集めていること
- `pw_strict_check` が `pw_grids_needed` 結果と整合すること
- vertical/compound CRS (e.g. `EPSG:6697` 含む) で grid 列挙と実 transform 経路が一致すること

### 4b. PROJ ネイティブ参照との絶対誤差 (Codex 指摘)

Belgium roundtrip だけでは Helmert fallback も小さく見えるので不十分:
- ネイティブ `cs2cs` (or `proj` CLI、または既存 `tests/comparison.html` の reference data) を真値とし
- `pw_transform("EPSG:31370","EPSG:4326", x, y)` の **片道誤差** を < 0.05m で検証
- grid 404 状態で `MissingGridError(reason:'missing_grid')` が throw され、結果が返らないこと

### 4c. e2e (Hono + Playwright in `tests/`)

- 初回ロード Network: manifest + proj.db のみ <10MB
- Belgium 1 点変換 → grid 1 個 fetch、誤差 OK
- 同 grid 二度目 → ネット 0
- `/__dev/grid-404/be_ign_bd72lb72_etrs89lb08.tif` ON 状態 → strict error
- 壊れた bytes 注入 → `hash_mismatch`
- version 切替 (manifest 別) → OPFS 全消去 → 再 DL

### 4d. レース/中断 (Codex 指摘)

- 同 grid を必要とする transform を 5 並列で走らせる → fetch が 1 回しか走らないことを Playwright route で検証
- DL 中に `AbortController.abort()` → `.part` ファイルが残らないこと
- OPFS quota 溢れ (テスト用に小 quota) → 適切な error

### 4e. cache invalidation 単体 (Phase 0 から昇格)

`pw_refresh_after_grid_write` 呼び出し前後で `pw_strict_check` の戻り値が `0→1` に変わることを単体テスト化 (CI で常時検証)。

---

## Phase 5: 旧経路撤去 + ドキュメント

- `package-proj-data.sh` 削除
- 旧 `assets/proj-data.tar.gz` ルート削除
- `src/opfs/proj-data-worker.js` の tar parser 削除
- `_pw_clear_cache` 削除 (Phase 1 で内部化済みなら export からも除去)
- `docs/proj-wasm-build.md` / `agent.md` / `TO_OSS.md` / `CLAUDE.md` (Data flow セクション) 更新
- `docs/proj-cache-invalidation-test.md` (Phase 0 成果物) を `docs/` に維持

---

## Critical files to modify

| 種別 | パス |
|---|---|
| edit | `src/proj_wasm.c` (CRS解決共通化, select_best_op, pw_grids_needed, pw_strict_check, pw_refresh_after_grid_write, pw_transform strict化, error code整理) |
| edit | `scripts/build-proj-wasm.sh:222` (EXPORTED_FUNCTIONS 入替) |
| new | `server/index.ts`, `server/routes/{manifest,proj-db,grids,static,dev-fault}.ts` |
| new | `scripts/build-manifest.mjs` (sha256 + grid_alternatives allow-list) |
| edit | `package.json` (deps: hono, @hono/node-server, tsx; scripts: dev:server, build:manifest) |
| edit | `src/opfs/proj-data-worker.js` (.part 保存, hash 検証, version migration) |
| edit | `src/proj-worker.js` (二段RPC: prepare/addGrids/transform, error code map) |
| edit | `src/proj-runtime.js` (apiBaseUrl, transformQueue, inFlightFetches) |
| edit | `src/proj-api.js` (MissingGridError 詳細化) |
| edit | `index.html:202-208` (URL convention) |
| edit | `examples/comparison.js`, `examples/smoke.html` (新フロー、Belgium/NAD27 多段) |
| edit | `flake.nix` (必要なら node の版固定) |
| new | `docs/proj-cache-invalidation-test.md` (Phase 0 成果) |
| new | `tests/cache-invalidation.test.mjs`, `tests/race-conditions.test.mjs`, `tests/strict-mode.test.mjs` |

---

## Reuse

- `proj_create_operations` / `proj_get_suggested_operation` / `proj_coordoperation_get_grid_used` / `proj_coordoperation_is_instantiable` / `proj_coordoperation_has_ballpark_transformation` (`third_party/proj/src/proj.h`)
- `proj_operation_factory_context_set_*` (spatial_criterion, grid_availability_use, allow_ballpark_transformations)
- `proj.db.grid_alternatives` (allow-list)
- `package-proj-data.sh` の sc-proj-data 場所探索ロジック
- 既存 `proj_get_op` の vertical/compound 処理 (関数として括り出して再利用)
- 既存 `crs_obj_is_north_east` 軸スワップ処理
- 既存 worker RPC パターン (`src/proj-worker.js:69-87`) を二段に拡張
- Hono `serveStatic` (`@hono/node-server/serve-static`)

---

## Verification (手動)

```bash
nix develop
./scripts/build-proj-wasm.sh
node scripts/build-manifest.mjs        # → server/manifest.json
npm run dev:server                     # Hono on :3000
```

ブラウザで `http://localhost:3000`:
1. DevTools Network: 初回 manifest + proj.db のみ <10MB
2. Belgium ケース実行 → `be_ign_bd72lb72_etrs89lb08.tif` 1 個 fetch、誤差 < 0.05m
3. OPFS クリア → 再ロード同挙動
4. `/__dev/grid-404/be_...` ON → strict error
5. 壊れ bytes 注入 → `hash_mismatch`
6. 既存 smoke / comparison test 全 pass
7. Playwright (`tests/run-browser-check.mjs`) + 新規 race / strict / cache テストで全 pass

---

## 決定事項 (確定 v2)

1. `manifest.json` は **build時生成**、version は `proj.db` sha256 先頭 16hex (再現可能)
2. URL は **versioned** (`/api/proj-data/v/<version>/...`) — 固定URL + immutable の事故回避
3. **全体version + grid個別hash** — version変わったら OPFS 全消去
4. **個別 .tif 配信** で再gzipなし (COG 前提)
5. cache invalidation は **Phase 0 で実測** — 結果次第で `pw_refresh_after_grid_write` 内部実装決定 (最悪 `g_ctx` 全再作成)
6. **strict mode 定義**: best non-ballpark op が instantiable でなければ `pw_transform` 失敗 (Helmert/ballpark fallback 完全禁止)
7. Service Worker は Phase 1 範囲外
8. **Hono on Node** — Bun / CF Workers は将来
9. ブランチ名: **`feature/selective-proj-data`**
10. **manifest allow-list** は `proj.db.grid_alternatives` 由来 — 拡張子フィルタ廃止
11. path traversal は **3 重防御** (危険文字拒否 / allow-list 一致 / path.relative 検証)
12. **二段RPC** (prepare → addGrids → transform) で main 側に排他制御を集約
13. hash 検証は **完了後 + `.part` rename** (壊れたファイルが残らない)
14. 検証は **PROJ ネイティブ参照との絶対誤差** (roundtrip だけでは fallback 検出できない)

---

## Phase 順序 (v2)

0. **Phase 0**: PROJ cache invalidation 実測 — `pw_refresh_after_grid_write` の中身を確定 (実装ブロッカー解消)
1. **Phase 1**: C wrapper 抜本改修 (single PR)
2. **Phase 2**: Hono サーバ + versioned URL + manifest (single PR, 旧 tar.gz 並走)
3. **Phase 3**: JS 二段 RPC + lazy fetch + OPFS migration (single PR, 旧 tar.gz fallback 残し)
4. **Phase 4**: テスト強化 (cache invalidation / race / strict / native reference 比較)
5. **Phase 5**: 旧経路撤去 + ドキュメント更新

---

## Codex レビュー反映状況 (チェックリスト)

### v2.1 で追加対応 (Codex 2 周目指摘)
- [x] manifest allow-list を `grid_alternatives` ∪ `grid_transformation.grid_name` ∪ `other_transformation.grid_name` の UNION に拡張 (204 件漏れ防止)
- [x] `proj_get_suggested_operation` の軸順問題: `resolve_crs_pair` が `swap_in/swap_out` を返し、座標を必ず正規化してから渡す

### v2 で対応済み (Codex 1 周目指摘)
- [x] `proj_grid_cache_clear` 単独前提を撤回 — Phase 0 + `pw_refresh_after_grid_write` で吸収
- [x] `g_op` キャッシュ破棄を refresh API に統合
- [x] `pw_strict_check` を IGNORED 列挙の best op 自体に対して実行
- [x] `proj_get_suggested_operation` で座標依存選択
- [x] vertical/compound CRS 経路を共通化 (`resolve_crs_pair`)
- [x] versioned URL で immutable cache 安全に
- [x] CRS の `proj_destroy` / `proj_list_destroy` 所有権を 1c に明記
- [x] `PROJ_SPATIAL_CRITERION_PARTIAL_INTERSECTION` 設定
- [x] ballpark 拒否 (`set_allow_ballpark_transformations(0)` + `has_ballpark_transformation` チェック)
- [x] manifest allow-list は `grid_alternatives` 由来に変更
- [x] OPFS は flat 維持 (`collectOpfsFiles` 矛盾解消)
- [x] worker → main の双方向 RPC 不要化 (二段 RPC で代替)
- [x] レース対策 (`inFlightFetches`, `transformQueue`)
- [x] `.part` 保存 + 完了後 rename
- [x] PROJ ネイティブ参照との絶対誤差検証
- [x] JSON escape を C wrapper 側で実装
- [x] error code 整理 + JS への 1:1 マップ
- [x] path traversal 3 重防御
- [x] version 算出は `generatedAt` を使わない (再現性確保)
