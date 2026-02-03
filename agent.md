# 目的
ブラウザだけで座標変換を完結させる。`proj-data` と `proj` をブラウザ上で動かす。

# 前提と方針
- ネットワークに依存せず、初回ロード後はローカル（ブラウザ内）で完結。
- `proj-data` は OPFS に配置し、`proj` は Wasm ビルドで利用する。
- 可能な限り既存のビルド成果物を流用し、最小限のパッチで統合する。
- `proj` は `third_party/proj` を git submodule で管理する。
- 対象ブラウザは Chrome。スレッド対応は後回し。
- Wasm ビルドは Emscripten を採用（WASI より統合コストが低い）。
- 開発環境は Nix で構築する。

# 想定アーキテクチャ
1. **初回起動時に `proj-data` を OPFS に展開**
   - アプリ起動時に `proj-data` のアーカイブ（例: `proj-data.tar.zst`）を取得。
   - Web Worker 内で解凍し、OPFS に書き込む。
   - 展開済み判定のためにバージョンファイルを OPFS に保存。

2. **`proj` を Wasm 化してブラウザで使用**
   - `proj` を Emscripten で Wasm ビルド。
   - `proj` のデータディレクトリ参照を OPFS に向ける。
   - `PROJ_DATA` もしくは `proj` の検索パス設定を JS から注入。

3. **JS から `proj` API を呼び出す**
   - `proj` CLI ではなく、C API をラップした WASM 関数をエクスポート。
   - シンプルな `transform()` などの API を提供。

# 技術検討ポイント
- OPFS への書き込みはユーザー許可が必要なケースがあるため、初回セットアップの UX を用意。
- OPFS は Worker からのアクセスが安定。`proj-data` の展開は Worker で実行。
- Wasm でのファイル I/O は MEMFS ではなく OPFS + WasmFS を使う。
- 代替案として `proj-data` を最小サブセット化し、ビルド時にバンドルする手法も検討。

# 期待成果
- ブラウザのみで `proj` による座標変換が動作するプロトタイプ。
- 2回目以降は OPFS から即時利用し、ネットワークアクセス不要。
