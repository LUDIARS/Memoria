# Memoria — 仕様書

このディレクトリは Memoria 各モジュールの設計・要件をまとめた仕様書群。コードと並行して維持され、新機能追加 / 仕様変更 PR では該当ファイルを必ず更新する。

## 構成

| パス | 内容 |
|------|------|
| [`events.md`](events.md) | peer adapter で公開するコマンドと発行イベント (LUDIARS 内サービス間契約) |
| [`frontend/`](frontend/) | Web UI と Chrome 拡張の仕様 |
| [`server/`](server/) | バックエンド (`service/`) のモジュール別仕様 |

## 仕様書のルール

1. **要件記述のフォーマット**: 各モジュールは「目的」「責務」「データフロー」「依存」「契約 (API/イベント)」「制限」のセクションを持つ。
2. **実装との同期**: 実装変更時に同 PR で仕様も更新する (CI ではチェックしないので意識的にやる)。
3. **将来の話**: 未実装の予定は `## ロードマップ` 節に分けて、実装済みの記述と混ざらないようにする。
4. **モジュール単位**: 1 モジュール 1 ファイルが原則。横断的な事項 (auth, content filter 等) は別ファイルで全モジュールから参照する。

## 関連ドキュメント

- [プロジェクト README](../README.md) — インストール・運用手順
- [LUDIARS Cernere](https://github.com/LUDIARS/Cernere) — 認証 + peer relay 基盤
- [LUDIARS Imperativus](https://github.com/LUDIARS/Imperativus) — Memoria イベントを受け取るフロントエンド
