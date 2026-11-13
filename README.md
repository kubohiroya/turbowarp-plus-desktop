# TurboWarp Plus Desktop

TurboWarp Plus Editor のデスクトップ版です。公式 [TurboWarp Desktop 1.17.1](https://github.com/TurboWarp/desktop/tree/6e7bc5934f27cd658d17bf8742db4357ae057657) を基点にしています。ライセンスは [GPL-3.0](LICENSE) です。上流には [LLK/scratch-desktop](https://github.com/LLK/scratch-desktop) に由来するコードも含まれます。

開発状況は [親 Issue](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/1)、不具合は [このリポジトリの Issues](https://github.com/kubohiroya/turbowarp-plus-desktop/issues) を参照してください。製品向け配布と署名は [Desktop #9](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/9) で扱います。

初回配布の対象と GitHub Actions の開発用ビルドは [配布サポート表](docs/desktop-distribution.md) を参照してください。

## macOS での開発起動

Git、Node.js 24、npm を用意します。`npm ci` は `package-lock.json` に従って依存を導入します。Electron の実行ファイルは初回起動時に取得します。依存・追加資産の取得と初回起動にはネットワーク接続が必要です。

```sh
git clone https://github.com/kubohiroya/turbowarp-plus-desktop.git
cd turbowarp-plus-desktop
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run fetch
npm run webpack:compile
npm run electron:start
```

この手順では標準 renderer と Desktop のアドオン設定画面をビルドします。公式アプリのローカルコピーを使う D3〜D6 の検証手順は [作品分離と排他](docs/project-process-lock.md) を参照してください。

- `npm run fetch` は素材ライブラリ、Packager、拡張の資産を準備します。
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` は開発起動に不要なテスト用 Chromium の取得を省きます。
- `npm run webpack:watch` は renderer の開発ビルドを更新します。main や preload の変更を反映するにはアプリを再起動します。
- `docs/screenshots` は上流の文書用サブモジュールです。スクリーンショットが必要な場合は `git submodule update --init docs/screenshots` で取得します。

## ローカル CI と macOS 実機テスト

依存を導入した後、通常のローカル CI は `npm test` で実行します。作品ロック、素材転送、外部 YAML、標準 renderer の上書き保護、レイアウト保存を Node.js で検証します。実機テスト用の環境変数が残っていても、このコマンドから Electron が起動することはありません。

Electron のウィンドウや macOS のクリップボードを使う検証は、対象を選んで実行します。各手順で指定するテスト用アプリと SB3 を先に用意してください。

| コマンド | 検証手順 |
| --- | --- |
| `npm run test:macos:local-git` | [ローカル Git パネルの書き込み](docs/local-git-panel.md) |
| `npm run test:macos:project-process` | [作品分離と排他](docs/project-process-lock.md) |
| `npm run test:macos:project-transfer` | [作品間転送](docs/project-json-transfer.md) |

## Plus Editor renderer の組み込み

`config/plus-renderer.json` の Editor コミットと、その `site/source.json` の GUI コミットを別々のクリーンな checkout に用意します。固定した Editor の `.nvmrc` の Node.js 版で両方に `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci` を実行し、GUI 側で `node scripts/prepublish.mjs` を実行します。

Desktop の作業ツリーから次を実行します。

```sh
npm run webpack:plus -- /absolute/path/to/editor /absolute/path/to/scratch-gui
profile_dir=$(mktemp -d)
TW_PLUS_DESKTOP_DATA_DIR="$profile_dir" TW_PLUS_DESKTOP_RENDERER=1 npm run electron:start
```

ビルドは Editor の Desktop 用 webpack 設定と GUI の既存接続口を使います。Plus renderer とそのアドオン設定画面は同じ固定 GUI からビルドします。成果物の `dist-renderer-webpack/editor/plus-gui/build-info.json` に Desktop・Electron・Editor・GUI・VM の採用版と、固定 Editor が採用する `@kubohiroya/turbowarp-plus-editor-workbench`（旧 `turbowarp-plus-editor-layout`）の版・取得元・SHA-512 integrity（`editorWorkbench`）を記録し、同梱パッケージとライセンスの索引を添えます。Workbench の版は Editor の `package.json`・`package-lock.json` から解決し、インストール済みの版と一致しなければビルドを止めます。

Plus renderer を同梱した配布用アプリでは、通常起動で Plus Editor が開きます。標準 renderer に切り替える場合は、`TW_PLUS_DESKTOP_RENDERER=0` を指定して起動します。標準 renderer では、Plus 作品や内容を判定できない既存ファイルへの上書きが拒否されます。別名で新規保存するか、Plus renderer で作品を開き直してください。

Plus editor の別窓を検証する場合は、[Desktop の権限境界](docs/desktop-security-boundaries.md) を参照してください。

### ローカル Git の GitHub 接続

GitHub の HTTPS リモート `origin` が設定されたリポジトリを選び、「ファイル」→「GitHub 接続設定…」を開きます。接続方式で「Desktop ローカル」を選ぶと、client ID の設定なしで「Fine-grained 個人アクセストークン」を選べます。対象リポジトリに credential helper が設定されている場合は「手元の Git の認証情報」も選べます。

Renderer に渡す Git セッションは、接続先、アカウント、短命の Bearer、期限を含みます。GitHub のトークンはメインプロセスで扱います。プロキシは `127.0.0.1` で待ち受け、Git 通信では `Host` と `Origin: tw-editor://.`、Bearer、選択したリポジトリの ID と操作権限を確認します。

#### GitHub App の Device Flow

通常の Plus Editor 開発起動時に Device Flow を設定すると、Editor のトップフレームに `EditorPreload.localGit` が公開されます。認証後に選択リポジトリの許可を取得し、その短命セッションを Git Smart HTTP アダプターへ渡します。保存を選択した場合は OS の保護機能で暗号化し、保護機能が利用できない環境ではメモリ内で利用します。切断するとセッションと保存済みの資格情報を削除します。

GitHub App には次の設定が必要です。作り方は [GitHub App の作り方](https://github.com/kubohiroya/hierarchidb/blob/main/packages/backend/bff/docs/github-app-setup.md)（英語）を参照してください。

- Enable Device Flow: オン（Desktop は device flow でログインします）
- Expire user authorization tokens: オン（期限付きのトークンと更新用のトークンを前提にしています。オフだと更新用のトークンが返らず、接続に失敗します）
- Repository permissions: Contents は Read and write、Pull requests は Read and write、Metadata は Read-only。ほかの権限は付けません

Device Flow を使う場合は、GitHub App の公開 client ID を環境変数 `TW_PLUS_DESKTOP_GIT_CLIENT_ID` に指定します。配布版への client ID の同梱は [#40](https://github.com/kubohiroya/turbowarp-plus-desktop/issues/40) で扱います。

第三者も公開 client ID を使って Device Flow を開始できます。Desktop の画面に表示されたコードだけを GitHub に入力してください。他人から届いたコードは入力しないでください。接続の承認は GitHub の [Authorized GitHub Apps](https://github.com/settings/apps/authorizations) で取り消せます。配布用 App の悪用が疑われる場合は、配布者が App の Device Flow を停止し、必要に応じて App を作り直して公開 client ID を差し替えます。

#### Fine-grained personal access token

GitHub の設定で、接続したいリポジトリだけを選び、Contents を読み取り専用、push が必要なら読み書きに設定します。有効期限も設定してください。 [GitHub のトークン作成手順](https://docs.github.com/ja/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

Desktop は OS のマスク付きダイアログで `github_pat_` から始まるトークンを受け取り、選択したリポジトリの ID と操作権限を確認します。Linux では Zenity または KDialog が使える環境で利用できます。保存は任意で、OS の保護機能を利用できる場合は暗号化します。期限切れや失効の後は、新しいトークンで接続し直してください。

方式選択に対応する Editor は、トップフレームの `EditorPreload.localGitAuth.getAuthMethods()` で利用可能な方式を調べ、`fine-grained-pat` がある場合に `connectPersonalAccessToken(remote, remember)` を呼べます。トークンの入力画面は Desktop が表示します。旧 Editor の Device Flow 用 API は `EditorPreload.localGit` です。切り戻すときは必要に応じて先に切断し、`TW_PLUS_DESKTOP_GIT_PERSONAL_ACCESS_TOKEN=0` を指定して起動します。

#### 手元の Git の認証情報

`git` と、選択した GitHub リポジトリに適用される `credential.helper` の設定がある場合は、既存の認証情報を利用できます。接続ごとに GitHub のアカウント名とリポジトリを確認し、同意を受けてから認証情報を読みます。GitHub が返すアカウント名が確認画面と一致し、対象リポジトリにアクセスできるときに接続します。トークンはメモリに保持し、切断で破棄します。資格情報を再取得する場合はもう一度確認画面を表示します。

Editor は `EditorPreload.localGitAuth.getAuthMethods(remote)` にリモートを渡し、`git-credential-helper` が返ったときに `connectGitCredential(remote, login)` を呼べます。切り戻すときは `TW_PLUS_DESKTOP_GIT_CREDENTIAL_HELPER=0` を指定して起動します。

push の `git-receive-pack` POST には `Git-Push-Id`（小文字の UUID v4）が必要です。上流への送信前に有効なセッションで ID を予約し、同じ ID が届いた場合は `409 PUSH_DUPLICATE` を返します。予約はセッションの寿命に合わせて保持されます。 [共通契約](https://github.com/kubohiroya/turbowarp-plus-editor/issues/316)

PR の一覧・題名・本文の読み取りとレビューの送信には、ループバックプロキシの GitHub API 経路（`/v1/github/<owner>/<repo>/…`）を使います。既定では無効で、開発起動時に `TW_PLUS_DESKTOP_GIT_GITHUB_API` へ有効にする経路のまとまりをコンマ区切りで指定します。

```sh
TW_PLUS_DESKTOP_GIT_CLIENT_ID=<client ID> TW_PLUS_DESKTOP_GIT_GITHUB_API=pulls-read,review-threads,reviews-body npm run electron:start
```

- `pulls-read`: PR の一覧（`GET /pulls`）と1件（`GET /pulls/<n>`）
- `review-threads`: 固定の5つの GraphQL 操作（`POST /graphql/<操作名>`）。`project.source.json` へのファイル単位のスレッドを付けたレビューを送ります
- `reviews-body`: レビューの一覧（`GET /pulls/<n>/reviews`）と本文だけのレビューの送信（`POST /pulls/<n>/reviews`）。`review-threads` を切った環境での代わりの経路です

無効のまとまりの経路は `404 GITHUB_API_UNAVAILABLE`、未知の値や重複した値を指定すると全経路が `500 GITHUB_API_MISCONFIGURED` になります。`review-threads` だけを外すと GraphQL の経路だけが止まり、Editor は本文だけの送信に切り替わります。Git Smart HTTP の経路は設定の影響を受けません。

レビューの送信には、Editor が `authorizeRepository(remote, write, review)` の第3引数に `true` を渡して得た `review` 付きのセッションが必要です。GitHub のトークンとノード ID はメインプロセスに留め、Renderer には返しません。1回のレビューの送信は `Review-Submit-Id`（小文字の UUID v4）で表し、その手順の記録はセッションのメモリに `Git-Push-Id` とは別に合わせて 256 件まで持ち、切断・置換・期限切れで消します。経路・検証・応答・エラーの契約は Cloudflare 側と同じです。 [GitHub API routes](https://github.com/kubohiroya/hierarchidb/blob/main/packages/backend/bff/docs/git-smart-http.md#github-api-routes)（英語）

#### リポジトリ作成の開発検証

作成用の GitHub App の公開 client ID を `TW_PLUS_DESKTOP_GITHUB_CREATE_CLIENT_ID` に指定します。App では Device Flow と user authorization token の有効期限を有効にし、検証用の個人アカウントまたは組織にインストールして承認します。組織への作成には、認証するユーザーにその組織で指定した公開範囲のリポジトリを作成できる権限も必要です。

| 操作 | 検証用 App のリポジトリ権限 |
| --- | --- |
| 作成先の確認とリポジトリ作成 | Repository creation の書き込み。Metadata の読み取り |
| 作成したリポジトリに初回コミットを push | Contents の読み書き |
| Topics の置き換えを検証する場合 | Administration の書き込みを追加して再承認 |

作成専用権限で作ったリポジトリがインストール対象に加わることと、初回 push が通ることを分けて確認します。承認済みの新規検証用リポジトリ名を指定して、作成の確認、作成後の ID の照合、初回 push、Topics を選んだ場合の更新までを検証します。公開リポジトリの検証には公開の承認も必要です。 [GitHub App の権限](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) · [個人・組織のリポジトリ作成と Topics 更新 API](https://docs.github.com/en/rest/repos/repos)

作成用契約を含む `@kubohiroya/turbowarp-plus-editor-auth` のビルドを開発時に使う場合は、その `dist/index.js` の絶対パスを `TW_PLUS_DESKTOP_GITHUB_CREATE_AUTH_MODULE` で指定できます。配布にはこの契約を含む依存版の取り込みが必要です。模擬 GitHub での検証は次のコマンドで実行できます。

```sh
TW_PLUS_DESKTOP_GITHUB_CREATE_AUTH_MODULE=/absolute/path/to/auth/dist/index.js node --test test/local-git-creation.test.js test/local-git.test.js
```

作成用のセッションは `EditorPreload.localGitCreation` から始めます。作成内容は Desktop の確認画面で承認します。作成の結果は OS の保護機能で暗号化して記録します。応答が途切れた場合は、空の候補の ID を確かめて再開できます。初回 push 用のセッションは作成済みの ID と対象リポジトリにひもづきます。

#### PR の作成と CI・マージ

通常の GitHub App で対象リポジトリの書き込みを許可し、`TW_PLUS_DESKTOP_GIT_PUBLICATION` に操作を指定します。PR の作成には `pulls-read,pulls-write` が必要です。Issue の参照には `issues-read`、新規作成・マージ後のクローズにはさらに `issues-write` を指定します。CI を確認してマージする場合は `checks-read,merge` を追加します。

```sh
TW_PLUS_DESKTOP_GIT_CLIENT_ID=YOUR_GITHUB_APP_CLIENT_ID \
TW_PLUS_DESKTOP_GIT_PUBLICATION=pulls-read,pulls-write,issues-read,issues-write,checks-read,merge \
TW_PLUS_DESKTOP_GIT_PUBLICATION_MODULE_DIR=/absolute/path/to/editor-git/dist npm run electron:start
```

App を検証用リポジトリにインストールして承認し、Metadata の読み取り、Contents と Pull requests の読み書きを許可します。Issue を参照する場合は Issues の読み取り、作成やクローズも検証する場合は読み書きを許可します。CI の確認には Checks と Commit statuses の読み取りを付けます。既存の CI ワークフローを使い、Squash merge を有効にして、対象ブランチの保護ルールに必要なチェックとレビューをそろえます。 [PR と非同期マージ API](https://docs.github.com/en/rest/pulls/pulls) · [Issue API](https://docs.github.com/en/rest/issues/issues) · [Checks API](https://docs.github.com/en/rest/checks/runs) · [Commit statuses API](https://docs.github.com/en/rest/commits/statuses)

Editor の「ファイル」→「保存してコミット」でコミットを作成し、その行の「PR を作成・確認」から内容を入力します。Desktop の確認画面で承認した PR の内容と操作範囲は、OS の保護機能で暗号化して保存します。Editor が PR 専用ブランチを push し、Desktop が承認済みのコミットと一致することを確かめてからキューを進めます。作業を再開する場合は GitHub に接続し、同じコミットの「PR を作成・確認」を開きます。

実 GitHub では、承認済みの検証用リポジトリで push、PR 作成、CI 待機、マージ結果の確認、選択した場合の Issue クローズを順に検証します。

ネイティブの PR スタックを使う場合は `TW_PLUS_DESKTOP_GIT_PUBLICATION` に `stacks` を追加します。既存の親 PR は同じリポジトリで開いている必要があります。すでにスタックに属する場合は最上位を選びます。確認画面では親 PR 番号、親ブランチとコミット、スタックの反映先を確認できます。GitHub で下位の PR がすべてマージされ、反映先への更新後も完全な子 PR の差分が一致し、新しいコミットの CI とレビュー条件を満たすと、承認した子 PR のマージを進めます。バイナリアセットなど、完全な差分を確認できない場合は PR とスタックを作成し、自動マージを一時停止します。 [GitHub スタック API](https://docs.github.com/en/rest/pulls/stacks) · [スタックのマージ条件](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests)

開発時のモック検証は `TW_PLUS_DESKTOP_GIT_PUBLICATION_MODULE_DIR` を指定して `node --test test/local-git-publication.test.js` を実行します。配布には PR キューと GitHub 接続を含む `@kubohiroya/turbowarp-plus-editor-git` の依存版が必要です。切り戻しは `TW_PLUS_DESKTOP_GIT_PUBLICATION` を外して再起動します。

## 開発プロファイル

macOS の既定の保存先は `~/Library/Application Support/TurboWarp Plus Desktop` です。個別の検証では `TW_PLUS_DESKTOP_DATA_DIR` に新しいディレクトリを指定できます。

```sh
profile_dir=$(mktemp -d)
TW_PLUS_DESKTOP_DATA_DIR="$profile_dir" npm run electron:start
```

作品分離を試す場合は同じ起動コマンドに `TW_PLUS_DESKTOP_PROJECT_ISOLATION=1` を加えます。検証終了後にプロファイルを整理する場合は、全ウィンドウと起動係を閉じ、検証用として作成したディレクトリを確認してください。

## 上流への追従

[公式 TurboWarp Desktop](https://github.com/TurboWarp/desktop) の採用コミットを記録し、更新時は `package-lock.json`、同梱資産の取得元と整合性、ライセンスを確認します。Desktop の起動、プロファイル分離、作品の読み込みと保存を採用版で再確認します。
