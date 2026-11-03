# qs ロック版の限定更新

関連タスク: actio:61730700-4935-4f03-9eb6-cf6bc8f41b06

`server` と `mcp-server` の qs 6.16.0 を 6.16.2 に固定する。
server の body-parser は `~6.16.0`、mcp-server の body-parser は
`^6.15.2`、express は `^6.14.0` を要求し、いずれも 6.16.2 を許容する。
親パッケージ・要求レンジ・overrides は変更しない。

C-25 qsLockEvidence(registry, base): 両ロックの qs だけを既存親レンジ内の 6.16.2 に更新し、公開 registry の配布 URL・integrity と一致する。

検証計画: Augur plan の現状固定を、実ロックと変更前コミットの構造比較で具体化する。
既存 Augur contract runtime を再利用し、正しい差分を受理し、旧版・親更新・integrity 破損を拒否する。
アプリの挙動変更がないため単体・統合・起動テストは実施しない。
公開 registry のメタデータ取得だけを行い、install と lifecycle script は実行しない。

依存の採否: qs は親パッケージが使う複雑なクエリ解析であり、標準 URLSearchParams
や小さな自作への置換は互換性を変えるため採用しない。新規依存と重複追加はない。
6.16.2 は従来と同じ BSD-3-Clause で、間接依存も同じ 2 件。
install/postinstall はなく、開発用スクリプトも実行しない。
検証は認証情報を付けない公開 registry GET と、shell を介さないローカル git show
だけを使う。製品の起動経路や通信は変更しない。

PR #3606 の審査指摘に対応し、この更新専用の契約・証跡収集・検証実行を
既存の `service-runtime` ドメインと `application` 層に位置付ける。
対象は今回追加した 3 ファイルだけとし、ドメインの仕様参照に本書を追加する。
ロックファイルと検証コードは既存コミットの内容を維持する。
