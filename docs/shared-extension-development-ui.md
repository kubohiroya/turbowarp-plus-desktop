# 拡張開発UIを共有パッケージへ接続する準備

関連: [Security Dialog #106](https://github.com/kubohiroya/turbowarp-extension-security-dialog/issues/106)、[Desktop #68](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/68)。ブランチ: `refactor/extensions/shared-development-ui`、base: `d3a1fb6`。

`local-extension-development-dialog.jsx`は、互換なsecurity-dialogの`./react`が`ExtensionDevelopment`を提供するとき、拡張ブロックの画面を共有UIへ渡します。引数のsession snapshotと既存の開始・停止・接続解除・取消コールバックを使い、ファイル監視、IPC、承認、ビルド、Loaderへの反映は変更しません。現行controllerが扱う実行方式はサンドボックスなので、その事実だけを表示へ渡します。

旧版の共有パッケージには新exportがないため、その場合は既存のダイアログを維持します。アドオン画面も従来のダイアログのままです。版の固定値や起動フラグを今回変更していないため、この差分だけで製品の表示が切り替わるとは扱いません。

## 受け入れ基準と検証

- [x] 新exportがあるときだけ共有UIへ渡し、既存のModalをフレームにする。
- [x] session・開始・停止・取消・接続解除の引数を既存controllerへそのまま渡す。
- [x] 旧共有版では既存UI、アドオンでは既存画面を維持する。
- [x] 共有UI側のヘッドレス9件で実アダプターファイルをbundleして確認。ModalとCSS Modulesはfixtureのため、実製品rendererの検証とは区別する。
- [x] `node --test test/local-extension-development.test.js` の既存8件が成功。承認前のbuild停止、取消、sessionごとの独立、source mapの適用版照合、古い世代の拒否を維持する。
- [ ] 新共有UIを含む公開版、Editor固定依存、Desktop固定rendererを一致させた製品ビルド・統合検証。

共有UI側の検証コマンド:

```sh
TWEXTSEC_DESKTOP_SOURCE=/absolute/path/to/this-checkout \
node --test --test-timeout=45000 test/extension-development.browser.ts
```

共有UIを含む版の公開→Editorの依存固定→Desktopのrenderer固定・ビルドの順に製品へ反映します。公開や固定先の変更はこのローカル準備には含めません。通常検証はヘッドレスとし、実OSのフォルダ選択や画面付きElectronは別の明示依頼がある場合だけ行います。

## 運用ログと切り戻し

- 2026-11-28 JST start: 最新mainの既存UIとcontroller契約を確認し、別worktreeで最小アダプターを準備。
- done: 共有UI込み9件と既存controller8件が成功。既存アドオンと旧共有パッケージへの互換を確認。
- pending: 共有UIの公開と固定rendererを使う製品統合。UIの文言・状態表示の本体はsecurity-dialogが所有する。

アダプターをrevertすれば既存ダイアログへ戻ります。製品固定を変更した後は、対応するEditor/rendererも直前版へ戻します。開発フォルダ、作品、正常ビルドやsessionの承認形式は変更しません。
