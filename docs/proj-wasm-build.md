# PROJ Wasm ビルド方針（Emscripten）

## 目的
ブラウザ（Chrome）上で PROJ の座標変換を完結させる。`proj-data` は OPFS に展開し、Wasm から参照する。

## 方針
- Wasm ビルドは Emscripten を採用。
- CLI は不要なのでライブラリ中心の構成にする。
- `proj.db` を含む `proj-data` を OPFS にキャッシュし、起動時に MEMFS へコピーして Wasm から参照する。

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

## ビルド手順
```sh
./scripts/build-proj-wasm.sh
```
デフォルトで SQLite/zlib/libtiff を Wasm 用にビルドし、PROJ をリンク。
必要に応じて `WITH_TIFF=0` で TIFF を無効化できます。

## ラッパー設計
C API は PROJ 本体との名前衝突を避けるため `pw_` プレフィックスを使用。

- `pw_init(data_dir)` で検索パスと DB パスを設定。
- `pw_transform(src, dst, x, y, z)` で座標変換。
- `pw_clear_cache()` / `pw_cleanup()` でキャッシュとコンテキストを破棄。

## データフロー: OPFS キャッシュ + MEMFS

```
初回:  fetch(tar.gz) → Worker で OPFS に展開 → OPFS から MEMFS にコピー → pw_init
2回目: OPFS キャッシュ済み（スキップ）   → OPFS から MEMFS にコピー → pw_init
```

Worker が OPFS に書いたファイルをメインスレッドで読み出し、`Module.FS.writeFile()` で MEMFS に書き込む。

```js
import { initProjRuntime } from './proj-runtime.js';

const { Module } = await initProjRuntime({
  dataUrl: '/assets/proj-data.tar.gz',
  dataVersion: '2025-02-01',
  dataDirName: 'proj-data',
  wasmUrl: '/dist/proj_wasm.wasm',
});
```

## proj-data パッケージ化
```sh
# nix develop 内では PROJ_LIB が自動設定される
./scripts/package-proj-data.sh

# 明示指定
PROJ_DATA_DIR=/path/to/proj-data ./scripts/package-proj-data.sh
```

出力: `assets/proj-data.tar.gz`

## スモークテスト
```sh
python -m http.server 8765
# http://localhost:8765/examples/smoke.html
```

## 過去のハマりポイント

### 1. `proj_cleanup` シンボル衝突
`proj_cleanup` は PROJ 本体（`malloc.cpp.o`）に定義済み。ラッパーで同名関数を定義するとリンク時に `duplicate symbol` エラーになる。
→ ラッパー関数を `pw_` プレフィックスにリネームして解決。

### 2. `_malloc` / `_free` 未エクスポート
Emscripten の `EXPORTED_FUNCTIONS` に `_malloc` / `_free` を含めないと `Module._malloc` が `undefined` になる。`proj-api.js` が HEAPF64 経由で座標バッファを渡すために必要。

### 3. WasmFS OPFS バックエンドと File System Access API の非互換
WasmFS の OPFS バックエンドは独自のストレージ形式を使う。Worker が File System Access API (`getDirectoryHandle` / `getFileHandle`) で OPFS に書いたファイルは、WasmFS OPFS マウント経由では読めない。`FS.mount(Module.OPFS, {}, '/opfs')` は `unreachable` WASM trap を引き起こす。
→ OPFS はキャッシュ層として維持し、Wasm には MEMFS 経由でデータを渡す方式に変更。OPFS から File System Access API でファイルを読み出し、`Module.FS.writeFile()` で MEMFS に書き込む。

## 注意点
- `sqlite3` がビルドに必要。CMake 構成で不足する場合は、PROJ 側の SQLite ビルド設定を有効化する。
- `proj-data` のサイズが大きいため、OPFS 展開は Worker で実行し、初回のみ行う。
- `flake.nix` の `proj` パッケージで `PROJ_LIB` が自動設定される（`proj-data` は nixpkgs に存在しない）。
