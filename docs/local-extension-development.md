# 拡張ブロックの開発フォルダと自動更新

1. `turbowarp-extension-template` の開発フォルダで `pnpm run build` を実行します。
2. Plus Desktop の撮影機アイコンの右にある歯車から「拡張ブロックの開発フォルダ…」を選びます。「開発フォルダを追加…」で `dist` を含むフォルダを選び、確認画面で拡張ブロック ID、フォルダ、サンドボックスでの自動更新を確認します。
3. TypeScript を修正して再ビルドします。`pnpm run dev` での監視ビルドも利用できます。Desktop は `dist/extension-development.json` が示す JavaScript とブロック定義の SHA-256 を照合し、互換な完成ビルドを作品へ反映します。
4. 同じダイアログの一覧で、名前、ID、開発フォルダを確認できます。異なる ID のフォルダを同じ作品に追加でき、チェックボックスでフォルダごとに自動更新を止めたり再開したりできます。テスト実行ビューから同じ Scratch テストを再実行できます。

一覧には適用中のビルドをハッシュで表示します。チェックを外している間やビルドの途中は、最後に読み込んだ版で動作します。成果物の整合性を続けて確認できない場合は、一覧に完成ビルドを待っていることを表示します。外部ビルドが正常な成果物に触れず終了した場合、エラーの詳細はビルドを実行した端末で確認できます。再開時は開発フォルダとブロック定義をもう一度照合します。「一覧から外す」はフォルダとの紐づけを解除し、作品に追加済みのブロックは利用できます。更新では作品を再構築するため、動作中のスクリプトは終了します。開発フォルダのパスや監視の承認は作品に保存しません。

Template v0.13.0 以降の `pnpm dev` で作った拡張を作品から実行して例外が起きると、一覧に元の TypeScript ファイルと行・列が表示されます。Desktop は実行中のビルドに対応するソースマップを照合します。最初の開発ビルドだけを作る場合は `pnpm exec vite build --mode development` も使えます。

## ヘッドレス検証

固定 Editor のチェックアウトで `npm ci` を実行し、`npm run webpack:plus -- <Editorの固定チェックアウト> <GUIの固定チェックアウト>` で Desktop 用レンダラーを作ります。テストには Template v0.12.0 以降のチェックアウトを使います。

```sh
node --test test/local-extension-development.test.js
TW_PLUS_EDITOR_SOURCE=/absolute/path/to/editor \
TW_PLUS_EXTENSION_TEMPLATE_ROOT=/absolute/path/to/extension-template \
TW_PLUS_TEST_EXTENSION_JS=/absolute/path/to/turbowarp-test.js \
node --test test/local-extension-development.browser.js
```

ブラウザーテストは Desktop 用レンダラー、専用テストVM、Desktop のIPCハンドラーを使います。本物の Vite の監視プロセスで TypeScript のコンパイルを失敗させ、旧版の維持と修正後の自動反映を確認します。フォルダ選択と確認はテストの入力で与えます。テスト用拡張には `turbowarp-test` の `fc707c50a56b970db20c80081d0be9384517d120` にある `dist/turbowarp-test.js` を使います。

TypeScript 位置の確認には `TW_PLUS_EXPECT_DEVELOPMENT_SOURCE_MAP=1` と `TW_PLUS_EXPECT_RUNTIME_DIAGNOSTIC=1` を追加し、Template v0.13.0 以降を使用します。配布物の検証では、配布用コミットからテストを実行し、`TW_PLUS_DESKTOP_APP_SOURCE` に配布物の `app.asar` を展開したディレクトリを指定します。
