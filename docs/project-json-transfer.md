# D4 Desktop の作品間転送

[Layout Issue #1](https://github.com/kubohiroya/turbowarp-plus-editor-layout/issues/1) の D4。D3 の作品ごとのプロセスで、起動時に `TW_PLUS_DESKTOP_PROJECT_ISOLATION=1` と `TW_PLUS_DESKTOP_JSON_TRANSFER=1` を指定する。切り戻すときは作品を保存して Desktop の全プロセスを終了し、`TW_PLUS_DESKTOP_JSON_TRANSFER=0` で再起動する。

- ブロックは選択してコピーし、別作品のコード領域で貼り付ける。ドラッグするときはスクリプトを選択し、「選択したスクリプトをドラッグ」から別作品のコード領域へドロップする。受信側では既存のスクリプトインポートが対象スプライトへの取り込みを処理する。
- YAML は転送元の作品内文書を開き、「YAML をコピー／ドラッグ」を使う。転送先の作品内文書で「YAML を貼り付け」を選ぶか、プレビューにドロップする。転送先の提供元が検証し、既存の保存操作で草稿を確定する。
- クリップボードには種類別の JSON と通常のテキストを入れる。カスタム形式の利用時には Desktop の既存のクリップボード許可が表示される場合がある。ドラッグには種類別の JSON と、OS がカスタム形式を渡さない場合に備えたテキスト形式の JSON を入れる。コスチュームや音のバイナリ転送は D5 で扱う。

## macOS での検証

D4 を組み込んだ Editor の [Desktop 用ビルド手順](https://github.com/kubohiroya/turbowarp-plus-editor/tree/main/scripts/desktop) でレンダラーを用意する。Editor の `scripts/yaml-editor/build-settings-fixture.ts` に試験用 SB3 と出力先を渡し、YAML 提供元入りの試験用 SB3 を生成する。

```sh
work=$(mktemp -d)
python3 test/prepare-project-process-app.py /Applications/TurboWarp.app "$work/TurboWarp Plus D4.app" \
  --renderer /absolute/path/to/desktop-renderer
TW_D4_TEST_APP="$work/TurboWarp Plus D4.app" \
  TW_D4_TEST_SB3=/absolute/path/to/settings.sb3 \
  TW_D4_PLAYWRIGHT=/absolute/path/to/editor/node_modules/playwright \
  npm run test:macos:project-transfer
```

`TW_D4_TEST_ENABLED=0` を追加すると、切り戻し時の操作の非表示と既存の YAML 文書表示を検証する。

クリップボードの検証は macOS のシステムクリップボードを使用する。ドラッグの検証では Chromium DevTools Protocol で転送元のデータを取得し、別の Electron プロセスのドロップ先に渡す。OS のポインター操作を伴うウィンドウ間ドラッグは別途検証する。
