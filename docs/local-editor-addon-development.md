# エディタアドオンの開発フォルダ

歯車の「エディタアドオンの開発フォルダ…」を開き、「開発フォルダを追加…」でアドオンのルートを選びます。複数のフォルダを追加でき、名前・ID・形式・パスを確認できます。チェックを入れるとスタイルを適用し、変更を監視します。外すとそのアドオンのスタイルを取り外します。監視セッションはエディターウィンドウに属し、作品の保存ファイルには追加されません。エディターを再読み込みするとローカルのスタイルと登録情報を解除できます。

## 対応するスタイル

- TurboWarp の `addon.json` では `userstyles` に相対 CSS パスを指定します。`matches` は省略するか、作品エディターを指す `projects` または `https://scratch.mit.edu/projects/*` を使います。パスのルートは選択したフォルダです。
- Plus Editor 追加機能パッケージの `package.json` では `turbowarpPlusEditor.addon.styles` に、完成した CSS ファイルの相対パスを1つ指定します。パッケージ名を ID として使います。

```json
{
  "name": "@example/editor-style",
  "displayName": "Example editor style",
  "turbowarpPlusEditor": {"addon": {"styles": ["dist/editor.css"]}}
}
```

CSS はフォルダ内に置き、リソース URL や `@import` を含めずに出力します。読み取り途中や差し替えを検知した場合は最後に適用したスタイルを維持します。JavaScript の `userscripts`、条件つきのユーザースタイル、Plus Editor の起動時接続やコードの実行を必要とするアドオンは、このスタイル用の経路では有効にできません。それらの対応は Desktop #72 で追跡します。
