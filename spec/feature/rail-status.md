# 関東全路線の運行情報 (rail-status)

Yahoo!路線情報の関東一覧 https://transit.yahoo.co.jp/diainfo/area/4 に掲載される全路線を取得する。
個別路線の選択や遅延路線だけの取得ではない。既存 briefing の取得元・通知は変更しない。

- 起動後に1回、以後5分間隔。路線別ページへ連続アクセスせず一覧1ページだけを取得する。
- 全事業者の表を解析し、路線URLをIDとして重複を除く。上部の障害サマリーを全路線表として扱わない。
- 路線名、事業者、状態、一覧の短い説明、路線リンク、掲載更新時刻、成功取得時刻を保持。
- 平常運転の完全一致だけを平常と扱う。補足情報付きや未知の状態は注意側に残す。
- 取得失敗・HTML変更・欠損時は前回成功値を維持し error/stale。初回未取得は pending。
  関東一覧として不自然な短い表、前回から1割を超える路線減少も欠損扱い。平常を推測しない。
- HTTP取得は15秒・2MiB上限、固定HTTPS URL、リダイレクト禁止。停止時にtimerと取得を中断する。
- GET /api/rail-status/kanto は version=1, source=yahoo-kanto, sourceUrl, status,
  fetchedAt, sourceUpdatedAt, stale, error, lines を返す。副作用・外部再取得はない。
- LaresはEx注入のMEMORIA_URLからこのAPIを読む。利用者のブラウザからMmやYahooへ直接取得しない。

メモリキャッシュのためMm再起動直後はpending。履歴蓄積や個人の路線設定は行わない。
動作確認・サービス再起動・マージは別途人間の実行指示後。単体テストは登録のみ。
