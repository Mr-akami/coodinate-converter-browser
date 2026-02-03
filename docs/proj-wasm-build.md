# PROJ Wasm ビルド方針（Emscripten）

## 目的
ブラウザ（Chrome）上で PROJ の座標変換を完結させる。`proj-data` は OPFS に展開し、Wasm から参照する。

## 方針
- Wasm ビルドは Emscripten を採用。
- CLI は不要なのでライブラリ中心の構成にする。
- `proj.db` を含む `proj-data` を OPFS に配置し、Wasm から検索パスを設定する。

## 前提
- `emsdk`（Emscripten）、`cmake`、`ninja` などが利用可能。
- PROJ のソースは `third_party/proj/` に git submodule で配置。

## Nix 開発環境
```sh
nix develop
```
上記で `emcc` / `emcmake` / `cmake` / `ninja` / `sqlite3` / `curl` などが揃う想定。

## サブモジュール追加（初回のみ）
```sh
git submodule add https://github.com/OSGeo/PROJ.git third_party/proj
git submodule update --init --recursive
```

## ビルド手順（案）
1. CMake で静的ライブラリをビルド

```sh
./scripts/build-proj-wasm.sh
```
デフォルトで SQLite/zlib/libtiff を Wasm 用にビルドし、PROJ をリンク。
必要に応じて `WITH_TIFF=0` で TIFF を無効化できます。

## ラッパー設計（例）
- `proj_init(data_dir)` で検索パスと DB パスを設定。
- `proj_transform(src, dst, x, y, z)` のような最小 API を提供。
- `proj_clear_cache()` / `proj_cleanup()` でキャッシュとコンテキストを破棄可能。

```c
// src/proj_wasm.c
#include <proj.h>

static PJ_CONTEXT* ctx = NULL;

int proj_init(const char* data_dir) {
  if (ctx) return 0;
  ctx = proj_context_create();
  proj_context_set_search_paths(ctx, 1, &data_dir);

  char db_path[1024];
  snprintf(db_path, sizeof(db_path), "%s/proj.db", data_dir);
  proj_context_set_database_path(ctx, db_path, NULL, NULL);
  return 0;
}
```

## OPFS マウント（例）
```js
await Module.FS.mkdir('/opfs');
const backend = await Module.ccall(
  'wasmfs_create_opfs_backend',
  'number',
  [],
  [],
  { async: true }
);
await Module.ccall(
  'wasmfs_mount',
  'number',
  ['string', 'number'],
  ['/opfs', backend],
  { async: true }
);
// proj-data を /opfs/proj に展開した想定
Module.ccall('pw_init', 'number', ['string'], ['/opfs/proj']);
```

## proj-data 展開（Worker）
`proj-data` は `.tar.gz` を前提にし、Worker で OPFS に展開する。

```js
import { ensureProjData } from './opfs/proj-data.js';

await ensureProjData({
  url: '/assets/proj-data.tar.gz',
  version: '2025-02-01',
  dirName: 'proj-data',
  onProgress: (p) => console.log(p),
});
```

## OPFS + Wasm 結線（サンプル）
```js
import { initProjRuntime } from './proj-runtime.js';

const { Module } = await initProjRuntime({
  dataUrl: '/assets/proj-data.tar.gz',
  dataVersion: '2025-02-01',
  dataDirName: 'proj-data',
  wasmUrl: '/assets/proj_wasm.wasm',
});
```

OPFS を WasmFS から利用するため、Wasm ビルド時に `-sASYNCIFY=1` と `-lopfs.js` が必要。
`_wasmfs_create_opfs_backend` / `_wasmfs_mount` を `EXPORTED_FUNCTIONS` に含める。
もし `_wasmfs_create_opfs_backend` が `undefined` でも `Module.OPFS` が存在する場合は、
`FS.mount(Module.OPFS, {}, '/opfs')` でマウントできるビルド構成がある。

## スモークテスト
`examples/smoke.html` を用意しているので、ローカルサーバで確認できる。

```sh
python -m http.server 5173
```

ブラウザで `http://localhost:5173/examples/smoke.html` を開いてログを確認。

デバッグ用に `__projModule` が `window` に入る。必要なら以下を確認:
```js
typeof __projModule._wasmfs_create_opfs_backend
typeof __projModule._wasmfs_mount
```

`_wasmfs_create_opfs_backend` が `undefined` のままなら、ブラウザが古い `proj_wasm.js` をキャッシュしている可能性がある。
その場合は `initProjRuntime` に `moduleUrl` を渡してキャッシュを回避する。

```js
await initProjRuntime({
  // ...
  moduleUrl: `/dist/proj_wasm.js?v=${Date.now()}`,
});
```

## proj-data パッケージ化
`proj-data` ディレクトリ（`proj.db` があるルート）から `.tar.gz` を作成する。

```sh
PROJ_DATA_DIR=/path/to/proj-data ./scripts/package-proj-data.sh
```

Nix 環境では `PROJ_LIB` が設定されている場合があり、その場合は自動検出される。
明示する場合は `PROJ_DATA_DIR` を指定する。

`flake.nix` で `proj-data` を入れているので、`nix develop` 後は `PROJ_LIB` が自動設定される。

## 注意点
- `sqlite3` がビルドに必要。CMake 構成で不足する場合は、PROJ 側の SQLite ビルド設定を有効化する。
- `proj-data` のサイズが大きいため、OPFS 展開は Worker で実行し、初回のみ行う。

## 残タスク
- PROJ の CMake オプションを精査し、必要機能とサイズのバランスを確認。
- `proj-data` の配布形式（tar.zst / zip）決定。
