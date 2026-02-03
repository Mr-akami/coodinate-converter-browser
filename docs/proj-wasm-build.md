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
上記で `emcc` / `emcmake` / `cmake` / `ninja` などが揃う想定。

## サブモジュール追加（初回のみ）
```sh
git submodule add https://github.com/OSGeo/PROJ.git third_party/proj
git submodule update --init --recursive
```

## ビルド手順（案）
1. CMake で静的ライブラリをビルド

```sh
emcmake cmake -S third_party/proj -B build/proj-wasm \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTING=OFF

cmake --build build/proj-wasm -j
```

2. ラッパーを含めて Wasm 化（例）

```sh
emcc src/proj_wasm.c build/proj-wasm/src/libproj.a \
  -O3 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker \
  -sWASMFS=1 \
  -sFILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_proj_init,_proj_transform,_proj_clear_cache,_proj_cleanup \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS \
  -o dist/proj_wasm.js
```

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
await Module.FS.mount(Module.FS.filesystems.OPFS, {}, '/opfs');
// proj-data を /opfs/proj に展開した想定
Module.ccall('proj_init', 'number', ['string'], ['/opfs/proj']);
```

## 注意点
- `sqlite3` がビルドに必要。CMake 構成で不足する場合は、PROJ 側の SQLite ビルド設定を有効化する。
- `proj-data` のサイズが大きいため、OPFS 展開は Worker で実行し、初回のみ行う。

## 残タスク
- PROJ の CMake オプションを精査し、必要機能とサイズのバランスを確認。
- `proj-data` の配布形式（tar.zst / zip）決定。
