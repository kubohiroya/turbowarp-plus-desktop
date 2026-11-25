# ローカル拡張の開発と自動更新

1. `turbowarp-extension-template` の開発フォルダで `pnpm run build` を実行します。
2. Plus Desktop の情報メニューで「拡張の開発フォルダを開く…」を選び、`dist` を含む開発フォルダを指定します。確認画面で拡張ID、フォルダ、サンドボックスでの自動更新を確認します。
3. TypeScript を修正して再ビルドします。`pnpm run dev` による外部の監視ビルドも利用できます。Desktop は `dist/extension-development.json` が示す JavaScript とブロック定義の SHA-256 を照合し、互換な完成ビルドを作品へ反映します。
4. テスト実行ビューで同じ Scratch テストを再実行します。監視は「拡張の自動更新を停止」で止められます。

ビルド中に成果物が一時的に欠けたり一致しなかったりする間は、最後に読み込んだ版で動作します。ブロック定義の変更や開発フォルダの差し替えを検知すると監視を停止します。更新では作品を再構築するため、動作中のスクリプトは終了します。開発フォルダのパスや監視の承認は作品に保存しません。

## ヘッドレス検証

`npm run webpack:plus -- <Editorの固定チェックアウト> <GUIの固定チェックアウト>` で Desktop 用レンダラーを作ります。開発ビルドの差し替えに対応した Loader と、別窓のテスト実行に対応したテスト実行パッケージを使います。

```sh
node --test test/local-extension-development.test.js
TW_PLUS_EDITOR_SOURCE=/absolute/path/to/editor \
TW_PLUS_EXTENSION_TEMPLATE_ROOT=/absolute/path/to/extension-template \
TW_PLUS_TEST_EXTENSION_JS=/absolute/path/to/turbowarp-test.js \
node --test test/local-extension-development.browser.js
```

ブラウザーテストは Desktop 用レンダラー、専用テストVM、Desktop のIPCハンドラーを使います。フォルダ選択と確認はテストの入力で与えます。テスト用拡張には `turbowarp-test` の `fc707c50a56b970db20c80081d0be9384517d120` にある `dist/turbowarp-test.js` を使います。
