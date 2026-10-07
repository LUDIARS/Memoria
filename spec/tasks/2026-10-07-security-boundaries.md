# Memoria の取り込み・管理・要約の境界

Actio: `actio:9ecb314b-65e8-4c19-9ed5-f74220113417`。人間による M1–M4 実装指示の参照元。本文は転記しない。

## 設計

- M1: Tailscale/拡張の既存クライアントが存在するため待受を狭めない。LLM 設定は直接 loopback または専用管理 token、ブックマーク取り込みは直接 loopback または別の取込 token で認可する。Origin null、cross-site、非 JSON の変更要求は拒否する。拡張の token は端末ローカル保存とし、管理 token は渡さない。
- M2: public-fetch の redirect・サイズ・文字コード処理を再利用し、接続層のみ Node HTTP(S) の固定 lookup に置換。毎 hop で DNS 全件を検査して接続先を固定する。接続 pool を使わず、TLS の hostname 検証を維持。取得全体に deadline を設ける。
- M3: HTML 応答の CSP sandbox に権限許可を付けない。default-src/connect-src/form-action/base-uri を拒否し、静的インライン style と data image のみ許可。直接 URL 閲覧でも同じ応答ヘッダを適用。
- M4: bookmark summarize の CLI は専用 runner を使用。Claude の実行 tools・MCP・hooks を無効化し、毎回空の一時作業ディレクトリと専用資格情報・環境変数を使う。安全な tools 無効化を確認できない Codex/Gemini は明示エラー。API provider は tools を送信せず redirect を拒否。既存 agent API は変更しない。

## 契約・作業単位

2026-10-07追加受入: 人間が隔離回帰テストを許可。test:securityの4ファイルは当初7/7成功。M4の不足を補うためrunner/fetch/env/clockを任意注入可能にし、既定のproduction経路は維持。tool calls/redirect拒否、API1MiB応答とtimeout abort、fakeCLIの隔離cwd/env/tools・180秒/1MiB上限、一時dirの成功/失敗cleanup、同時2・毎分10のbudgetと失敗slot解放を追加し11/11成功。実LLM・ネットワーク・子プロセスは使わない。cc-test claim/release済み。C7–C10の2回合計観測は32/4/2/4、違反/predicate例外0。ログはworktree .tmp/security-regression-20261007/contracts.jsonl。

変更2moduleのfocused strict型検査とdiff check成功。全体tscは既存missing @types/better-sqlite3等で失敗し、read-onlyの本体dependency junctionへinstallしない。PR2518 mergedmainと元featureHEADは祖先でないがtreeは同一。追加差分だけをmain起点のfollowupworktreeへ移し、既存ActioIDを維持する。旧PRを再提出しない。

- C-7 hasScopedAccess(c, scope): 不透明 origin を拒否し、管理と取込の権限を別々に判定する。
- C-8 resolvePublicAddress(url): 全 DNS 応答が公開 IP のときだけ接続に固定する IP を返す。
- C-9 storedHtmlHeaders(): 保存 HTML に script・同一 origin 権限を与えない CSP sandbox を返す。
- C-10 textSummaryArgs(model): 要約 CLI の tools・MCP・hooks・セッション保存を無効にする。

契約モジュールを実装より先に追加。既存 C-1〜C-6 は別作業のため維持する。

## 検証計画

`augur plan --kind bug_fix` の regression/investigate-first 計画に従う。偽 token、注入 DNS/HTTP、メモリ DB のみで、管理拒否と正常取込、private/tailnet/redirect/rebinding、HTML 応答ヘッダ、要約引数・環境変数・制限を回帰テストにする。実サービスへの要求はしない。タスクの明示指示に従いテスト実行・サービス起動は行わず、実行証跡のない契約を充足済みとは報告しない。

## 実装・検証状態

- M1〜M4 実装と回帰テストを追加。実行コマンドは `cd server && npm run test:security`（未実行）。
- `augur inject apply --rule contract-wrap --diff-base HEAD`: C-7〜C-10 の 4 件を挿入。
- 変更 TypeScript の構文診断 0、拡張 3 ファイルの `node --check` 成功、`git diff --check` 成功。
- 既存依存を読み取り専用で利用した限定型検査では、変更に由来する型エラーを修正。残りは `better-sqlite3` 型定義不足など既存依存側の診断。通常の全体 typecheck 成功とは扱わない。
- `augur contracts report --acceptance --json`: C-7〜C-10 は not-called、既存 C-1〜C-6 は not-injected。実行未許可のため met=false のまま報告する。
- 配置先での資格情報設定、外部クライアント移行、ブラウザ隔離の実動確認、通常テスト、反映は未実施。
