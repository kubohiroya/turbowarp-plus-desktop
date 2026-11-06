# D6 Desktop の作品別ワークスペース復元

[Layout Issue #1](https://github.com/kubohiroya/turbowarp-plus-editor-layout/issues/1) のDesktop統合。D6を含むEditorレンダラーで、`TW_PLUS_DESKTOP_PROJECT_ISOLATION=1` と `TW_PLUS_DESKTOP_WORKSPACE_LAYOUT=1` を指定する。

- SB3を開いている作品プロセスが、ロックの所有を確認してから、作品の正規化されたパスに対応する配置をユーザーデータの `workspace-layouts` に保存する。SB3自体には配置を書き込まない。
- タブの順番、選択中のタブとグループ、分割の向きとサイズを再起動後に復元する。外部YAMLは、再起動後にファイルメニューから明示的に選び直す。作品内YAMLは通常の配置復元の対象。
- 切り戻す場合は作品を保存してDesktopの全プロセスを終了し、`TW_PLUS_DESKTOP_WORKSPACE_LAYOUT=0` で再起動する。以前の配置設定は削除されない。D5の外部YAMLが有効な場合は、配置保存なしでDockviewを使える。

## macOSの検証

D6を含むEditorレンダラーと、Editorの `scripts/yaml-editor/build-settings-fixture.ts` で生成したSB3を用意する。テストでは2作品を別プロセスで開き、Editorの保存メニューでそれぞれのSB3に書き込んだ後、両プロセスと起動係を終了する。順番を逆にして再起動し、再読込したSB3の内容、タブ順・選択、分割位置・寸法を照合する。分割操作にはPlaywrightを使う。

```sh
work=$(mktemp -d)
python3 test/prepare-project-process-app.py /Applications/TurboWarp.app "$work/TurboWarp Plus D6.app" \
  --renderer /absolute/path/to/desktop-renderer
TW_D6_TEST_APP="$work/TurboWarp Plus D6.app" \
  TW_D6_TEST_SB3=/absolute/path/to/settings.sb3 \
  TW_D6_PLAYWRIGHT=/absolute/path/to/editor/node_modules/playwright \
  npm run test:macos:workspace-layout
```
