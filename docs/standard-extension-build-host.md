# 標準拡張ビルドの実行ホスト

対象は [Desktop #67](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/67) と [Toolchain #103](https://github.com/kubohiroya/sb3-toolchain/issues/103)。ビルド本体は Toolchain、実行環境・OS 境界・容量と IPC は Desktop が所有する。

## 今回の変更と対応範囲

既存の macOS の実行ホストに、compiler payload の実ファイル照合、共有保存契約に対応する receipt、構造化した診断と容量記録を加えた。ローカルフォルダの監視・最初の承認・編集中の世代判定は既存の経路を利用する。取得した GitHub snapshot もホスト API `buildResult` に渡せる。

- 実測した環境は macOS arm64、Electron 43.8.4 の Node 24.22.1。
- Electron の Node モードを再利用する。専用 Node の追加取得量は 0 bytes。Node モードが有効な fuse は配布物作成時に既存の検査で確認する。
- Windows・Linux・Mac App Store は source build を提供しない。macOS x64 の今回の native 検証は未実施。通常の公開拡張と外部ビルド成果物の監視は従来のまま利用できる。
- 現在の Desktop の固定コンパイラーは公開版 Toolchain 0.31.3／Manifest 0.9.1／Rolldown 1.3.4。形式 1 の receipt と compiler integrity を照合し、従来の未版管理 receipt の変換も維持する。Toolchain の npm 公開をこの Desktop 差分で行わない。

Electron の Node モードは [RunAsNode fuse](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode) に依存する。utility process と専用 Node を、OS 隔離の代替に扱わない。macOS の `sandbox-exec` は非推奨の OS ツールであり、存在確認だけで将来の対応を保証しない。利用できなければ source build を停止する。専用 Node／別の隔離 backend の配布容量は今回未測定。

## compiler payload の固定

`prepare-standard-extension-compiler.mjs` は、固定した Toolchain と依存をコピーする。外部プロジェクトの install／prepare／Vite 設定を実行しない。パッケージの exact version と archive integrity は Desktop の `package-lock.json` と照合する。入れ子の依存にも対応し、同一名・同一版で integrity が食い違う lock は停止する。

`compiler-lock.json` は worker、JS、native binding、license を含む payload の各ファイルのサイズと SHA-256 を記録する。実行ホストの作成時と毎回のビルド前に全ファイルを照合する。変更、追加、symlink、hardlink、欠落、architecture の不一致で停止し、任意の host Node へ fallback しない。

配布先は `Resources/standard-extension-compiler/<arch>/`。architecture ごとに lock と native binding を分ける。Toolchain の `dist/` をまとめて持つため、公開入口が複数ファイルへ分割されても入口だけが同梱される状態を避ける。payload の SHA-256 は信頼するビルド環境の prepare 時に生成する値であり、署名・配布物の真正性や npm archive の検証を置き換えるものではない。

## OS 境界と資源制限

worker に渡すのは相対ファイル名と内容の snapshot。選択フォルダ、ホーム、Desktop profile、token を引数・環境変数に渡さない。読み取りは OS ライブラリー、固定 Electron、compiler payload に限定し、書き込み・通信・process fork・他プロセスへの signal を拒否する。worker は完成ファイルを pipe へ返し、プロジェクトの `dist` や依存ディレクトリを作らない。

- 同時実行は最大 2 件、既定の deadline は 15 秒。
- 入力は最大 128 ファイル、単体 1 MiB、合計 4 MiB。出力プロトコルは最大 9 MiB。
- V8 heap は 128 MiB。native 領域を含む RSS を既定 100 ms 間隔で観測し、256 MiB を超えた worker を終了する。観測が継続して失敗する場合も停止する。
- 取消・timeout・出力制限・RSS 超過は worker の終了を待ってから失敗を返す。process fork 自体を拒否するため、worker の子プロセスへ処理を逃がす経路を持たない。

**RSS 監視は allocation 時点の OS の厳密なメモリ割当上限ではない。** 観測の間に超過が起こり得る。`sampledPeakResidentBytes` は観測した最大値で、実際の peak RAM の保証値ではない。heap 上限だけで native memory を制御したという説明にはしない。

## 結果・診断の契約

`builder.buildResult(snapshot, signal)` は `{files, receipt, measurements, environment}` を返す。従来の `build` は `files` を返す adapter として保持する。

receipt は snapshot、lockfile、compiler の版と integrity、全出力 hash を実バイト列と再照合する。ローカル入力は `local-snapshot`、取得 broker から受けた GitHub snapshot は repository／commit を保持する。出所の観測記録であり、実行承認や開発セッションの権限を含まない。

ローカル開発の開始結果・更新候補には `buildReceipt` と `measurements` を添える。実行環境の詳細は renderer へそのまま転送しない。source の世代が変わった場合は receipt を含む候補全体を破棄し、最後の正常版を保持する。

構文エラーは `{code, file, line, column}` の診断だけを返す。file は `src/` 内の相対名、line／column は 1 始まり。絶対パス・compiler message・source snippet を IPC に流さない。監視中の失敗通知は同じエラーコードでも位置が変われば再送し、再ビルドを省略する失敗 cache でも診断を保持する。UI における診断の追加表示は利用側の対応が必要。

計測値は入力、出力、展開済み payload、追加 Node 取得、観測 RSS、時間、job の cache と一時ファイル内容。圧縮したインストーラーの増分と OS の filesystem cache は含まない。現在の compiler は同梱であり、必要時取得サービスや cache 削除 UI はこの変更の対象に含まない。

## 検証と証拠

[macOS arm64 の証拠](evidence/standard-extension-host-macos-arm64.json) は、2026-11-28 JST の headless 実行を記録する。既存の Electron 43.8.4 の実行ファイルと今回 prepare した payload を使用し、製品 renderer や新しい DMG は起動・検証していない。

- 関連 15 tests が skip なしで成功。範囲外の読み書き、Data volume の別名経由、ループバック通信、他の専用 canary への signal、子プロセス作成を拒否した。
- native Buffer の増加を含む RSS 監視、deadline、取消、過剰出力で worker の終了を確認した。
- payload の改変・追加・link、receipt／input lock／output hash の食い違いを拒否した。元のソースに依存や `dist` を書かなかった。
- 公開 Template 0.13.0 の commit `b4cd60ecf9f2a3094dc446bf1b99dabaeb89517a` を Toolchain の broker で取得し、隔離ビルド → 共有 lock validator → SB3 build／unpack の往復を通した。ローカル snapshot も同じホストで成功した。
- 2 回の receipt が一致。Electron 内の Node 24.22.1 の全出力 hash は、Toolchain #109 の Node 26.7.0 の基準値とも一致した。両方とも macOS arm64 であり、OS・architecture 間の一致を保証する測定ではない。
- payload は 21,957,054 bytes、標準 snapshot は 71,675 bytes、出力は 4,660 bytes。観測 RSS と処理時間は証拠 JSON の値を参照する。

### Toolchain 0.31.3 への追従検証

[公開版を使う追加証拠](evidence/standard-extension-host-toolchain-0.31.3-macos-arm64.json) は PR #79 の実行ホストを前提に、Toolchain 0.31.3／Manifest 0.9.1／Rolldown 1.3.4 と公開 Template 0.13.2 を検証した。上記の初回測定は履歴として保持する。

- Node 26 の対象 15 tests が、実 Electron 43.8.4 の headless Node モードを使って skip なしで成功。製品内蔵の Node 24.22.1 は実行ホストの互換性確認に使用し、通常テストの Node 24／26 の重複 matrix は追加していない。
- Template の commit `13ff059a303963e583ca1d7a7f06ca158d05ae71` を dist なしで取得し、独立した隔離 build 2 回の全 output hash と、公開 Toolchain の Node 26 基準値が一致。共有 lock validator、SB3 保存・展開・再build、local snapshot も成功した。
- 展開済み payload は 271 ファイル・22,386,873 bytes。初回測定より 429,819 bytes 増加し、専用 Node の追加取得は 0 bytes。入力は 71,940 bytes、出力は 4,660 bytes。初回 download・圧縮インストーラー増分・厳密な peak RAM の測定とは区別する。
- 更新は Toolchain の依存 graph に限定する。新版の形式 1 receipt 受理、compiler integrity 改変と worker 由来の出所偽装の拒否を回帰検査へ追加した。横断検証スクリプトは新しい基準値を使い、clean checkout で証拠出力先がない場合も作成する。
- 検証は prepare 済み payload と既存の信頼する Electron runtime の組合せ。新しい DMG／製品 renderer、macOS x64、Windows／Linux／MAS の source build は検証していない。PR #79 の統合と #67／Toolchain #103 の残る受け入れは継続する。

通常の unit test は `node --test test/local-extension-development.test.js test/local-extension-source-build.test.js`。native の境界・compiler テストも実行する場合は、`TW_PLUS_SOURCE_BUILD_ELECTRON` に信頼する Electron の実行ファイル、`TW_PLUS_SOURCE_BUILD_RESOURCES` に今回の compiler を含む Resources を指定する。package の afterPack はこの組合せを検証する既存の経路を使用する。

Toolchain の取得と共有保存契約の横断検証は次のコマンドで再現する。Toolchain は公開版 0.31.3 を固定して導入した package directory、または同版の信頼する checkout からビルドしたものを用いる。未信頼の拡張ソースをこの変数へ指定しない。

```sh
TW_PLUS_SOURCE_BUILD_TOOLCHAIN=/absolute/path/to/trusted-sb3-toolchain \
TW_PLUS_SOURCE_BUILD_ELECTRON=/absolute/path/to/Desktop.app/Contents/MacOS/Desktop \
TW_PLUS_SOURCE_BUILD_RESOURCES=/absolute/path/to/prepared/Resources \
node scripts/verify-standard-extension-host.mjs
```

## 統合前の残条件と切り戻し

この差分の公開・CI・新しい macOS 配布物での afterPack 検証は、ローカルの受け入れ結果と区別する。Toolchain #103 は open のままとし、対応を宣言する環境と元の DoD を照合して完了判定する。Desktop #67 の GitHub 取得 UI／限定 IPC、必要時取得、容量表示と cache 管理、他環境の実行境界は引き続き別の差分で進める。

切り戻しは `TW_PLUS_DESKTOP_EXTENSION_SOURCE_BUILD=0` で source build の接続を停止する。完成成果物の監視、元ソース、作品、適用済みの JS と出所記録を保持する。compiler を更新する場合は worker・payload lock・architecture 別の配布物を同じ世代に揃え、未知の receipt 版や破損した payload で続行しない。
