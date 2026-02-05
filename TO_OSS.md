# OSS化チェックリスト

## 1. proj-data バンドルツール

ユーザーが自分でproj-dataを固める必要がある。

### 理由
- 全データ ~700MB（npm不可）
- 地域ごとに必要gridが異なる
- 一部gridはライセンス制限あり

### 実装: `scripts/bundle-proj-data.sh`

```bash
#!/bin/bash
# Usage: ./bundle-proj-data.sh [profile]
# Profiles: minimal, japan, us, europe, full

PROFILE=${1:-minimal}
PROJ_DATA_SRC="./third_party/proj-data"
OUT_DIR="./assets"

case $PROFILE in
  minimal)
    # proj.db のみ（基本変換）
    FILES="proj.db"
    ;;
  japan)
    # 日本向け: JGD2000/2011, GSIGEO2011, 平面直角
    FILES="proj.db jp_gsi_*"
    ;;
  us)
    # 米国向け: NAD27/83, GEOID models
    FILES="proj.db us_noaa_* us_nga_*"
    ;;
  europe)
    # 欧州向け: ETRS89, 各国datum
    FILES="proj.db eu_* uk_* de_* fr_* nl_* be_* ch_*"
    ;;
  full)
    # 全データ（警告: ~700MB）
    FILES="*"
    ;;
esac

tar -czvf "$OUT_DIR/proj-data.tar.gz" -C "$PROJ_DATA_SRC" $FILES
```

### ドキュメント化必須
- 各profileに含まれるファイル一覧
- カスタムbundle作成方法
- ライセンス情報（grid別）

---

## 2. NPM Package 整備

### package.json

```json
{
  "name": "@anthropic/proj-wasm",
  "version": "0.1.0",
  "description": "PROJ coordinate transformation library compiled to WebAssembly",
  "type": "module",
  "main": "dist/proj-runtime.js",
  "module": "dist/proj-runtime.js",
  "types": "dist/types/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/proj-runtime.js",
      "types": "./dist/types/index.d.ts"
    },
    "./worker": "./dist/proj-worker.js",
    "./wasm": "./dist/proj_wasm.wasm"
  },
  "files": [
    "dist/",
    "scripts/bundle-proj-data.sh",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "./scripts/build-proj-wasm.sh",
    "bundle-data": "./scripts/bundle-proj-data.sh"
  },
  "keywords": ["proj", "coordinate", "transformation", "wasm", "gis"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/anthropics/proj-wasm"
  },
  "engines": {
    "node": ">=18"
  }
}
```

### TypeScript型定義

```typescript
// dist/types/index.d.ts
export interface ProjResult {
  x: number;
  y: number;
  z: number;
}

export interface ProjApi {
  transform(src: string, dst: string, x: number, y: number, z?: number): Promise<ProjResult>;
}

export interface InitOptions {
  dataUrl: string;
  dataVersion: string;
  dataDirName?: string;
  wasmUrl?: string;
}

export function initProjRuntime(options: InitOptions): Promise<{ worker: Worker }>;
export function createProjApi(worker: Worker): ProjApi;
```

---

## 3. ディレクトリ構成（公開後）

```
proj-wasm/
├── dist/
│   ├── proj_wasm.js
│   ├── proj_wasm.wasm
│   ├── proj-runtime.js
│   ├── proj-api.js
│   ├── proj-worker.js
│   └── types/
│       └── index.d.ts
├── scripts/
│   ├── build-proj-wasm.sh
│   └── bundle-proj-data.sh
├── docs/
│   ├── getting-started.md
│   ├── bundle-proj-data.md
│   └── api-reference.md
├── examples/
│   └── basic-usage.html
├── package.json
├── README.md
├── LICENSE
└── CHANGELOG.md
```

---

## 4. ライセンス整理

| コンポーネント | ライセンス | 対応 |
|---------------|-----------|------|
| PROJ本体 | MIT | OK |
| proj.db | CC-BY-4.0 | 帰属表示必要 |
| GSIGEO2011 | 国土地理院利用規約 | 出典明記 |
| EGM96/2008 | Public Domain | OK |
| NAD grids | Public Domain | OK |
| 欧州各国grid | 各種 | 要確認 |

### LICENSE ファイル

```
MIT License (proj-wasm wrapper code)

This software uses PROJ (https://proj.org/) - MIT License

Grid data licenses vary by region. See docs/grid-licenses.md for details.
```

---

## 5. CI/CD (GitHub Actions)

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: cachix/install-nix-action@v24
      - run: nix develop --command ./scripts/build-proj-wasm.sh
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## 6. ドキュメント

### README.md 構成

1. What is this
2. Quick Start
3. Bundle proj-data (重要)
4. API Reference
5. Browser Support
6. License

### 必須セクション: proj-data

```markdown
## Bundling proj-data

This library requires proj-data for coordinate transformations.
Due to size (~700MB full), you must create your own bundle.

### Quick Start (Japan)
\`\`\`bash
./scripts/bundle-proj-data.sh japan
# Creates assets/proj-data.tar.gz (~50MB)
\`\`\`

### Available Profiles
| Profile | Size | Contents |
|---------|------|----------|
| minimal | ~5MB | proj.db only (basic transforms) |
| japan | ~50MB | JGD2000/2011, GSIGEO2011 |
| us | ~100MB | NAD27/83, GEOID models |
| europe | ~150MB | ETRS89, country datums |
| full | ~700MB | Everything |
\`\`\`
```

---

## 7. 実装優先順位

- [ ] `scripts/bundle-proj-data.sh` 実装
- [ ] TypeScript型定義作成
- [ ] package.json整備
- [ ] README.md作成
- [ ] LICENSE整理
- [ ] GitHub Actions設定
- [ ] npm publish (dry-run)
- [ ] npm publish (本番)

---

## 8. 未解決事項

- パッケージ名: `@anthropic/proj-wasm` or `proj-wasm` or 他?
- WASM配布方法: npm含める vs CDN vs ユーザービルド?
- proj.dbのバージョニング: PROJ本体と同期?
- ブラウザ以外(Node.js)サポート?
