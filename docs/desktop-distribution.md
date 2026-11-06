# 初回配布のサポート表と開発用 artifact

初回の配布候補を以下に絞る。最低 OS は製品受け入れの対象とし、インストール・起動・保存・更新を確認した時点で確定する。

| OS | 最低 OS の候補 | CPU | 初回の配布形式 | 開発用ビルドの runner |
| --- | --- | --- | --- | --- |
| macOS | macOS 15 | Apple Silicon（arm64） | DMG | `macos-15` |
| Windows | Windows 11 | x64 | NSIS セットアップ（.exe） | `windows-2025` |
| Linux | Ubuntu 24.04 LTS | x64 | AppImage | `ubuntu-24.04` |

Windows のビルド runner は Windows Server。Windows 11 での受け入れは別途行う。Intel Mac、Windows arm64、他の Linux ディストリビューション、Store 版は後続候補とする。

## GitHub Actions の開発用ビルド

`Desktop development artifacts` は対象ファイルが変わる PR と手動実行で動く。Desktop のコミット、`config/plus-renderer.json` の Editor、Editor の `site/source.json` が指定する GUI と VM を使う。固定を更新するときは Editor のリモート `main` と照合し、検証する生成物の `build-info.json` と一致させる。

各 runner で通常のレンダラーと Plus レンダラーをビルドし、インストーラーを生成する。パッケージ内の Plus レンダラーと固定リビジョンを照合した後、次を Actions の artifact にまとめる。

- OS ごとのインストーラーと `SHA256SUMS`
- Desktop・Editor・GUI・VM・Electron と family packages を記録した `build-info.json`
- Desktop の `LICENSE`、family package のライセンスと索引、ソースと固定版を示す `source-info.json`
- 公式素材と Packager の取得元・ハッシュを記録した `library-files.json` と `packager.json`

CI で行うのは生成と内容の検査まで。開発用 artifact では配布用証明書、macOS 公証、GitHub Release、更新通知を使わない。製品版の同梱カタログとそのライセンスは #6、署名と対応環境での受け入れは #9 で管理する。

## 再現手順と切り戻し

対象 OS／CPU のホストで Desktop、固定 Editor、固定 Scratch GUI を並べて checkout する。Editor の `.nvmrc` の Node.js を使い、各 checkout で `npm ci`、GUI で `node scripts/prepublish.mjs` を実行する。Desktop から次を実行する。末尾の引数は表に合わせて `nsis x64` または `AppImage x64` に置き換える。

```sh
npm run fetch
npm run webpack:prod
npm run webpack:plus -- ../editor ../scratch-gui
node scripts/package-development.mjs dmg arm64 ../editor/site/source.json
```

成果物は `dist/development-artifact/` に出る。切り戻す場合は workflow とビルド設定の変更を revert し、対象の開発用 artifact を配布対象から外す。
