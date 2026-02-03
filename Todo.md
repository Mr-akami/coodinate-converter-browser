# TODO
1. `proj` のビルド方式を決定（Emscripten で確定）。
2. `proj-data` の配布形式を決定（tar.zst / zip / 圧縮済み JSON など）。
3. `proj` を git submodule として追加（`third_party/proj`）。
4. `proj` Wasm ビルド用のスクリプトを作成。
5. Nix 開発環境（`flake.nix`）を用意。
3. OPFS への展開フローを PoC（Worker + WasmFS）。
4. `proj` のデータ検索パスを OPFS に向ける方法を検証。
5. `proj` C API を最小ラップした JS API を作成。
6. ブラウザ起動時の「初回セットアップ」UX を設計。
7. 2回目以降の高速起動パスを実装（展開済み判定）。
8. 主要な座標変換ケースで検証テストを作成。
