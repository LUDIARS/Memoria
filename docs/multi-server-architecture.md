# Memoria 二層アーキテクチャ — Local Server / Multi Server

## 目的

これまでの `MEMORIA_MODE=local|online` を「ローカル機能のフルセット」と「共有用のシェアハブ」という 2 つの**別モード**として明確に分離し、両者を 1 リポジトリで管理する。

| | ローカルサーバ (Local) | マルチサーバ (Multi) |
|---|---|---|
| 主目的 | 個人の知識ベース | 全員で共有する辞書・ディグ・ブクマのハブ |
| DB | SQLite (single file) | **Postgres** |
| デスクトップアプリ | あり (Tauri) | なし |
| 認証 | なし (シングルユーザ) | **Cernere SSO** |
| アクセス履歴 / 日記 / 週報 / ドメイン辞書 / 作業キュー | あり | **なし** |
| 共有可能なリソース | — | **辞書 / ディグる / ブックマーク** の 3 つ |
| サーバ自動起動 | 0:00 cron | 不要 |
| デプロイ形態 | 個人 PC | 共有インフラ (Cernere の隣) |

---

## ユースケース

1. **個人利用**: ローカルサーバ単体で完結。今までと同じ。
2. **シェア**: ローカルから「シェア」ボタンを押すと、選択した辞書エントリ / ディグセッション / ブックマークがマルチサーバへ送信され、誰でも閲覧可能になる。
3. **ダウンロード**: マルチサーバの誰かのリソースを自分のローカル DB に「ダウンロード」して取り込む。
4. **接続**: 「マルチサーバに接続」ボタンで Cernere 認証 → マルチサーバの API に対してローカル UI から検索・閲覧できる。

ユーザ情報を持たない (= ローカル単独利用) 場合のオーナーは「自分」とみなす。

---

## 認証フロー

### 1. ローカル → マルチへの接続初期化

1. ユーザがローカル UI で「マルチサーバ URL」を設定
2. ローカルが `GET <multi>/api/auth/cernere` を叩く → Cernere の OAuth フロー (PKCE) を開始
3. Cernere のコールバック URL で **マルチサーバ** が JWT (HS256, 有効期限 30 日) を発行し、ローカルへリダイレクト
4. ローカルは JWT を `app_settings.multi_jwt` / `app_settings.multi_user_id` / `app_settings.multi_user_name` に保存
5. 以後ローカル → マルチの通信はすべて `Authorization: Bearer <JWT>` で行う

### 2. マルチサーバ側の権限

- `cernere.user_id` の値をオーナーキーとして使う
- Cernere のロール: `user` / `moderator` / `admin`
  - user: 自分の投稿の CRUD のみ
  - moderator: 他ユーザの投稿を非表示にできる
  - admin: 全削除 + マルチサーバの DB メンテ

ロール情報は JWT のクレームに乗せ、マルチサーバが API ゲートで判定する。

---

## 共有可能リソースのスキーマ統合

ローカル DB のスキーマを **正本** として扱い、マルチ DB はその上位互換 (= ローカルの全カラム + ユーザ情報) として持つ。

### 共有テーブル → ユーザ情報追加カラム

すべての共有可能テーブルに以下を追加:

```sql
ALTER TABLE bookmarks         ADD COLUMN owner_user_id TEXT;
ALTER TABLE bookmarks         ADD COLUMN owner_user_name TEXT;
ALTER TABLE bookmarks         ADD COLUMN shared_at TEXT;     -- 共有元から見た送信時刻
ALTER TABLE bookmarks         ADD COLUMN shared_origin TEXT; -- 'local' or '<multi-server-id>'
-- 同様に dictionary_entries, dig_sessions にも追加
```

ローカル DB でも同じカラムを持つ (NULL 許可)。NULL = 自分のもの。

### マルチでのみ存在するメタ

```sql
CREATE TABLE share_log (
  id            BIGSERIAL PRIMARY KEY,
  resource_kind TEXT NOT NULL,           -- 'bookmark' | 'dig' | 'dict'
  resource_id   BIGINT NOT NULL,
  shared_by     TEXT NOT NULL,
  shared_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_origin TEXT
);
```

---

## API 仕様

### マルチサーバ API (Cernere JWT 必須)

| Method | Path | 内容 |
|---|---|---|
| POST | `/api/auth/cernere` | OAuth コールバック; JWT 発行 |
| GET | `/api/me` | JWT を検証して user_id / role / display_name を返す |
| **bookmarks** |
| GET | `/api/shared/bookmarks` | 全公開ブクマ (簡易ページネーション) |
| POST | `/api/shared/bookmarks` | シェア (= ローカルからの import) |
| DELETE | `/api/shared/bookmarks/:id` | 自分のシェアの取り下げ (admin/mod は他人も) |
| **dig sessions** |
| GET | `/api/shared/digs` | |
| POST | `/api/shared/digs` | |
| DELETE | `/api/shared/digs/:id` | |
| **dictionary** |
| GET | `/api/shared/dictionary` | |
| POST | `/api/shared/dictionary` | |
| DELETE | `/api/shared/dictionary/:id` | |
| **moderation (admin/mod)** |
| GET | `/api/shared/moderation/log` | |
| POST | `/api/shared/moderation/hide` | |

### ローカルサーバ API (新規)

| Method | Path | 内容 |
|---|---|---|
| POST | `/api/multi/connect` | マルチサーバ URL を保存 → OAuth リダイレクトを返す |
| POST | `/api/multi/disconnect` | JWT を破棄 |
| GET | `/api/multi/status` | 接続中か / user / role / token 残期限 |
| POST | `/api/multi/share` | `{kind, id}` を選択して JWT 経由でマルチに POST |
| POST | `/api/multi/download` | `{kind, remote_id}` をローカルにインポート |
| GET | `/api/multi/proxy/...` | マルチの GET をプロキシ (CORS 回避 + 認証付与) |

---

## UI 計画

### ローカル UI に追加するもの

- **AI 設定パネル**にマルチ接続セクション (URL + 接続状態 + Cernere 名 + ロール + 切断)
- **ブックマーク / 辞書 / ディグ** タブの各エントリに「📤 シェア」ボタン
- 接続中なら**ヘッダ**に新タブ「🌐 マルチ」が出現
  - マルチ → ローカルへの「📥 ダウンロード」ボタン
  - 検索 / フィルタ
  - ユーザ別フィード

### マルチサーバ UI

- ローカル UI と同じソースをそのまま使う (機能タブを動的に隠す)
  - `mode=multi` のときは: ブクマ / ディグ / 辞書 / ⚙ AI のみ表示
  - access history / 日記 / 週報 / ドメイン / イベント / 作業キュー は非表示
- ヘッダに Cernere ログインバッジ

---

## 実装フェーズ

### Phase 0: 基盤分離 (この PR の前提)
- `server/index.js` を `core/`、`local/`、`multi/` の薄い 3 層に分離
- `core/`: 共有可能なリソース (bookmark / dig / dict) のロジック
- `local/`: それ以外 (visits / diary / domain / events / page-meta / cloud / queue / uptime / GH 連携)
- `multi/`: Cernere 認証 + share API
- DB レイヤ: SQLite と Postgres の両方を抽象 (drizzle / raw / minimal mapper のいずれか)

### Phase 1: スキーマ拡張
- ローカル SQLite に owner_user_id / owner_user_name / shared_at / shared_origin を ALTER 追加
- Postgres マイグレーション (`migrations/multi/001_init.sql`)
- ローカル side のクエリは「NULL = 自分」を前提に動く

### Phase 2: マルチサーバ MVP
- Postgres + Cernere SSO
- /api/me, /api/shared/bookmarks (CRUD), /api/shared/digs, /api/shared/dictionary
- 公開時タイムスタンプ + シェア元 origin を記録
- ロール検証 (user/mod/admin)

### Phase 3: ローカル → マルチ「シェア」
- ローカル UI に 📤 シェアボタン
- POST /api/multi/share → JWT 付きでマルチに POST
- 成功時、ローカル側にも shared_at と shared_origin を立てる (重複シェア検出)

### Phase 4: マルチ閲覧 (ローカルから)
- 「🌐 マルチ」タブを実装
- /api/multi/proxy/* で GET をマルチに転送
- 共通 UI コンポーネント (BookmarkCard / DictEntry / DigSession) を再利用

### Phase 5: マルチ → ローカル「ダウンロード」
- 📥 ダウンロードボタン
- POST /api/multi/download → local DB に upsert (owner_user_id 含む)

### Phase 6: モデレーション
- admin/mod 用の hide / restore / 全削除エンドポイント
- マルチ UI に hidden 表示の切り替え

### Phase 7: デプロイ + Cernere 連携の実機検証
- マルチサーバの Docker compose (Postgres + Hono)
- Cernere の OAuth クライアント登録
- ローカル → マルチの E2E 通し

---

## 設計上の注意点

- **DB 抽象化**: 既存コードは `db.js` (better-sqlite3) を直接使っている。Phase 0 で薄いラッパー (`db()` が `query()` / `prepare()` / `transaction()` を返す) を作り、SQLite / Postgres どちらも実装する
- **JWT は HS256 で短命**: 30 日にし、refresh は再ログイン (Cernere の SSO に倣う)
- **CORS**: マルチサーバは `*` ではなく許可リスト方式に絞る
- **個人データ非保管ルール**: 個人プロフィールは Cernere 単一情報源。マルチ DB は user_id + display_name のスナップショットのみ保持 (rotate 可能)
- **既存 PR の整合**:
  - feat/multi-model (#29 マージ済) の AI 設定パネルにマルチ接続セクションを追記する (Phase 4 と同時)
  - feat/uptime-event-log (作業キュー) はローカル専用機能
- **共通 UI**: モード判定は `index.html` 配信時に `<meta name="memoria-mode" content="local|multi">` を埋めて FE で読む

---

## 通しコード対応

- ローカルサーバ: `Mm` (= 既存)
- マルチサーバ: `MmH` (Memoria Hub) 提案 — `LUDIARS/PROJECT-CODES.md` に追記予定
