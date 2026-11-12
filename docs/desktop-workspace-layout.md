# Desktop の作品別ワークスペース復元

[kubohiroya/turbowarp-plus-editor#502](https://github.com/kubohiroya/turbowarp-plus-editor/issues/502) と Desktop #52 の保存経路。Workbench がレイアウトを作成・復元し、作品分離モードで開いた SB3 の配置は、Desktop の起動係が作品別に保存する。Web とファイルの識別キーがない作品では、Workbench の IndexedDB を使う。

- `EditorPreload.workspaceProjectKey(id)` は、Editor が開いているファイルの ID（Redux の `fileHandle.id`）を受け取り、そのファイルの正規化したパスの SHA-256 を返す。パスそのものはレンダラーに渡さない。URL やサンプルから開いた作品には `null` を返し、Editor は作品名とスプライトで見分ける。
- Plus renderer で作品分離（`TW_PLUS_DESKTOP_PROJECT_ISOLATION=1`）と外部 YAML（`TW_PLUS_DESKTOP_EXTERNAL_YAML=1`）を有効にすると、起動係が `dockview-layouts` に保存する。読み書きは、その時点で SB3 のロックを持つ作品プロセスに限る。一時プロファイルの削除は従来どおり行う。
- 以前の版がユーザーデータの `workspace-layouts` に保存していた配置は、起動時に読まずに削除する。移行はしない。
- 作品あたり256 KiBまで、最近使った100作品分を保持する。レイアウトを作る条件は Workbench の README の「Dockview のレイアウトの保存」に従う。

## 採用版の記録

Desktop は Workbench（旧 Layout）を直接の依存にしない。固定 Editor の `package.json`・`package-lock.json` が npm の完全一致版と SHA-512 integrity で固定し、`npm run webpack:plus` がその版を解決してインストール済みの版と照合したうえで、Plus レンダラーの `build-info.json` の `editorWorkbench` に記録する。開発用 artifact の作成時も同じ照合を行う。検証結果を報告するときは、この `editorWorkbench.version` を採用版として示す。

## 検証

`npm test` の `test/workspace-project-key.test.js` が、キーの算出と古い配置の削除を確かめる。

### Desktop #52 の再現と検証手順

修正前は、一時プロファイル内の IndexedDB に配置が保存され、プロセス内の再読み込みでは復元できた。Desktop を終了して再起動すると、一時プロファイルが削除されて両作品とも初期配置に戻った。 [修正前の検証結果](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/52#issuecomment-6824975113)

Desktop のチェックアウトで固定 renderer をビルドし、再現テストを実行する。入力 SB3 は拡張機能を含まず、背景とスプライトを各1つ以上持つものを使う。テストは入力をコピーして分離したプロファイルで実行し、終了前後の配置を出力する。

```sh
npm run webpack:plus -- /absolute/path/to/editor /absolute/path/to/gui
TW_PLUS_TEST_EDITOR_CHECKOUT=/absolute/path/to/editor \
TW_PLUS_TEST_SB3=/absolute/path/to/fixture.sb3 \
TW_PLUS_TEST_SHOW_WINDOWS=0 \
node --test test/workspace-layout.macos.test.js
```

テストでは、同名で内容が同じ2つの SB3 に異なるタブ順・選択・分割寸法を設定する。Desktop を再起動し、逆順に開いて各作品の配置を比較する。別作品のレイアウトへの読み書きが拒否されることも確認する。検証した Desktop・Editor のコミットと Workbench の版はテストログに出力する。 [検証記録](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/52)
