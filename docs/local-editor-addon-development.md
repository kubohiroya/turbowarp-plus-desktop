# エディタアドオンの開発フォルダ

歯車の「エディタアドオンの開発フォルダ…」を開き、「開発フォルダを追加…」でアドオンのルートを選びます。複数のフォルダについて、名前、形式、パス、監視状態を一覧で確認できます。有効にしたアドオンのコマンドはエディターのステージ操作欄に表示されます。ビルドを更新するとコマンドの実装も差し替わります。チェックを外すと、そのアドオンのコマンドが取り除かれます。監視はエディターウィンドウごとに行い、フォルダの情報は作品の保存ファイルに追加しません。

## Plus Editor パッケージ

`package.json` の `turbowarpPlusEditor.addon.entry` に、ローカルのビルドツールで出力した単一の JavaScript モジュールへの相対パスを書きます。TypeScript は ESM 形式にバンドルし、依存も同じファイルに含めます。必要な場合は `styles` に CSS を一つ指定できます。

```json
{
  "name": "@example/editor-commands",
  "displayName": "Example editor commands",
  "turbowarpPlusEditor": {"addon": {"entry": "dist/editor.js"}}
}
```

```ts
type CommandResult = {
  project?: 'run' | 'stop';
  label?: string;
};

type EditorAddOnAPI = {
  registerCommand(id: string, label: string, run: () => CommandResult | void | Promise<CommandResult | void>): void;
};

export function activate(api: EditorAddOnAPI) {
  let runs = 0;
  api.registerCommand('run', '作品を実行', () => ({
    project: 'run',
    label: `作品を実行（${++runs} 回目）`
  }));
}
```

クリックされたときにコールバックが実行されます。戻り値の `project` で現在の作品を実行・停止でき、`label` でコマンドの表示名を更新できます。非同期のコールバックも使えます。クリックから3秒以内に返った結果を反映します。

## TurboWarp アドオン

`addon.json` の `userscripts` にビルドした JavaScript モジュールを指定します。`matches` は省略するか、作品エディターの `projects` または `https://scratch.mit.edu/projects/*` を使います。`userstyles` も使えます。

```json
{
  "name": "Stop project",
  "userscripts": [{"url": "dist/editor.js", "matches": ["projects"]}]
}
```

```js
export default function ({addon}) {
  addon.tab.registerEditorCommand('stop', '作品を停止', () => ({project: 'stop'}));
}
```

この開発モードで使えるアドオン API は `registerEditorCommand` です。既存 TurboWarp アドオンの DOM 操作や設定 API、および Plus Editor 起動時の統合 API は [Desktop #72](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/72) で追跡しています。

## 実行と切り戻し

JavaScript を実行するフォルダは登録時に確認します。更新のたびの確認は不要です。CSS のみで登録したフォルダに実行エントリを追加したら、フォルダを登録し直してください。実行環境はエディター画面や Desktop のファイル操作から隔離し、ネットワークアクセスを遮断します。CSS を同梱する場合はフォルダ内に置き、外部リソースへの URL や `@import` を含めずに出力します。

ビルドの読み取りや起動に失敗した場合は、最後に適用した版を維持します。個別に切り戻すにはチェックを外します。エディター自体を再読み込みすると、そのウィンドウでの登録はすべて解除されます。
