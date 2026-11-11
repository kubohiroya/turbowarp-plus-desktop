# ローカル Git パネルの書き込み

Plus renderer のローカル Git パネルは、File System Access で選んだフォルダの `.git` に、Git CLI と同じ形で書き込みます。Electron がこの書き込みを許していることと、Editor の固定を上げても結果が Git CLI と一致することを、この検査で確かめます。

## 確かめること

- Git CLI で作った一時リポジトリを、パネルの「リポジトリを選択…」で開く。
- Editor の外で変えた `README.md` を、パネルからステージしてコミットする。Git CLI で、ステージの状態、コミットの説明・作者・内容が一致することを確かめる。作者は、リポジトリの `user.name` と `user.email` から取る。
- パネルからブランチを作って切り替える。Git CLI で、現在のブランチと、ブランチが元のコミットを指していることを確かめる。
- `git fsck --strict` が通り、`.git/config` が変わっていないことを確かめる。

## 実行

`npm run webpack:plus` で、`config/plus-renderer.json` が固定する Editor から Plus renderer をビルドしておきます。Playwright は、その Editor の checkout にインストールされたものを使います。

```sh
TW_PLUS_TEST_EDITOR_CHECKOUT=/absolute/path/to/editor npm run test:macos:local-git
```

- ウィンドウは表示せず（`test/editor-popouts-app.js`）、OS のマウスやキーボードも使いません。フォルダは CDP の `Input.dispatchDragEvent` でドロップして渡し、ディレクトリの選択画面の代わりにその結果を返します。
- `TW_PLUS_DESKTOP_GIT_CLIENT_ID` には、`EditorPreload.localGit` を有効にするためだけの仮の値を渡します。GitHub には接続しません。
- 検査の Git CLI は `GIT_OPTIONAL_LOCKS=0` で動かします。`git status` は、作業ツリーの更新時刻が index の記録と違うと `.git/index` を書き直します。パネルの操作中にこれが起きると、パネルは外で状態が変わったと判断して操作を中止します（意図した挙動です）。
