# 支出ログAPI

すべて直接loopback接続専用で、`Cache-Control: no-store`を返す。
Multiモードでは`local_only`として拒否され、Hubへ転送されない。

## 同期

`POST /api/spending-logs/sync`

```json
{
  "date_from": "2026-07-01",
  "date_to": "2026-07-31"
}
```

省略時は端末ローカル日付の直近30日。最大366日。
接続先はExcubitorが注入する`QUAESTOR_URL`だけを使い、loopback URL以外は拒否する。
同期範囲はQuaestorを正本として置換するため、削除・突合解除された元レコードも反映される。
全レコードのLLMリレー範囲は`diary_only`であり、他のLLM処理へは渡さない。

## 参照

`GET /api/spending-logs?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`

レスポンス:

- `records`: 支出ログ
- `daily_summaries[].total_amount`: その日の通貨別消費額
- `daily_summaries[].places[]`: 場所別の消費額
