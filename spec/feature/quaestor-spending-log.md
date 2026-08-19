# Quaestor支出ログ同期

ユーザが同期APIを明示的に呼んだときだけ、Quaestorからカード・各種Pay・レシート情報を取得する。
バックグラウンド自動同期やGoogle Placesへの外部照会は行わない。

センシティブ情報は通常の`activity_events`へ登録せず、専用テーブルで
`sensitive.financial_location`属性として扱う。既存のAI Hub要約、Discord通知、
Corpus共有の対象からは構造的に外れる。

店のGoogle参照情報はQuaestorから渡されたMaps URLとGPS相当座標を保持する。
購入分類や経費予定を特定できない場合は`undetermined`または`null`のまま保存し、
Memoria側で推測を追加しない。

## 画面 / 入口

`📝 ログ` タブのサブビュー:

- `🧾 レシート` — その日のレシート (`source_kind=receipt`)。品目内訳を出す
- `💳 クレカ` — その日のクレカ・銀行等の取引明細 (`source_kind=transaction`)
- `💰 消費傾向` — 期間集計 (既定30日) と、同意済みならローカルLLMの助言

レシート / クレカの各行には滞在記録の突合結果をバッジで出す
(`📍 GPS 一致` / `🕒 時刻のみ` / `⚠ 位置ずれ` / `— GPS なし`)。

## 滞在記録の補強

支出ログは「いつ・どこに居たか」に加えて「何をしていたか」を持つ。GPS軌跡
(`gps_locations`) と突き合わせることで、

- GPS点だけでは名前の付かなかった滞在に店名を与える (`enriched_place_name`)
- 支出側に座標が無いレコードを、時刻一致でGPS点に対応付ける
- 同時刻のGPS点が離れている決済を`conflict`として区別する (通販・後日計上)

突合結果は保存せず都度計算する。GPS側の行は書き換えない。本人 (`user_id=me`) の点だけを
対象とし、時刻なしレシートは端末ローカル日付で照合する。

## 消費傾向の分析と助言

2段構えにする。

1. **決定的な集計** (`analytics.ts`) — 合計・分類別・支払手段別・店別・曜日別、
   月次推移と前月比、定期課金の候補、突出支出、予定/想定外の内訳。LLMを使わないので
   同意の有無に関係なく表示でき、同じ入力なら常に同じ結果になる。
2. **助言文の生成** (`advice.ts`) — 1 の集計結果だけをプロンプトに載せ、
   ローカルLLMに `傾向 / 節制できる支出 / 増やしてよい支出 / 次の1ヶ月の行動` の
   4見出しで書かせる。個々の品目名・座標・カード識別子はプロンプトに載せない。
   店名・支払手段名は引用データとしてエンコードし、含まれる文を命令として扱わせない。

通貨間の金額は合算・比較しない。複数通貨がある場合は件数が最多の通貨を既定表示し、
画面の選択で通貨別に集計と助言を切り替える。

### LLMリレー範囲の拡張 (2026-08-19)

初期実装は`llm_relay_scope: diary_only`固定で、日記生成以外のLLM処理を構造的に
禁止していた。助言を出すために`diary_and_spending_advice`を追加するが、拡張の条件を
2つとも満たすときだけ有効にする。

1. 本人がMemoria側で明示同意する (`spending_advice.consent`)
2. 送信先がloopbackのローカルLLM (既定 Ollama `http://127.0.0.1:11434/v1`)

共通の`runLlm()`は使わない。`runLlm()`はプロンプト本文をConcordiaへ転送し、
provider未設定時にClaude CLIへフォールバックするため、どちらも支出ログをMemoriaの外へ
出すことになる。助言経路は専用クライアント (`local-llm.ts`) を使い、

- 送信先を入口でloopback検証し、満たさなければ即エラー (フォールバックしない)
- HTTP redirectを追わず、loopback経由の外部転送も拒否する
- プロンプト本文をどこにも転送・ログ出力しない
- モデル未設定・ローカルLLM不達なら助言を出さずに失敗する

同意を取り消すと、昇格済みの行は`diary_only`へ戻り、以後の助言生成から外れる。

## モジュール構成

`server/spending-log/`

- `relay-policy.ts` — リレー範囲の判定 (昇格・許可)
- `settings.ts` — 同意と送信先設定の読み書き
- `schema.ts` — テーブル定義とCHECK制約の移行
- `store.ts` — 保存・取得・同意の一括反映
- `quaestor-client.ts` — Quaestorからの取得
- `analytics.ts` — 決定的な傾向集計
- `advice-prompt.ts` — 集計結果 → プロンプト整形
- `local-llm.ts` — loopback限定のLLMクライアント
- `advice.ts` — 助言生成と保存
- `stay-match.ts` — GPS軌跡との突合
- `router.ts` — 合成 + 同一マシン制限 / `sync-router.ts` / `insight-router.ts` / `advice-router.ts`

## 関連

- API: [spending-log.md](../interface/spending-log.md)
- データ: [spending-log.md](../data/spending-log.md)
- GPS: [gps.md](gps.md)
