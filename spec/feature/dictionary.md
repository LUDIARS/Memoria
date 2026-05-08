# dictionary — 個人辞書

## 概要
ユーザが集めた用語 + 定義 + 出典 (bookmark / dig / wordcloud) を紐付ける個人辞書。 ワードクラウドや dig 結果から「この単語をマイ辞書に登録」 で生やせる。

## ユースケース
- 専門用語に出会ったら定義 + ソース URL をワンクリックで蓄積
- ブクマ / dig / wordcloud のどれから来たかを `dictionary_links` で追跡
- Hub 経由で他人と用語集を共有 (受信側は `term (@owner)` で名前空間分離)

## 画面 / 入口
- `🗄 データベース` タブ → サブビュー `辞書`
- ワードクラウド画面の「用語に登録」 ボタン (`/api/dictionary/upsert-from-source`)
- dig セッション詳細 / bookmark 詳細からの追加

## データ
- [dictionary_entries](../db/dictionary.md) — term (UNIQUE) / definition / notes / owner_user_id / shared_at
- [dictionary_links](../db/dictionary.md) — entry_id × (cloud / dig / bookmark) × source_id の many-to-many

## API
- [dict.md](../api/dict.md) — `/api/dictionary*` (CRUD + 検索) / `/api/dictionary/:id/links` (出典操作) / `/api/dictionary/upsert-from-source`
- 関連: [multi.md](../api/multi.md) `/api/multi/share` (kind=dict) / `/api/multi/download`

## シェア可能か
**Hub-shareable** (明示的シェア操作のみ)

シェアされるフィールド:

| field | 内容 |
|---|---|
| `term` | 用語 |
| `definition` | 定義 |
| `notes` | 補足 |

シェアされない:
- `dictionary_links` (出典)。 出典 URL 自体は bookmark / dig をシェアしないと相手から見えない
- ローカルの owner_user_id 等のメタ

ダウンロード時の挙動: 受信側ではユニーク衝突を避けるため `term` を `term (@owner_user_name)` に namespace 化して保存。

経路: **write-relay-only via Imperativus**。 `POST /api/multi/share` (kind=dict) → `markDictionaryShared` → Hub `/api/shared/dictionary`。

## プライバシー観点
- **個人データを保持するテーブル**: `dictionary_entries` / `dictionary_links` (どの語に興味を持ったかの履歴)。 単独だと識別力低いが、 dictionary_links で bookmark / dig との結びつきが見えるとプロファイルになる。
- **LLM プロバイダに送る情報**: 辞書機能自体は LLM 呼び出しを行わない。 用語抽出は wordcloud (cloud_extract) 経由なのでそちら参照。
- **共有時に外部に出ない情報**: 出典紐付け (bookmark / dig / cloud の id)、 owner_user_id などのローカルメタ。
- **削除時の挙動**: `DELETE /api/dictionary/:id` で `dictionary_entries` 行 + CASCADE で `dictionary_links` を削除。 Hub にシェア済の場合は Hub 側に残る。
