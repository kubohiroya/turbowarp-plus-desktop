# D3 Desktop の作品プロセスとロック

公式 TurboWarp Desktop 1.17.1 のコミット `6e7bc5934f27cd658d17bf8742db4357ae057657` を基点とする。公式のライセンスを維持し、main・preload の接続差分をこのリポジトリで管理する。起動経路の検証は [Desktop #2](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/2)、Plus レンダラーの固定版を取り込む作業は [Desktop #3](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/3)、全体計画は [Layout #1](https://github.com/kubohiroya/turbowarp-plus-editor-layout/issues/1) で追跡する。

## 開発起動と切り戻し

上流の `npm ci`、`npm run fetch`、`npm run webpack:compile` で開発資産を用意する。初期導入では起動時フラグを `TW_PLUS_DESKTOP_PROJECT_ISOLATION=1` にすると D3 を使う。

```sh
TW_PLUS_DESKTOP_PROJECT_ISOLATION=1 npm run electron:start -- /absolute/path/Project.sb3
```

切り戻す際は作品を保存し、すべての作品ウィンドウと起動係を終了してから `TW_PLUS_DESKTOP_PROJECT_ISOLATION=0` で起動する。公式版と別のユーザーデータ領域を使用する。異常終了の直後は、残存する作品プロセスがすべて終了したことを確認してから切り替える。

## 排他の範囲

- 起動係がコマンドライン、OS のファイルオープン、既存のファイル選択 IPC、信頼された SB3 ドロップを受け付ける。作品プロセスは独立したプロファイルで編集ウィンドウを1つ開く。ここでのウィンドウ数は作品の編集ウィンドウを指す。
- 起動係の単一起動制御でロックの作成と回収を直列化する。ロックを取得してから作品を読む。ロックは Plus のユーザーデータ配下にあり、作品名の変更やファイルの原子的な置換で書き手が二重にならないよう、正規化した保存先を予約する。別名保存は新旧のロックを保持したまま原子的に書き込み、成功後に旧ロックを解放する。
- 正常終了では作品プロセスの終了を確認してから解放する。起動係も停止した場合、次の起動係が記録された PID の終了を確認できたロックを回収する。PID が生きているか、記録を検証できない場合はロックを保持する。
- 保証範囲は同一ユーザー・ホストのローカルファイルシステム。シンボリックリンクは実体に解決する。ハードリンクを持つ作品は拒否する。macOS と Windows は大文字小文字だけ異なる保存先を同一として保守的に扱う。配布版のファイル関連付け、MAS、Windows/Linux、ネットワークファイルシステムは別途検証する。

## macOS の検証手順

`TW_D3_TEST_SB3` には自動実行拡張を含まない試験用 SB3 を指定する。公式アプリは検証専用コピーの元として使う。テストは OS マウスを動かさず、明示した試験用パスをダイアログの結果として返し、実際の IPC、保存ストリーム、Electron プロセスとウィンドウを検証する。

```sh
node --test test/project-lock.test.js
work=$(mktemp -d)
python3 test/prepare-project-process-app.py /Applications/TurboWarp.app "$work/TurboWarp Plus D3.app"
TW_D3_TEST_APP="$work/TurboWarp Plus D3.app" TW_D3_TEST_SB3=/absolute/path/fixture.sb3 \
  node --test test/project-process.macos.test.js
```
