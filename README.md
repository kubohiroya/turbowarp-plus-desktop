# TurboWarp Plus Desktop

TurboWarp Plus Editor のデスクトップ版です。公式 [TurboWarp Desktop 1.17.1](https://github.com/TurboWarp/desktop/tree/6e7bc5934f27cd658d17bf8742db4357ae057657) を基点にしています。ライセンスは [GPL-3.0](LICENSE) です。上流には [LLK/scratch-desktop](https://github.com/LLK/scratch-desktop) に由来するコードも含まれます。

開発状況は [親 Issue](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/1)、不具合は [このリポジトリの Issues](https://github.com/kubohiroya/turbowarp-plus-desktop/issues) を参照してください。製品向け配布と署名は [Desktop #9](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/9) で扱います。

## macOS での開発起動

Git、Node.js 24、npm を用意します。`npm ci` は `package-lock.json` に従って依存を導入します。Electron の実行ファイルは初回起動時に取得します。依存・追加資産の取得と初回起動にはネットワーク接続が必要です。

```sh
git clone https://github.com/kubohiroya/turbowarp-plus-desktop.git
cd turbowarp-plus-desktop
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run fetch
npm run webpack:compile
npm run electron:start
```

この手順では標準 renderer と Desktop のアドオン設定画面をビルドします。公式アプリのローカルコピーを使う D3〜D6 の検証手順は [作品分離と排他](docs/project-process-lock.md) を参照してください。

- `npm run fetch` は素材ライブラリ、Packager、拡張の資産を準備します。
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` は開発起動に不要なテスト用 Chromium の取得を省きます。
- `npm run webpack:watch` は renderer の開発ビルドを更新します。main や preload の変更を反映するにはアプリを再起動します。
- `docs/screenshots` は上流の文書用サブモジュールです。スクリーンショットが必要な場合は `git submodule update --init docs/screenshots` で取得します。

## ローカル CI と macOS 実機テスト

依存を導入した後、通常のローカル CI は `npm test` で実行します。作品ロック、素材転送、外部 YAML、標準 renderer の上書き保護、レイアウト保存を Node.js で検証します。実機テスト用の環境変数が残っていても、このコマンドから Electron が起動することはありません。

Electron のウィンドウや macOS のクリップボードを使う検証は、対象を選んで実行します。各手順で指定するテスト用アプリと SB3 を先に用意してください。

| コマンド | 検証手順 |
| --- | --- |
| `npm run test:macos:project-process` | [作品分離と排他](docs/project-process-lock.md) |
| `npm run test:macos:project-transfer` | [作品間転送](docs/project-json-transfer.md) |
| `npm run test:macos:workspace-layout` | [作品ごとのレイアウト復元](docs/desktop-workspace-layout.md) |

## Plus Editor renderer の組み込み

`config/plus-renderer.json` の Editor コミットと、その `site/source.json` の GUI コミットを別々のクリーンな checkout に用意します。固定した Editor の `.nvmrc` の Node.js 版で両方に `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci` を実行し、GUI 側で `node scripts/prepublish.mjs` を実行します。

Desktop の作業ツリーから次を実行します。

```sh
npm run webpack:plus -- /absolute/path/to/editor /absolute/path/to/scratch-gui
profile_dir=$(mktemp -d)
TW_PLUS_DESKTOP_DATA_DIR="$profile_dir" TW_PLUS_DESKTOP_RENDERER=1 npm run electron:start
```

ビルドは Editor の Desktop 用 webpack 設定と GUI の既存接続口を使います。Plus renderer とそのアドオン設定画面は同じ固定 GUI からビルドします。成果物の `dist-renderer-webpack/editor/plus-gui/build-info.json` に Desktop・Electron・Editor・GUI・VM の採用版を記録し、同梱パッケージとライセンスの索引を添えます。

起動時にフラグを外すと標準 renderer に切り替わります。標準 renderer では、Plus 作品や内容を判定できない既存ファイルへの上書きが拒否されます。別名で新規保存するか、Plus renderer で作品を開き直してください。

## 開発プロファイル

macOS の既定の保存先は `~/Library/Application Support/TurboWarp Plus Desktop` です。個別の検証では `TW_PLUS_DESKTOP_DATA_DIR` に新しいディレクトリを指定できます。

```sh
profile_dir=$(mktemp -d)
TW_PLUS_DESKTOP_DATA_DIR="$profile_dir" npm run electron:start
```

作品分離を試す場合は同じ起動コマンドに `TW_PLUS_DESKTOP_PROJECT_ISOLATION=1` を加えます。検証終了後にプロファイルを整理する場合は、全ウィンドウと起動係を閉じ、検証用として作成したディレクトリを確認してください。

## 上流への追従

[公式 TurboWarp Desktop](https://github.com/TurboWarp/desktop) の採用コミットを記録し、更新時は `package-lock.json`、同梱資産の取得元と整合性、ライセンスを確認します。Desktop の起動、プロファイル分離、作品の読み込みと保存を採用版で再確認します。
