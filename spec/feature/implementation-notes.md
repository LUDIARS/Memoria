# implementation-notes — 実装自慢ノート

## 概要
「これ実装したぞ」 系のドヤノートを product / title / good_points / bad_points + attachment (URL / image / video / code) で蓄積。 shareable フラグ ON のものだけ Hub に共有可能。

## ユースケース
- 自分のプロダクトの面白い実装をライブラリ化前にメモ
- スクリーンショット + GitHub URL + good/bad で技術ブログ素材
- Hub にシェアしてエンジニア仲間に技術自慢

## 画面 / 入口
- `🗄 データベース` タブ → サブビュー `実装自慢`
- 編集モーダル: paste / drop で attachment_type を自動分類 (画像→`screenshot`, github URL→`github` 等)

## データ
- [implementation_notes](../db/impl.md) — product / title / good_points / bad_points / attachment_type / attachment_value / shareable / shared_at

## API
- [impl.md](../api/impl.md) — `/api/implementation-notes*` (CRUD) / `/api/implementation-notes/:id/share` (ローカル shareable 印付け)
- 関連: [multi.md](../api/multi.md) `/api/multi/share` (kind=implementation_note)

## シェア可能か
**Hub-shareable** (`shareable=1` 必須)

シェア時は `note.shareable = 1` でないと 409 を返す (二段階フロー)。

シェアされるフィールド:

| field | 内容 |
|---|---|
| `product` | プロダクト名 |
| `title` | ドヤポイント |
| `good_points` | 良かった点 |
| `bad_points` | しんどかった点 |
| `attachment_type` | screenshot / github / article / video / code / other |
| `attachment_value` | URL / data:URL / コード片等 |

注意: `attachment_value` に `data:URL` (画像 base64) を入れると、 そのまま Hub に上がる。 機微画像を含めないかは投稿前にユーザ責任。

経路: **write-relay-only via Imperativus**。 `POST /api/multi/share` (kind=implementation_note) → Hub `/api/shared/implementation-notes`。

## プライバシー観点
- **個人データを保持するテーブル**: `implementation_notes` (product 名から所属組織が判明する場合あり)、 `attachment_value` に embedded された画像 / コード片 / GitHub URL は内部リポを示す可能性。
- **LLM プロバイダに送る情報**: 機能自体は LLM 呼び出しなし。 LLM に流れるのは ユーザが diary 生成時等の prompt に impl note を含めた間接的経路のみ。
- **共有時に外部に出ない情報**: `shareable=0` のノート全体、 `shared_at` 印付け前のもの。
- **削除時の挙動**: `DELETE /api/implementation-notes/:id` で行削除。 attachment が data:URL の場合は DB 行と一緒に消えるが、 Hub にシェア済なら Hub 側に残る。
