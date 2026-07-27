# 支出ログ

Quaestorから同期した支出・レシート情報を、通常の活動ログと分離した
`sensitive_spending_logs`へ保存する。

## データ分類

- `privacy_class`: `sensitive.financial_location`
- `retention_scope`: `local_only`
- `llm_relay_scope`: `diary_only`
- 保存先: Local MemoriaのSQLiteのみ
- Corpus、Multi Hub、Discord、AI Hub、日記以外のLLM処理には含めない

LLMがこの情報を参照・リレーできる経路は日記生成だけとする。この初期実装では
同期・保存・参照の境界を提供し、日記生成への自動投入はまだ行わない。

## 主な属性

- 日付と発生時刻
- 金額と通貨
- 店名、Google Place ID（判明時）、Google Maps参照URL
- GPS相当情報（緯度、経度、精度）
- 決済手段（カード、銀行、現金、各種Pay）
- 購入品と分類（食品、衣料品、おもちゃ、未定）
- 経費算入予定、按分率、QuaestorルールID
- 元の取引ID・レシートID

同一通貨だけを合計する。突合済レシートとカード明細はQuaestor側で1レコードに統合する。
