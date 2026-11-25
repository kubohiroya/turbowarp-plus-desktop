# エディタアドオンの開発フォルダ

歯車の「エディタアドオンの開発フォルダ…」を開き、「開発フォルダを追加…」でアドオンのルートを選びます。複数のフォルダについて、名前、形式、パス、監視状態を一覧で確認できます。有効にしたアドオンのコマンドはエディターのステージ操作欄に表示されます。ビルドを更新するとコマンドの実装も差し替わります。適用中のビルドは一覧でハッシュを確認できます。監視と実行許可はエディターウィンドウごとに管理します。同じウィンドウのエディターを再読み込みすると選択が引き継がれ、ウィンドウを閉じると登録が解除されます。フォルダの情報は作品の保存ファイルに追加しません。

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
  workspace?: 'fit' | 'center' | 'zoom-in' | 'zoom-out';
};

type PanelAction = {
  id: string;
  label: string;
  run(): (CommandResult & {text?: string}) | void | Promise<(CommandResult & {text?: string}) | void>;
};

type EditorAddOnAPI = {
  registerCommand(id: string, label: string, run: () => CommandResult | void | Promise<CommandResult | void>): void;
  registerPanel(id: string, label: string, panel: {text?: string; actions: PanelAction[]}): void;
};

export function activate(api: EditorAddOnAPI) {
  let runs = 0;
  api.registerCommand('run', '作品を実行', () => ({
    project: 'run',
    label: `作品を実行（${++runs} 回目）`
  }));
}
```

起動時にだけ反映する構成では `turbowarpPlusEditor.addon.activation` を `"startup"` にします。既定の `"live"` では、チェックの切り替えと再ビルドを開いているエディターに反映します。どちらも同じ隔離環境とコマンド API を使います。`"startup"` のモジュールは、必要に応じて `export async function beforeProjectLoad(api)` を定義できます。Desktop は最初の作品の読み込みを始める前に、この処理と `activate(api)` の完了を待ちます。どちらかの関数でコマンドを登録できます。

クリックされたときにコールバックが実行されます。戻り値の `project` で現在の作品を実行・停止でき、`label` でコマンドの表示名を更新できます。非同期のコールバックも使えます。クリックから3秒以内に返った結果を反映します。

## 操作パネルとブロックの表示操作

`registerPanel(id, label, {text, actions})` で、ステージ操作欄のボタンから開く操作パネルを追加できます。開いたパネルも、同じ ID の定義が再ビルドに含まれる場合はその場で切り替わります。アドオンを無効にするとそのパネルとボタンが取り除かれます。

```js
export function activate(api) {
  api.registerPanel('workspace-tools', 'ブロック表示', {
    text: 'ワークスペースの表示を調整します。',
    actions: [
      {id: 'fit', label: '全体を表示', run: () => ({workspace: 'fit', text: '全体表示を選択しました。'})},
      {id: 'center', label: '中央へ移動', run: () => ({workspace: 'center'})}
    ]
  });
}
```

`workspace` を使うには、マニフェストの `turbowarpPlusEditor.addon.permissions` に `"workspace.viewport"` を追加します。操作対象は開いている Blockly ワークスペースで、`"fit"`、`"center"`、`"zoom-in"`、`"zoom-out"` を使えます。Desktop がパネルのボタンと本文を描画し、本文と操作結果はテキストとして表示します。

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

TurboWarp 形式の操作パネルでは `addon.tab.registerEditorPanel(id, label, {text, actions})` を使います。パネルと表示操作の契約は Plus Editor パッケージと共通です。

`addon.settings.get(id)` から、開発フォルダで適用中の設定値を読めます。`addon.self.id` でアドオン ID を得られます。`dynamicEnable` または `dynamicDisable` が明示的に `false` の場合、チェックの切り替えと新しいビルドはエディターの再読み込み時に反映します。

TurboWarp の「Do not shift pasted items」に相当するコスチュームエディターの操作には、`addon.json` に次の権限を追加します。JavaScript は TurboWarp 形式のまま使えます。

```json
{
  "turbowarpPlusEditor": {"addon": {"permissions": ["paint.clipboard-offset"]}}
}
```

この権限では、`addon.tab.redux.initialize()` の後、`statechanged` にクリップボードの設定と貼り付けオフセット増加のアクション名だけが届きます。イベント処理中に `CLEAR_PASTE_OFFSET` を送ると、次の貼り付けの位置が元の位置に戻ります。アドオンを無効にすると通常の位置ずらしに戻ります。この権限はフォルダ登録時に確認します。登録後に権限を追加する場合は、一覧から外して登録し直します。

任意の DOM へのアクセス、Blockly の内部メソッドの置換、Redux の状態読み取りや任意のアクション、Plus Editor の画面構成そのものを差し替える起動時接続は [Desktop #72](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/72) で追跡しています。

## 開発フォルダのアドオン設定

TurboWarp 形式では `addon.json` の `settings` に設定項目を書きます。Plus Editor パッケージでは `package.json` の `turbowarpPlusEditor.addon.settings` に同じ定義を置き、`api.settings` からアクセスします。

```json
{
  "settings": [
    {"id": "announce", "name": "結果を表示する", "type": "boolean", "default": false, "dynamic": true}
  ]
}
```

開発フォルダの一覧で対象行の「アドオン設定」を開き、「設定を適用」で保存します。チェックボックス、選択肢、文字列、数値、色を変更できます。`dynamic: true` の項目が変わると実行中のアドオンに `change` が届きます。他の項目はアドオンの次回起動時に反映され、反映待ちは一覧に表示されます。

```js
export default function ({addon}) {
  let announce;
  const readSettings = () => { announce = addon.settings.get('announce'); };
  readSettings();
  addon.settings.addEventListener('change', readSettings);
  addon.tab.registerEditorCommand('inspect', '確認する', () => ({
    label: announce ? '確認しました' : '確認する'
  }));
}
```

設定は開発フォルダの登録とともに同じエディターウィンドウで保持されます。再ビルドや再読み込みをまたいで使え、ウィンドウを閉じると解除されます。

## 実行と切り戻し

JavaScript を実行するフォルダは登録時に確認します。更新のたびの確認は不要です。CSS のみで登録したフォルダに実行エントリを追加したら、フォルダを登録し直してください。実行環境はエディター画面や Desktop のファイル操作から隔離し、ネットワークアクセスを遮断します。CSS を同梱する場合はフォルダ内に置き、外部リソースへの URL や `@import` を含めずに出力します。

ビルドの読み取りや起動に失敗した場合は、最後に適用した版を維持します。個別に切り戻すにはチェックを外します。起動時反映のアドオンでは、変更が保留中であることを一覧で確認できます。作品を保存してから、同じウィンドウでエディターを再読み込みしてください。
