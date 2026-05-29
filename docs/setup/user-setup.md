# ユーザが手動で設定する必要があるもの

Memoria は単体で動くが、 外部サービス / 自分の端末 と連携する機能は **ユーザが
鍵やパス / 個別 hook 等を設定しないと取得できない**。 ここでは「ユーザがやらない限り
Memoria には来ないデータ」 を 1 箇所にまとめる。

| 種別 | 必要設定 | 設定先 | 取れるデータ |
|---|---|---|---|
| **GitHub commits** | Personal Access Token (classic 推奨) | 設定 → 📝 日記 → GitHub 連携 | 日記 / 週報の commit 集計 |
| **git ローカル post-commit** | hook の install ([git-hooks.md](./git-hooks.md)) | global core.hooksPath or per-repo | ローカル commit (= push 前) を活動として記録 |
| **Claude Code prompt** | UserPromptSubmit hook ([claude-code-prompt.mjs](../../server/hooks/claude-code-prompt.mjs)) | `~/.claude/settings.json` の hooks | Claude Code への指示を「開発活動」 として記録 |
| **Codex CLI prompt** | UserPromptSubmit hook ([codex-prompt.mjs](../../server/hooks/codex-prompt.mjs)) | `~/.codex/hooks.json` の `UserPromptSubmit` | Codex CLI への指示を「開発活動」(kind=codex_prompt) として記録 |
| **OwnTracks GPS 軌跡** | iPhone OwnTracks → MQTT key | 軌跡タブ → 🔑 key → OwnTracks の設定 | 移動軌跡 / 作業場所自動判定 |
| **Steam ゲームプレイ** | Steam ID (+ optional Web API key) | 設定 → 🔌 連携 → Steam | ゲームタイトル + playtime 自動取得 |
| **Google Geolocation API** | API key | 環境変数 `MEMORIA_GOOGLE_GEOLOCATION_API_KEY` | PC の WiFi スキャン → 概略位置 |
| **WiFi 位置 (Electron 限定)** | Electron 実行 (= Windows のみ自動) | デスクトップアプリ起動 | 起動端末の WiFi SSID から作業場所 |
| **Web Push 通知** | ブラウザの通知許可 + PWA インストール (iOS) | 起動チュートリアル / 設定 → 🔔 | 日記完了 / ディグ完了等の push |
| **Cernere SSO (Multi server)** | Cernere ログイン | 設定 → 📦 データ / Hub → マルチサーバ接続 | 辞書 / dig / ブクマ / 実装自慢 / 作業場所 を Hub に共有 |
| **LLM プロバイダ** | OpenAI API key or Claude CLI / Gemini CLI / Codex CLI のインストール | 設定 → 🤖 AI | 要約 / dig / 日記 / 食事解析等 |
| **claude CLI (Windows)** | `CLAUDE_CODE_GIT_BASH_PATH` 環境変数 | `.bashrc` / `setx` 等 | Memoria Server から claude CLI 呼び出し |
| **Steam app name 解決** | API key 不要 (= keyless Store API) | 自動 (=設定不要) | uninstalled な appid の name 解決 |
| **iOS PWA 通知** | Memoria を「ホーム画面に追加」 してアプリ起動 | iOS Safari → 共有 → ホーム画面に追加 | iOS で通知許可ダイアログを出すための前提 (iOS 16.4+) |
| **Memoria Hub への接続** | (Cernere SSO + 同左) + マルチサーバ URL | 設定 → マルチサーバ → 接続 | Hub から各種データ download / share |
| **食事写真の Vision 解析** | LLM provider のうち vision 対応モデル | 設定 → 🤖 AI → meal_vision task | 食事写真 → 食品 / カロリー推定 |
| **Steam 起動間隔** | 設定 → 連携 → Steam → 取得間隔 (分) | 設定 | 短くするほど精度↑ / 通信量↑ |
| **環境変数 (server)** | `MEMORIA_PORT` / `MEMORIA_DATA` / `MEMORIA_CLAUDE_BIN` / `MEMORIA_DIG_CONCURRENCY` 等 | shell env / .env | 各 default の上書き |

## 一気にやる場合の順番

1. Memoria local backend 起動 (`npm run dev`、 `desktop` or 手動)
2. ブラウザで `http://localhost:5180` を開いて起動チュートリアル
3. 設定 → 🤖 AI → 1 つでも provider を選ぶ
4. 設定 → 🔌 連携 → GitHub PAT / Steam ID を入れる
5. `node server/hooks/setup.mjs` で git post-commit hook 導入 ([git-hooks.md](./git-hooks.md))
6. `~/.claude/settings.json` に Claude Code hook を追加
   - (任意) Codex CLI を使うなら `~/.codex/hooks.json` の `UserPromptSubmit` に
     `node .../server/hooks/codex-prompt.mjs` も追加し、 codex 側で `/hooks` を trust
7. (任意) Cernere ログイン → マルチサーバ接続
8. (任意) iOS で「ホーム画面に追加」 → 通知許可
9. (任意) OwnTracks 設定 → GPS 軌跡

それぞれ独立に設定可能。 手を抜いた箇所は単にその機能のデータが入らないだけで、
他機能は通常通り動く。

## AI に頼む場合のプロンプト例 (= 全部委託)

```text
Memoria を私の環境にフルセットアップしてください。 docs/setup/user-setup.md
を参照し、 以下の前提で進めてください:

- OS: <Windows / macOS / Linux>
- 既に Memoria local backend は <http://localhost:5180> で動作している
- 使う LLM provider: <claude CLI / OpenAI API / その他>
- GitHub PAT は <持っている / これから作る>
- Steam: <使う / 使わない>
- OwnTracks: <使う / 使わない>
- iOS PWA: <使う / 使わない>
- マルチサーバ: <使う / 使わない>

1 ステップずつ、 私が確認 (= 「次へ」 と返す) してから次に進めてください。
途中で API key 等を求められたら私が手動で入れます。
```
