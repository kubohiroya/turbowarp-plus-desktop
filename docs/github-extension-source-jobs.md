# GitHub ソース取得と隔離ビルドの限定 job API

対象は [Desktop #67](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/67) と [Toolchain #103](https://github.com/kubohiroya/sb3-toolchain/issues/103)。ブランチは `feat/extensions/github-source-jobs`、依存する base は PR #81 の `feat/extensions/source-build-feedback`。PR #79 → #81 → 本差分の直列で進める。

## 今回の範囲と起動時フラグ

Toolchain の公開版 0.31.2 に含まれる GitHub broker を、検証済みの compiler payload から利用する。依存は exact 版と npm archive integrity で固定する。compile は従来の macOS 隔離 worker で行い、main 内で外部ソースや設定を実行しない。今回の更新は Manifest 0.8.0、Rolldown 1.3.4 を使う公開 tarball に基づく。upstream main の未公開差分を使わない。

機能フラグは `config/feature-flags.js` で起動時に読む `TW_PLUS_DESKTOP_GITHUB_EXTENSION_SOURCE_BUILD`。**既定 OFF**、`1` を明示した場合だけ有効にする。既存のソースビルドも有効で、検証済み macOS payload が利用できることを前提とする。Windows／Linux／MAS は capability を返さない。

この差分には GitHub 入力 UI、導入確認 UI、Loader への作品反映、実行承認は含めない。capability を確認した固定 Editor のトップフレームだけが利用できる準備 API。source build の成功は拡張の実行承認にならない。両 Issue は未完了のまま保持する。

## IPC 契約

preload は `EditorPreload.githubExtensionSource` を、利用可能な場合にだけ公開する。main は呼出元 webContents、mainFrame のオブジェクト同一性、`tw-editor://./plus-gui/gui.html` の完全な origin/path を照合する。

| 操作 | 入力 | 結果 |
| --- | --- | --- |
| `prepare` | `{repository, ref?, expectedCommit?}` | 公開 GitHub ref を commit に固定して入力を取得。`job`、`prepared`、拡張 ID、出所と取得量。compile はしない |
| `build` | 不透明な `job` | 同じ snapshot を隔離コンパイルし、出力 hash と receipt を照合。`ready` または安全な失敗状態 |
| `status` | 同じ窓の `job` | 状態、出所、計測値、既知の失敗コード・相対診断。入力本文は返さない |
| `result` | `ready` の `job` | 検証済み4成果物、receipt、bundle/API/source map hash と計測値 |
| `cancel` | `job?` | 同じ窓の job を取り消し、処理の終了を待つ。取得中は ID 未返却のため引数なしで取消可能 |

repository は `owner/name` だけ。ref は最大128文字で制御文字・空白を拒否する。URL、任意パス、shell、コマンド、引数、headers、token、fetch 実装は renderer から受け取らない。broker は `https://api.github.com/repos/<owner/name>/...` のみを利用し、資格情報を付けず redirect を拒否する。取得の本体・blob integrity は Toolchain が所有する。

prepare 後は返した commit と入力バイト列を保持する。ref を build 時に再解決しない。`expectedCommit` が異なれば失敗する。snapshot は許可した名前、最大128ファイル・単体1 MiB・合計4 MiBを再確認してコピーする。未信頼 scripts/config を実行せず、ソースは renderer に返さない。

## 状態・上限・片付け

状態は `fetching → prepared → building → ready`。失敗は `failed` とし、未完成の result を返さない。失敗後は新しい prepare で再試行できる。

- 1窓1 job、main 全体で入力／成果物を保持する job は最大2件。既存の compiler の同時実行上限も最大2件。
- job は取得開始から120秒で失効。取得自体は Toolchain の45秒、compile は既存の15秒上限を持つ。
- 入力を immutable copy として保持し、build 成功・失敗で解放する。完成候補も取消・失効・トップフレームの画面遷移・renderer 終了で破棄する。
- cancel は AbortSignal を伝え、既存 worker の close を待つ build promise の終了まで待つ。古い非同期処理が新 job の状態や timer を変更しない。
- ファイルに取得 cache／出力 cache／temp を作らず、作品・開発フォルダ・Desktop profile を変更しない。計測値は既知の非負整数だけを公開する。
- diagnostics は code と `src/` 内の相対ファイル・行・列に限定する。raw Error、source snippet、絶対パス、実行環境の詳細は返さない。

result は実行承認・local session の権限を含まない。後続の UI／Loader 接続では API manifest と成果物 lock を検証し、導入確認・実行承認を別途行う。

## 受け入れ基準と証拠

- [x] 既定 OFF と、固定 Editor トップフレーム以外からの IPC 拒否。
- [x] 任意パス・token・command、commit 差替え、巨大入力、不正な成果物、raw 診断を拒否。
- [x] prepare では compile せず、同じ固定 snapshot だけを build。result 取得だけでは実行信頼を与えない。
- [x] 取得中・ビルド中の取消、古い job の結果破棄、全体2件上限、画面遷移・renderer 終了・期限切れの解放。
- [x] 関連18 unit tests が skip なしで成功。新 payload を使う macOS 境界・compiler の7件も skip なしで成功。
- [x] 公開 Template 0.13.0 の固定 commit `b4cd60ecf9f2a3094dc446bf1b99dabaeb89517a` を実取得し、job API → 実隔離ビルド → 共有 artifact lock の検証が成功。
- [x] 全4成果物の hash が PR #79 の基準値と一致。これはこの fixture・macOS arm64 での測定で、任意ソース・全 OS の再現性の保証ではない。
- [ ] Electron の実 IPC transport、固定製品 renderer、GitHub 入力・導入確認 UI と Loader の統合。
- [ ] 新しい配布物での CI／afterPack、他環境の受け入れ、必要時取得と cache 管理。

[実取得・隔離ビルドの証拠](evidence/github-extension-source-jobs-macos-arm64.json)。既存の Electron 43.8.4 の Node モード実行ファイルと新しく prepare した payload を用い、job transport は in-process fixture。GUI・新しい DMG は起動していない。payload は22,354,679 bytes、取得147,125 bytes、入力71,675 bytes、出力4,660 bytes、追加 runtime 取得は0。RSS はサンプリングによる観測値。

再現手順:

```sh
node --test test/github-extension-source-jobs.test.js test/local-extension-development.test.js test/local-extension-feedback.test.js
TW_PLUS_SOURCE_BUILD_ELECTRON=/absolute/path/to/trusted/Node-mode-Electron \
TW_PLUS_SOURCE_BUILD_RESOURCES=/absolute/path/to/prepared/Resources \
node scripts/verify-github-extension-source-jobs.mjs
```

最初の手動検証では検証スクリプトの lock の field 名に誤りがあったため停止した。実際の `provenance.kind` 契約に合わせて assertion を修正し、全経路の再実行が成功した。製品の lock 検証を緩和した変更ではない。

## 切り戻し

`TW_PLUS_DESKTOP_GITHUB_EXTENSION_SOURCE_BUILD` を未設定または `0` として再起動し、新しい capability の公開を停止する。画面を閉じれば保持 job も取消される。必要なら本差分と compiler pin を同じ世代で revert し、再 prepare する。元作品・正常成果物・ユーザーのソースを削除しない。既存ローカルソースビルド全体を止める場合は `TW_PLUS_DESKTOP_EXTENSION_SOURCE_BUILD=0`。
