# npm モジュール切り出しポリシー — 単一依存モジュールの Lapilli 化

## neco への確認事項 (先頭に明記)

Task #491 (タイトル「Memoria から単一依存 npm モジュールを切り出すポリシー」) の
**元 detail 本文はタスクトラッカーのデータ破損で失われており、タイトルのみ残存**している。
本ドキュメントは blackbox 切り出し (#242) と Augur `@ludiars/log-weaver` の前例から
逆算した **一般ポリシー** であり、特定モジュールの切り出し計画ではない。

もし #491 起票時に具体的な対象モジュールが念頭にあったなら、次の具体的切り出し作業を
スコープするためにそれを明示してほしい。現状このドキュメントだけでは「次に何を切り出すか」
は決まらない。

## 0. 対象範囲 — サービス切り出しとの違い

このポリシーは **npm パッケージ 1 個単位の切り出し** (= 単機能のユーティリティ/エンジンを
Lapilli の 1 package にする) を扱う。`Memoria/CLAUDE.md` の「ナレッジ系ドメイン
(bookmarks / notes / dig 等) の独立サービス化」ドクトリンとは **別物** なので混同しないこと。

| | npm モジュール切り出し (本ドキュメント) | ドメイン独立サービス化 (CLAUDE.md) |
|---|---|---|
| 単位 | 単機能のライブラリ/エンジン 1 個 | ドメイン全体 (`server/bookmarks/` 等) |
| 移行先 | Lapilli の `packages/<name>` (npm package) | 別リポジトリの独立サーバ |
| 依存関係 | ゼロ依存 or interface 越しの DI のみ | Memoria 固有 DB / API に依存したまま可 |
| 起動プロセス | 変わらない (Memoria server に import されるだけ) | 新しいプロセス/デプロイが増える |
| 典型例 | `server/blackbox` → `@ludiars/blackbox` | bookmarks/notes/dig → 将来の独立サービス |

両者は連続的ではない。ドメインサービス化の準備として npm 切り出しを経由することはあるが、
「npm 切り出し = サービス化の一歩」と自動的に見なさないこと。切り出したモジュールが
Memoria 固有の DB schema や API 形状に依存し続けるなら、それは npm 切り出しの対象外。

## 1. いつ切り出すか (トリガー基準)

以下を **すべて** 満たすとき、npm 切り出しを検討する。

1. **Memoria 固有依存がゼロ**、または interface (DI) 越しに切り離せる
   (blackbox の `RuleStore` / `DecisionLedger` / `LlmFallback` のように、
   永続化・LLM 呼び出しを注入可能にしてある)。
2. **他の LUDIARS リポで使える見込みが 1 つ以上ある**
   (blackbox は「天気ドメインが最初の適用例、ゲームの敵AI/ドロップ抽選にも転用可」と
   設計時から明記されていた。log-weaver も Augur 単体でなく org 横断の
   「安定運用プローブ」として設計された)。
3. **クリーンな interface 境界が既にある**、または小さな変更で作れる
   (関数シグネチャ・型が Memoria の DB row / Express req/res に直結していない)。
4. **安定している** — アクティブなローカル改修が続いている最中のコードは切り出さない。
   API を数週間変えていない、仕様が固まっている、が目安。

## 2. いつ切り出さないか (時期尚早な抽象化を避ける)

- **「今は依存が 1 個だけ」だけでは切り出し理由にならない**。他リポでの利用見込みが
  無い/不明なら、Memoria 内に置いたままでよい。使われる保証のない汎用化は無駄な
  間接層を増やすだけ (YAGNI)。
- **Memoria のドメインモデルに密結合しているコード** は、たとえインターフェースを
  切っても「切り出す価値」がない。例: `diary_entries` の schema を直接触るコード、
  `.foundation-form` に依存する UI コンポーネント。これらは Memoria の外では
  意味を持たない。
- **切り出しのために先に大改修が要る場合は、まず改修 PR を切り出しとは別に出す**。
  「切り出しやすくするための DI 化」と「実際の切り出し」を 1 PR に混ぜない
  (blackbox も #199 でエンジンを実装 → #242 で切り出し、の 2 段階だった)。
- 個人データを扱うコードは要注意。Memoria の個人データはローカル SQLite に閉じる方針
  ([[project_personal_data_rule]]) があるため、切り出す場合もパッケージ側に
  個人データを漏らす設計にしないこと (store は interface 越しの注入のままにする)。

## 3. 境界ルール — blackbox を雛形にする

`spec/feature/blackbox.md` §0「切り出し境界」に実際に使われた境界ルールが残っている。
要点:

- **永続化は interface 越し**: `RuleStore` / `DecisionLedger` という抽象を切り、
  SQLite 実装はパッケージに同梱しつつ Memoria 固有の DB 接続そのものは注入する
  (`makeSqliteBlackBox(db)`)。パッケージ側が「どの DB か」を知らない。
- **外部呼び出しは関数注入**: LLM 呼び出しは `LlmFallback` という関数型で DI する。
  パッケージは「LLM を呼ぶ」ことだけ知り、どの LLM 設定/API キーを使うかは呼び出し側
  (Memoria) の責務のまま。
- **入力はフラットな値のみ**: `FeatureMap = Record<string, number | string | boolean>`
  のように、Memoria の生オブジェクト (DB row, req body) をそのまま渡さず、
  シリアライズ可能なプリミティブに一度落としてから渡す。これによりパッケージは
  Memoria の型を import しなくて済む。
- **移行 (migration) ロジックもパッケージに同梱**: 旧 schema からの migration
  (`ensureBlackboxSchema()`) を呼び出し側に残さず、パッケージが「自分の schema は
  自分で保証する」形にする。

この 4 点が揃っていれば「単一依存でも安全に切り出せる」境界と判断できる。揃っていない
箇所があれば、それは切り出しの前にまず対応すべき負債として扱う (§2 参照)。

## 4. 移行手順 (チェックリスト)

blackbox 切り出し (commit `4826eff`, PR #242) を手順の precedent とする。

1. **Lapilli 側にパッケージを作る**: `Lapilli/packages/<name>/package.json` を新設。
   `@ludiars/<name>`、`type: module`、`main`/`types` は `dist/`、
   `exports` で公開エントリを絞る (blackbox は `.` と `./file` の 2 系統、
   log-weaver は `.` と `./auto`)。`publishConfig.registry` は GitHub Packages。
2. **コードを移す**: `server/<name>/*.ts` を `Lapilli/packages/<name>/src/` へ移動し、
   §3 の境界 (interface 越しの永続化・関数注入) が守られているか確認しながら
   Memoria 固有の import を消す。
3. **Memoria 側に workspace dep として追加**: `server/package.json` の
   `dependencies` に `@ludiars/<name>: ^0.x.x` を追加。CI 側は
   `@ludiars` scope の GitHub Packages 認証 (`packages:read` + `NODE_AUTH_TOKEN`,
   `server/.npmrc`) が必要 (blackbox PR で `.github/workflows/ci.yml` に追加した設定)。
4. **呼び出し側を書き換える**: `server/db.ts` 等の旧 CREATE TABLE / 型定義を撤去し、
   パッケージが export する `make<Name>(db)` のようなファクトリで束ねる形に置換。
   ルーティング層 (`routes/*.ts`) は互換性が要るなら旧フィールド名を新形式に
   マッピングする薄い層を残す (blackbox は `{state}` 正 + 旧 `{enabled}` 互換を維持した)。
5. **テスト検証**: `tsc` (server/frontend) + 既存テストスイート + `eslint` +
   ビルド (`esbuild` 等) が green であることを確認。可能なら fresh DB での
   起動スモークテスト (schema 作成・基本 API 疎通) も行う。
6. **旧パスを削除**: `server/<name>/` を撤去。移行後の設計正本は Lapilli 側の
   `DESIGN.md` (または README) に移し、Memoria 側の spec ドキュメントは
   「移管済」の注記 + Memoria 固有の利用方法 (API/UI 束ね) のみ残す形にする
   (`spec/feature/blackbox.md` 冒頭の移管注記を参照)。

## 5. 前例まとめ

- **`@ludiars/blackbox`** (Memoria → Lapilli, PR #242, 2026-07-02):
  成長型ルールエンジンを `RuleStore`/`DecisionLedger`/`LlmFallback` の interface 越しに
  切り出した本ポリシーの主参照例。設計正本は Lapilli 側 `DESIGN.md`、
  Memoria 側 `spec/feature/blackbox.md` は利用方法のみ残す形に整理済み。
- **`@ludiars/log-weaver`** (Augur → Lapilli, 姉妹例): 「安定運用プローブ」を
  AOP スタイルで注入するライブラリ。単一消費元 (Augur) から始まりつつ org 横断で
  使う前提の設計だった点が blackbox と同じパターン。単一消費元でも
  「単発利用前提の埋め込みコード」にはしない、という同じ判断基準の傍証になる。
