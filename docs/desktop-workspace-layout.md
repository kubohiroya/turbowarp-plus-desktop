# Desktop の作品別ワークスペース復元

[kubohiroya/turbowarp-plus-editor#502](https://github.com/kubohiroya/turbowarp-plus-editor/issues/502) の Desktop 側。Dockview のレイアウトは Editor（Workbench）が IndexedDB の `twPlusWorkspaceLayout` に作品ごとに保存する。Desktop は SB3 を見分けるキーだけを渡し、レイアウトそのものは保存しない。

- `EditorPreload.workspaceProjectKey(id)` は、Editor が開いているファイルの ID（Redux の `fileHandle.id`）を受け取り、そのファイルの正規化したパスの SHA-256 を返す。パスそのものはレンダラーに渡さない。URL やサンプルから開いた作品には `null` を返し、Editor は作品名とスプライトで見分ける。
- 作品プロセスの分離（`TW_PLUS_DESKTOP_PROJECT_ISOLATION`）の有無にかかわらず使える。以前の `TW_PLUS_DESKTOP_WORKSPACE_LAYOUT` は廃止した。
- 以前の版がユーザーデータの `workspace-layouts` に保存していた配置は、起動時に読まずに削除する。移行はしない。
- 保存件数の上限、記録を作る条件、消し方は Workbench の README の「Dockview のレイアウトの保存」に従う。開発者ツールを開けないビルドで記録を消す方法は未定。

## 採用版の記録

Desktop は Workbench を直接の依存にしない。固定 Editor の `package.json`・`package-lock.json` が npm の完全一致版と SHA-512 integrity で固定し、`npm run webpack:plus` がその版を解決してインストール済みの版と照合したうえで、Plus レンダラーの `build-info.json` の `editorLayout` に記録する。開発用 artifact の作成時も同じ照合を行う。検証結果を報告するときは、この `editorLayout.version` を採用版として示す。

## 検証

`npm test` の `test/workspace-project-key.test.js` が、キーの算出と古い配置の削除を確かめる。以前のファイル保存を確かめていた macOS のネイティブテストは削除した。IndexedDB に保存する Editor を固定した後に、作品ごとの復元を確かめるテストを改めて用意する。
