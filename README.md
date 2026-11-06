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

この手順は Desktop 本体の開発起動です。Plus Editor の固定 renderer を製品ホストへ統合する作業は [Desktop #3](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/3) で扱います。公式アプリのローカルコピーを使う D3〜D6 の検証手順は [作品分離と排他](docs/project-process-lock.md) を参照してください。

- `npm run fetch` は素材ライブラリ、Packager、拡張の資産を準備します。
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` は開発起動に不要なテスト用 Chromium の取得を省きます。
- `npm run webpack:watch` は renderer の開発ビルドを更新します。main や preload の変更を反映するにはアプリを再起動します。
- `docs/screenshots` は上流の文書用サブモジュールです。スクリーンショットが必要な場合は `git submodule update --init docs/screenshots` で取得します。

## 開発プロファイル

macOS の既定の保存先は `~/Library/Application Support/TurboWarp Plus Desktop` です。個別の検証では `TW_PLUS_DESKTOP_DATA_DIR` に新しいディレクトリを指定できます。

```sh
profile_dir=$(mktemp -d)
TW_PLUS_DESKTOP_DATA_DIR="$profile_dir" npm run electron:start
```

作品分離を試す場合は同じ起動コマンドに `TW_PLUS_DESKTOP_PROJECT_ISOLATION=1` を加えます。検証終了後にプロファイルを整理する場合は、全ウィンドウと起動係を閉じ、検証用として作成したディレクトリを確認してください。

## 上流への追従

[公式 TurboWarp Desktop](https://github.com/TurboWarp/desktop) の採用コミットを記録し、更新時は `package-lock.json`、同梱資産の取得元と整合性、ライセンスを確認します。Desktop の起動、プロファイル分離、作品の読み込みと保存を採用版で再確認します。
