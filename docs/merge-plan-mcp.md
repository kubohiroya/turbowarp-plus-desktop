# マージ候補をローカルMCPで読む

通常配布版Desktopの「ローカルGit」から「マージプラン」を開き、「MCPで共有」を選んで確認します。表示されたURLとアクセストークンを、この作品を扱うAIエージェントのStreamable HTTP接続に渡します。接続は `Authorization: Bearer <アクセストークン>` を使います。URLとトークンは共有を開始するたびに発行されます。

接続は確認画面に表示された作品フォルダに限定されます。別の作品にも接続する場合は、その作品の画面から共有してください。アクセストークンは接続させたいクライアントに渡してください。たとえば、対応するクライアントのURL設定に表示されたURLを指定し、認証ヘッダーの値を環境変数やシークレット設定から渡せます。

| MCP ツール | 取得内容 |
| --- | --- |
| `merge_plan_list_generations` | 候補ID、世代ID、世代番号、内容ID、元のコミット、競合の選択。任意で `offset` と `limit`。 |
| `merge_plan_get_generation` | `generationId` で指定した世代の詳細と、保存されたファイルのパス・バイト数。任意で `offset` と `limit`。 |
| `merge_plan_read_file` | `generationId` と `path` で指定したファイルの内容。ブロックを読むには、パス一覧から `project.source.json` を指定します。 |
| `merge_plan_current_playtest` | プレーヤーに読み込まれている候補ID、世代ID、内容ID、セッションID、開始・照会時刻。プレーヤーを閉じると `playtest` は `null`。 |

ファイルの `offset` と `limit` の単位はバイトです。`nextOffset` がある場合は次の読み取りに渡してください。`encoding` は `utf8` または `base64` です。UTF-8文字の途中で区切られた範囲も `base64` でバイト列を取得できます。

MCPの読み取り元は保存済みの候補です。試遊時の変数値やログ、編集中のブロックは共有の対象外です。共有と読み取りによって、作品フォルダやGitの状態は変更されません。「MCP共有を停止」で資格情報を無効にできます。作品の切り替えやDesktopの再読み込み、ウィンドウを閉じた場合も共有が終了します。

切り戻す場合は `TW_PLUS_DESKTOP_MERGE_PLAN_MCP=0` でDesktopを再起動します。保存済みの候補はそのまま使えます。
