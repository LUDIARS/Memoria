---
task: daily-code-additions
project: Memoria
kind: 実装
created: 2026-10-16
memory_links: []
---
# 作業量ログにコード追加行数を表示する

## 目的
neco の「作業量ログにコードを書いた量を追加して。GitHub から取れる情報でよい」という指示に対応する。

## 設計・完了条件
- 作業記録の開発量に JST 日別のコード追加行数・期間合計・集計済み日の平均を表示する。
- 既存の GitHub org/認証を使用し、既定ブランチの非マージコミットのファイル別 additions を集計する。
- 既存 code-volume と同じソースファイル判定を共有し、生成物を除外する。
- コミット単位の結果を SQLite に保存して再取得を抑える。取得失敗・検索上限・途中打切りは成功やゼロにしない。
- 既存 DB に列とキャッシュテーブルを追加し、旧日の未集計値を null として補完する。
- 既存コミット件数とマージ件数の集計は継続する。

## スコープ
server/dev-throughput、server/code-volume/file-filter.ts、server/shared、server/public/src/dev-throughput-view.ts、spec/feature/dev-throughput.md。
