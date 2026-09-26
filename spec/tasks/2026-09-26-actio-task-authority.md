---
task: memoria-actio-task-authority
project: Mm
kind: implementation
created: 2026-09-26
memory_links: []
---

# Actio をタスクの正本にする

neco の依頼: Memoria の全タスクを Actio へ移し、Memoria は Actio から取得する。
Actio の既存 Memoria 互換スキーマを再利用し、独立したタスクスキーマを追加しない。

完了条件:
- 完了済み・目標を含む全タスクを重複なく移行し、移行元 ID と日時を保持する。
- Memoria の表示・更新・内部タスク利用は Actio API を使う。
- 日記・レビュー・Discord 等の既存数値 ID 参照を維持する。
- 接続障害を空一覧や旧 DB への書き込みで隠さない。
- 移行元は保全し、全件照合してから取得元を切り替える。

調査根拠: Memoria main ed8b3dd、Actio modules/task/personal.ts と routes.ts、
Actio DESIGN-memoria-task-port.md。Praeforma は Mm/At 未登録。
Anatomia context --project memoria で spec/feature/hub-shell.md §8 と task API を照合した。

実施記録（2026-09-26）:
- 全2,854件（todo 1,011 / doing 5 / done 1,838）と94カテゴリを既存Actio APIへ移行。
- 完全な元レコードをpluginPayload.memoriaに保持し、全件・カテゴリ・移行元の不変を照合済み。元SQLiteは保全。
- カテゴリAPIの既存スキーマ未適用を確認し、Actioに既に定義されたuser_preferences DDLのみ適用して再開。
- 静的型検査は既存mainと同じHono依存型不一致1件のみ。追加の型エラーなし。
- 回帰テストを追加・非同期化へ追従したが、セッション規則により単体・統合・起動テストは未実行。
- Memoria本体への取得先切替の反映はRevisor審査・マージ後。切替直前に元データの変更がないことを再確認する。

Revisor #2009 初回審査: 単体テスト・型検査は成功。lintがdb.tsの未使用TaskRow import 1件で失敗したため除去し、再審査へ提出。Augur台帳とAnatomia分類・仕様リンクの所見は非ブロックとして残る。
