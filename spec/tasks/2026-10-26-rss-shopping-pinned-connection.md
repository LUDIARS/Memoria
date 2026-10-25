# RSS・買い物取得の接続先固定

Actio: `actio:a125d7cf-306e-4433-a461-36955a005ab3`

## 変更と再利用

RSS の `fetchFeedXml` と買い物の `fetchPublicHtml` は各 hop で既存の
`fetchPinnedPublicResponse` を使う。DNS 全件の公開アドレス検査後、その IP を
HTTP(S) の lookup に固定する。元 URL による Host/TLS 検証を維持する。
通常 fetch と事前検査の組合せは接続時の再解決を防げないため置き換える。
`fetchPublicText` は RSS と買い物それぞれの応答処理が異なるため採用しない。

手動リダイレクト、最大 5 回、RSS の 5MiB・買い物の 4MiB 上限、既存の
content-type 判定・文字コード・deadline・ヘッダを維持する。
共有接続層と同じ identity 要求・圧縮応答拒否を適用する。
不正 URL と DNS 失敗は既存の BlockedUrlError 分類を維持する。
共有ヘルパー、url-preview、サービス設定は変更しない。

## 契約

C-21 feedPinnedEvidence(): RSS の全ホップが検査済み IP にのみ接続し XML を維持する
C-22 shoppingPinnedEvidence(): 買い物取得の全ホップが検査済み IP にのみ接続し商品抽出を維持する

契約と述語は実装変更前に作成し、Augur contract-wrap を挿入した。
観測対象はメモリ内 DNS/HTTP を注入して本番関数を呼ぶ probe。

## 検証計画

`augur plan --kind bug_fix` の investigate_first / regression 方針。
既存コードで検査と通常 fetch の再解決が分離していることを確認した。
旧実装の再現実行は実 DNS に到達するため行わず、注入経路を用意して回帰を固定する。
ホストごとの再解決で内部 IP を返す偽 DNS と、接続 lookup を呼ぶ偽 HTTP を使い、
各 hop が公開 IP のみを使うこと、RSS 本文・商品価格・最終 URL を確認する。
不正 URL・内部 IP・非 HTTP URL と DNS 失敗のエラー分類も検証する。
対象は rss/sources、rss/url-guard、shopping/crawler、shopping/public-url の単体テスト。
実サービス・外部ネットワークは使わない。

## 検証結果

関連 4 ファイルの単体テストは 17/17 成功。C-21/C-22 は各 1 回観測、違反 0。
既存 C-8 も 4 回観測、違反 0。他領域の既存契約は対象外のため実行していない。
初回は依存解決の準備不足で tsx の読み込みに失敗した。worktree 内から既存の
依存ディレクトリを参照する junction を設定後、上記の限定実行が成功した。
既存依存へのインストールや書き込み、サービス操作、全体テストは行っていない。
