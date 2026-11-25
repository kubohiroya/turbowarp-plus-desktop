# エディタアドオンの開発フォルダ

歯車の「エディタアドオンの開発フォルダ…」を開き、「開発フォルダを追加…」でアドオンのルートを選びます。複数のフォルダを追加でき、名前・ID・形式・パスを確認できます。チェックを入れるとエディタアドオンが有効になります。対応する成果物が更新されると、自動で反映します。チェックを外すと、そのアドオンは無効になります。監視セッションはエディターウィンドウに属し、作品の保存ファイルには追加されません。エディターを再読み込みするとローカルのアドオンが無効になり、フォルダの登録も解除されます。

## 対応する形式

Desktop は、開発フォルダにあるマニフェストと、そこから参照される対応済みの成果物を読み取ります。現在の反映対象は CSS です。ビルドが必要な構成では、開発環境で生成した CSS を指定します。

- TurboWarp の `addon.json` では `userstyles` に相対 CSS パスを指定します。`matches` は省略するか、作品エディターを指す `projects` または `https://scratch.mit.edu/projects/*` を使います。パスのルートは選択したフォルダです。
- Plus Editor 追加機能パッケージの `package.json` では `turbowarpPlusEditor.addon.styles` に、完成した CSS ファイルの相対パスを1つ指定します。パッケージ名を ID として使います。

```json
{
  "name": "@example/editor-style",
  "displayName": "Example editor style",
  "turbowarpPlusEditor": {"addon": {"styles": ["dist/editor.css"]}}
}
```

CSS はフォルダ内に置き、リソース URL や `@import` を含めずに出力します。読み取り途中や差し替えを検知した場合は最後に読み込んだ CSSを維持します。JavaScript の `userscripts`、条件付きの CSS、Plus Editor の起動時接続やコードの実行を必要とするアドオンは、このダイアログでは有効にできません。それらの対応は Desktop #72 で追跡します。
