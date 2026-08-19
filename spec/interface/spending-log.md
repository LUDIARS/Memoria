# 支出ログAPI

すべて同一マシンからのリクエスト専用で、`Cache-Control: no-store`を返す。
loopbackのほか、同一端末上のAccess転送はHost/Origin一致時だけ許可する。
任意のLANクライアントは拒否し、Multiモードでも`local_only`としてHubへ転送しない。

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
loopbackから外部へのHTTP redirectも追従しない。
同期範囲はQuaestorを正本として置換するため、削除・突合解除された元レコードも反映される。
保存時のLLMリレー範囲は本人同意で決まる (`diary_only` / `diary_and_spending_advice`)。

## 参照

`GET /api/spending-logs?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&source_kind=receipt|transaction`

- `source_kind=receipt`: レシート
- `source_kind=transaction`: クレカ・銀行等の取引明細
- 省略時は両方

レスポンス:

- `records`: 支出ログ
- `llm_relay_scope`: 現在保存されている実効リレー範囲
- `daily_summaries[].total_amount`: その日の通貨別消費額
- `daily_summaries[].places[]`: 場所別の消費額

複数通貨は合算せず通貨別に表示する。Mapsリンクは`http`/`https`だけを受け付ける。

## 滞在記録の補強

`GET /api/spending-logs/stays?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`

支出ログと`gps_locations`を日付・時刻・座標で突き合わせ、日別のタイムラインを返す。
結果は保存しない。対象は本人の`user_id=me`だけで、時刻なしレシートの日付判定は
GPS既存APIと同じ端末ローカル日付を使う。`nearest_gps`は時刻と場所名だけを返し、
照合に使った座標・住所はレスポンスへ重複して載せない。

`days[].entries[].status`:

- `confirmed_by_gps`: 同時刻のGPS点が300m以内にある
- `time_matched`: 時刻は合うが座標では確認できていない (支出側に座標が無い場合を含む)
- `conflict`: 同時刻のGPS点が2km以上離れている (通販・後日計上の可能性)
- `no_gps`: 前後30分にGPS点が無い

`entries[].enriched_place_name` は、GPS側に場所名が無く支出側の店名で補強できる場合だけ入る。

## 傾向集計

`GET /api/spending-logs/analytics?date_from=&date_to=&currency=`

LLMを通さない決定的な集計。同意の有無に関係なく利用できる。
複数通貨がある場合は件数が最も多い通貨を既定値にし、画面の通貨選択で切り替えられる。

- 合計 / 1日平均
- 入力源別・分類別・支払手段別・店別・曜日別
- 月次推移と前月比
- 定期課金の候補 (同一店舗・同一金額が2ヶ月以上)
- 突出支出 (分類中央値の3倍以上)
- 予定支出 / 想定外支出

## 消費傾向の助言

`GET /api/spending-logs/advice/settings`
`PUT /api/spending-logs/advice/settings`

```json
{
  "consent": true,
  "base_url": "http://127.0.0.1:11434/v1",
  "model": "gemma4:12b"
}
```

`consent`を切り替えると保存済みの行の`llm_relay_scope`も即時に更新する
(`relay_scope_updated`に件数を返す)。

`GET /api/spending-logs/advice` — 設定と生成済みレポート一覧。

`POST /api/spending-logs/advice` — 助言を1本生成する。

- 未同意なら`403`
- 送信先がloopbackでない、モデル未設定、ローカルLLM不達なら`502`
- loopbackから外部へのHTTP redirectは追従しない
- プロンプトに載せるのは集計結果のみ。個々の品目名・座標は載せない
- 店名・支払手段名は引用データとしてエンコードし、その中の命令文を指示として扱わない
