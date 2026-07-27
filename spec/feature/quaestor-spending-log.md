# Quaestor支出ログ同期

ユーザが同期APIを明示的に呼んだときだけ、Quaestorからカード・各種Pay・レシート情報を取得する。
バックグラウンド自動同期やGoogle Placesへの外部照会は行わない。

センシティブ情報は通常の`activity_events`へ登録せず、専用テーブルで
`sensitive.financial_location`属性として扱い、LLMリレー範囲を`diary_only`に固定する。
これにより既存のAI Hub要約、Discord通知、Corpus共有や日記以外のLLM処理の対象から
構造的に外す。

店のGoogle参照情報はQuaestorから渡されたMaps URLとGPS相当座標を保持する。
購入分類や経費予定を特定できない場合は`undetermined`または`null`のまま保存し、
Memoria側で推測を追加しない。
