# multi-hub — Memoria Hub プレゼンス (他人との共有)

## 概要
複数の Memoria Hub (公開 / 限定の OAuth 付きサーバ) に同時接続し、 ブクマ / dig / 辞書 / 実装自慢 / workplace を共有 / ダウンロードする多サーバ管理レイヤ。 個人ローカルの Memoria が **read-public + write-relay-only** の意味で Hub と関わる。

## ユースケース
- 複数 Hub (社内 + 公開 + 個人運営) に同時所属し、 シェア先を選んで POST
- 他人がシェアしたブクマ / dig をローカルに取り込み (HTML は受信時に再 fetch)
- Cernere SSO (OAuth → JWT) でログイン

## 画面 / 入口
- トップバー右上「マルチ」 スイッチ → マルチビュー (機能タブには出さない)
- 設定 → `データ / Hub` タブ: 接続先一覧 / 追加 / 削除 / 有効化 / 切断

## データ
- 接続情報は専用テーブルではなく `app_settings` の JSON:
  - `multi_servers` — 登録済 Hub 配列 `[{label, url, jwt, userId, userName, role, connectedAt}]`
  - `multi_active_urls` — 現在 active な URL 配列 (subset)
  - レガシーキー (`multi_url` 等) は初回読み込みで migrate
- 共有印付けは各テーブルの `shared_at` / `shared_origin` / `owner_user_id` 列

## API
- [multi.md](../api/multi.md) — `/api/multi/status` `/api/multi/servers*` `/api/multi/active` `/api/multi/connect` `/api/multi/finish` `/api/multi/disconnect` `/api/multi/proxy/*` `/api/multi/share` `/api/multi/download`

## シェア可能か
**Hub-shareable** (この機能自体が Hub 連携の入口)

`/api/multi/share` の対応 kind:
- `bookmark` ([bookmark.md](bookmark.md))
- `dig` ([dig.md](dig.md))
- `dict` ([dictionary.md](dictionary.md))
- `implementation_note` ([implementation-notes.md](implementation-notes.md))
- `work_location` ([workplace.md](workplace.md))

その他: workplace presence (場所スナップショット) は `shareWorkplacePresence` 経由で別 endpoint。

経路: **read-public + write-relay-only via Imperativus** (memory `feedback_memoria_online_flow.md`)。 直接書込みエンドポイントは PR #17 で削除済。 proxy passthrough も POST は `/api/shared/moderation/*` のみ許可 (それ以外は 403)。

## プライバシー観点
- **個人データを保持するテーブル**: `app_settings.multi_servers` (Cernere JWT、 user 情報を保持)。 各シェア対象テーブルの `shared_at` / `shared_origin` / `owner_user_id` 列で「これは誰のもので、 いつどこにシェアした」 を追跡。
- **LLM プロバイダに送る情報**: multi 自体は LLM 非依存。 シェア対象データ (bookmark summary 等) はシェア前の生成段階で LLM を経由しているが、 multi 経路は HTTP 転送のみ。
- **共有時に外部に出ない情報**: 各 feature 個別に規定 (HTML スナップショット / アクセス履歴 / dig raw_results / GPS 軌跡 / 食事 / 日記)。 JWT は **絶対に** Hub 間で共有されない。
- **削除時の挙動**: `POST /api/multi/disconnect` でローカル JWT クリア (Hub 側のセッションは残るので Hub 側 logout は別途必要)。 `DELETE /api/multi/servers` で server 行を抹消。 すでにシェア済データは Hub に残置 (削除する場合は Hub 側の moderation API)。
