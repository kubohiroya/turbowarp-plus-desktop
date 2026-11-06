# Desktop の権限境界

[Desktop #4](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/4) で、製品ホストと拡張の境界を検証する。

## 画面と preload

通常の BrowserWindow は [AbstractWindow](../src-main/windows/abstract.js) の sandbox、context isolation、Node integration 無効を使う。既存ウィンドウを引き取る場合は、作成時の設定も個別に確認する。

| 画面 | ソースで確認した接続 |
| --- | --- |
| 標準・Plus editor | `tw-editor` の固定エントリー。専用 preload と main frame に限定した IPC。作品・外部 YAML はハンドルで参照し、素材転送・配置保存は起動設定で有効にする。 |
| アドオン設定、Desktop 設定、About、プライバシー、移行・更新、アクセス・権限確認 | 同梱ページと用途別の preload。ウィンドウをまたぐ editor IPC は公開しない。 |
| Packager とプレビュー | Packager は `tw-packager` と専用 preload を使い、選択元 editor から MessagePort で作品を受け取る。プレビューは別の BrowserWindow で preload を外す。 |
| 拡張の文書・データプレビュー | 文書は `tw-extensions` と文書用 preload を使う。データプレビューは `data:` と用途専用のウィンドウ設定を使う。 |
| バックパック別窓 | 固定した Plus の同梱ページと窓操作専用 preload。後述の予約を必要とする。 |

セッションの権限チェックとナビゲーションの委譲は [main の初期化](../src-main/index.js)、独自プロトコルと MIME は [protocols.js](../src-main/protocols.js) で管理する。

## バックパックの別窓

開発起動時に `TW_PLUS_DESKTOP_RENDERER=1` と `TW_PLUS_DESKTOP_BACKPACK_POPOUT=1` を設定する。後者の既定値は OFF。フラグを外してアプリを再起動するとドック内のバックパックに戻る。

- editor の main frame、固定 URL、`tw-editor://.` の origin を照合した IPC で UUID を一度予約する。予約は5秒で失効し、同じ editor から開けるバックパック別窓は1枚まで。
- Electron の `setWindowOpenHandler` は `about:blank`、予約した名前、POST 本文のない要求の組を確認する。main が同梱の `backpack-popout.html` と予約 UUID を設定し、接続後は共通 renderer が子の `opener` を外す。
- 子では別窓、外部遷移、renderer による権限要求を拒否する。子の preload は窓の状態取得・最大化・最小化・復元と状態通知を提供する。操作時は送信元フレームと固定 URL を照合する。親の再読み込みや終了で予約と子を破棄する。

拡張のカタログ掲載・Loader の実行承認・OS のメディアやクリップボードの許可はそれぞれ別の判断。承認済みの非サンドボックス拡張は editor の Web コンテキストで動作するため、editor が公開する用途別 API も main のハンドルと引数で権限を限定する。

## macOS の回帰テスト

[開発手順](../README.md) に従って Plus renderer と Electron を準備する。テストは固定 Editor の checkout にインストールした Playwright を使用する。

```sh
work=$(mktemp -d)
python3 test/project-process-fixture.py "$work/fixture.sb3"
TW_PLUS_TEST_EDITOR_CHECKOUT=/absolute/path/to/editor TW_PLUS_TEST_SB3="$work/fixture.sb3" \
  node --test test/backpack-popout.macos.test.js
```

既定 OFF、予約なしの別窓、サブフレーム、無効なチケット、許可した UI の別窓、子の権限とナビゲーション、親の再読み込みを確認する。
