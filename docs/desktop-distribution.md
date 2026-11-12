# 初回配布のサポート表と開発用 artifact

初回の配布候補を以下に絞る。最低 OS は製品受け入れの対象とし、インストール・起動・保存・更新を確認した時点で確定する。

| OS | 最低 OS の候補 | CPU | 初回の配布形式 | 開発用ビルドの runner |
| --- | --- | --- | --- | --- |
| macOS | macOS 15 | Apple Silicon（arm64） | DMG | `macos-15` |
| Windows | Windows 11 | x64 | NSIS セットアップ（.exe） | `ubuntu-24.04`（Wine） |
| Linux | Ubuntu 24.04 LTS | x64 | AppImage | `ubuntu-24.04` |

Windows 用 NSIS は Ubuntu でクロスビルドする。Wine は NSIS のアンインストーラー生成に使い、Windows 11 での製品受け入れは別途行う。Intel Mac、Windows arm64、他の Linux ディストリビューション、Store 版は後続候補とする。

## GitHub Actions の開発用ビルド

`Desktop development artifacts` は対象ファイルが変わる PR と手動実行で動く。Desktop のコミット、`config/plus-renderer.json` の Editor、Editor の `site/source.json` が指定する GUI と VM を使う。固定を更新するときは Editor のリモート `main` と照合し、検証する生成物の `build-info.json` と一致させる。

各 runner で通常のレンダラーと Plus レンダラーをビルドし、インストーラーを生成する。パッケージ内の Plus レンダラーと固定リビジョンを照合し、`build-info.json` の `editorWorkbench` を固定 Editor の lockfile とインストール済みの Workbench と照合した後、次を Actions の artifact にまとめる。

- OS ごとのインストーラーと `SHA256SUMS`
- Desktop・Editor・GUI・VM・Electron、Editor が採用する Workbench（`editorWorkbench`：版・取得元・SHA-512 integrity）と family packages を記録した `build-info.json`
- Desktop の `LICENSE`、family package のライセンスと索引、ソースと固定版を示す `source-info.json`
- 公式素材と Packager の取得元・ハッシュを記録した `library-files.json` と `packager.json`

CI で行うのは生成と内容の検査まで。開発用 artifact では配布用証明書、macOS 公証、GitHub Release、更新通知を使わない。製品版の同梱カタログとそのライセンスは #6、署名と対応環境での受け入れは #9 で管理する。

## Desktop のアイコン

`art/icon.svg` が原本。配色と「＋」のモチーフは [Plus Editor のアイコン](https://github.com/kubohiroya/turbowarp-plus-editor/blob/f029eb307e8c0bb6aa79e89ee060e0e3b0243620/assets/icon.svg)（GPL-3.0-or-later）に由来する。

SVG を変更したときは、electron-builder のアイコンツールで開発用 PNG、macOS の ICNS、Windows の ICO、Linux 用 PNG を更新する。生成には `icons@1.1.0` のツールセットを使用した。

```sh
bash scripts/generate-desktop-icons.sh /path/to/icons-bundle/icon-tool.js
```

アイコンの切り戻しは SVG と生成物を同じコミットから復元し、配布物を再ビルドする。

## 作品ファイルからの起動

- macOS は Plus 専用 Bundle ID と `.sb3`・`.sb2`・`.sb` の編集アプリ登録を使用する。Finder の「このアプリケーションで開く」から、スペースを含むパスの作品を Plus で開く。公式版も選べることを確認する。
- Windows の NSIS は Plus 専用 ProgID を各拡張子の「プログラムから開く」に登録する。公式版を既定にした状態で Plus を導入し、既定を維持したまま Plus を選んで作品を開けることを確認する。Plus をアンインストールすると、Plus の登録だけが消える。
- Linux は `turbowarp-plus-desktop.desktop` の名前と、同名のアプリ識別子およびウィンドウクラスを使用する。AppImage のランチャーで既存の Scratch 作品の MIME 型を使い、公式版と別のアイコンで起動できることを確認する。

配布設定を切り戻す場合は対象の差分を revert して再ビルドする。Windows の関連付けは Plus のアンインストーラーから解除する。既定のエディターは OS の設定で選び直せる。

## 再現手順と切り戻し

表の runner に対応する OS／CPU で Desktop、固定 Editor、固定 Scratch GUI を並べて checkout する。Editor の `.nvmrc` の Node.js を使い、各 checkout で `npm ci`、GUI で `node scripts/prepublish.mjs` を実行する。macOS arm64 では Desktop から次を実行する。

```sh
npm run fetch
npm run webpack:prod
npm run webpack:plus -- ../editor ../scratch-gui
node scripts/package-development.mjs dmg arm64 ../editor/site/source.json
```

Ubuntu x64 では最後の行の引数を `AppImage x64` にすると Linux 向けになる。Windows 向けは workflow と同じ Wine（64・32 ビット）と Xvfb を用意し、次のコマンドでパッケージ化する。

```sh
xvfb-run -a node scripts/package-development.mjs nsis x64 ../editor/site/source.json
```

成果物は `dist/development-artifact/` に出る。切り戻す場合は workflow とビルド設定の変更を revert し、対象の開発用 artifact を配布対象から外す。
