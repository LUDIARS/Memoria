# 支出ログ

Quaestorから同期した支出・レシート情報を、通常の活動ログと分離した
`sensitive_spending_logs`へ保存する。

## データ分類

- `privacy_class`: `sensitive.financial_location`
- `retention_scope`: `local_only`
- `llm_relay_scope`: `diary_only` または `diary_and_spending_advice`
- 保存先: Local MemoriaのSQLiteのみ
- Corpus、Multi Hub、Discord、AI Hubへは含めず、日記と明示同意したローカル消費助言以外の
  LLM処理にも渡さない

### LLMリレー範囲 (2026-08-19 拡張)

初期実装は`diary_only`固定で、日記生成以外のLLM経路を構造的に禁止していた。
消費傾向の助言を出すため`diary_and_spending_advice`を追加する。昇格は無条件ではなく、

1. 本人がMemoria側で明示同意する (`app_settings.spending_advice.consent`)
2. 送信先がloopbackのローカルLLMである

の2条件をどちらも満たすときだけ有効になる。同意していない行は`diary_only`のままで、
助言生成の入力から除外される。同意を取り消すと昇格済みの行は`diary_only`へ戻る。
Quaestorからの同期契約は`diary_only`だけを受け付け、外部データ自身による権限昇格は拒否する。

クラウドLLMへは渡さない。共通の`runLlm()`はプロンプト本文をConcordiaへ転送し、
provider未設定時にClaude CLIへフォールバックするため、この経路では使わない。

## 主な属性

- 日付と発生時刻
- 金額と通貨
- 店名、Google Place ID（判明時）、Google Maps参照URL
- GPS相当情報（緯度、経度、精度）
- 決済手段（カード、銀行、現金、各種Pay）
- 購入品と分類（食品、衣料品、おもちゃ、未定）
- 経費算入予定、按分率、QuaestorルールID
- 元の取引ID・レシートID
- 入力源 `source_kind`: `receipt` (レシート) / `transaction` (クレカ・銀行等の取引明細)

同一通貨だけを合計する。突合済レシートとカード明細はQuaestor側で1レコードに統合する。

## 助言レポート

`spending_advice_reports` に生成済みの助言を保存する。本文はLLM出力そのものなので、
元データと同じ`local_only`として扱う。

- 期間 (`date_from` / `date_to`)、通貨
- 送信先の表示名とモデル名
- 集計結果 (`analytics_json`)
- 助言本文 (`advice_markdown`)
- 対象件数、生成時刻

## 滞在記録との突合

滞在記録の補強結果は保存しない。`gps_locations`と都度突き合わせて返すだけで、
GPS側の行を書き換えない。本人 (`user_id=me`) の点だけを使い、公開する照合結果からは
不要な座標・住所を落とすため、retentionと個人データの露出は増えない。
