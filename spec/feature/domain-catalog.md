# domain-catalog — ドメイン辞書

## 概要
訪問したドメイン (host) ごとに「これは何のサイトか / 何ができるか」 を AI で自動分類 + ユーザ編集可能なカタログ。 ブラウジング履歴の lazy enqueue + バッチ recatalog で網羅する。

## ユースケース
- visits タブで「このドメインは何だっけ」 を一目で確認
- `domain_private` フラグ付きドメインを日記処理から除外 (e.g. プライベート webmail)
- 訪問回数集計 + サイト種別分類で傾向タブのデータソース

## 画面 / 入口
- `🗄 データベース` タブ → サブビュー `ドメイン`
- 各ドメイン詳細 → AI 再分類 (`/api/domains/:domain/regenerate`)
- 一括投入 `/api/domains/recatalog-all` (force=true で既存も再分類)
- 訪問時に lazy enqueue: `recordAccess` / `upsertVisit` から `maybeQueueDomain`

## データ
- [domain_catalog](../data/page.md) — domain (PK) / title / site_name / description / can_do / kind / notes / user_edited / domain_private / status
- 関連: [page_visits / visit_events](../data/visit.md) (集計の入力)

## API
- [domain.md](../interface/domain.md) — `/api/domains*` (CRUD + 検索) / `/api/domains/from-url` / `/api/domains/:domain/regenerate` / `/api/domains/recatalog-all`

## シェア可能か
**local-only**

ドメインカタログ自体は Hub シェアできない。 公開 SaaS 一覧などと違って、 ユーザのブラウジング履歴に紐付くのでローカル限定。

## プライバシー観点
- **個人データを保持するテーブル**: `domain_catalog` (どのサイトに行ったかのリスト = 本質的にブラウジング履歴の蒸留)、 ユーザ編集 notes / user_edited フラグ。
- **LLM プロバイダに送る情報**: タスク `domain_classify` (Sonnet default) に **ドメイン名 + 取得したトップページの og: / meta** を送る。 ページ本文全体ではなく要約用ヘッダとトップ HTML 一部。
- **共有時に外部に出ない情報**: 全部 (シェア対象外)。
- **削除時の挙動**: `DELETE /api/domains/:domain` で 1 行削除。 lazy enqueue で再訪問時に再生成される (skip 対象 domain は `shouldSkipDomain` でガード = localhost / 127.0.0.1 等)。
