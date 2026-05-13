# Memoria — ライフログ & ナレッジ管理ツール

**学習効率化と可視化のための、ローカル完結型ライフログ & ナレッジハブ。**

「自分が何を読み・どこへ行き・何を考え・何を作ったか」を 1 か所に蓄え、
ローカル LLM がそれを要約・分類・関連付けして、**学んだことを忘れないように
可視化** する。 紙のノートと検索エンジンと活動ログの中間にいる存在。

## 何ができるか (ひと言で)

- **ライフログ**: ブラウザ履歴 / GPS 軌跡 / 開発活動 (commits + AI prompt) /
  食事 / 作業場所 / 開発者プレゼンスを 1 秒粒度で時系列保存
- **ナレッジ管理**: ブックマーク + 自動要約 + ドメイン辞書 + 用語辞書 +
  ノート (WYSIWYG) + ディグ (deep research) を相互リンクでつなぐ
- **学習可視化**: ワードクラウド / 関連語グラフ / GPS マップ / 活動バー /
  日記 + 週報 / おすすめ で「自分の理解の進み具合」を絵で見る
- **再利用**: 過去の dig や note を AI に喰わせて新しい調査の足場にする
  (= 学習が時間とともに加速する設計)

## なぜローカル完結か

学習ログ・行動ログ・思考ログは扱いを誤ると一番センシティブな情報になる。
Memoria は **個人データはすべて手元の SQLite に留まる** のが既定で、
外に出るのはユーザが意図的に「シェア」したエントリだけ。 Chrome 拡張で
保存したページの要約も、ローカルで動く Claude Code (`claude` CLI) で
生成されるため、本文が外部 API に渡らない構成も選べる。

---

## 3 つの動かし方

| | 誰向け | やること |
|---|---|---|
| **デスクトップアプリ** | ふつうのユーザ | インストーラを実行するだけ。Node もサーバも同梱、設定はアプリ内 UI |
| **server 直起動** | 開発者 / カスタム運用 | `npm install && npm start`。Chrome 拡張は別途 |
| **マルチサーバ (Memoria Hub)** | 共有ハブを建てたい人 | `docker compose up`。Cernere SSO 必須、ローカルとは別物 |

ふつうの利用は **デスクトップアプリ** で完結する。サーバを直に立てる
必要はない。

---

## A. デスクトップアプリ (推奨)

[Tauri 2.x](https://tauri.app/) 製。インストーラには Memoria サーバ + Node
ランタイムが同梱されているので、ユーザは何もインストールしなくていい。

### 1. インストール

リリースから配布物を取得 (Windows: `.msi` / macOS: `.dmg` / Linux: `.deb` 等)。
リリースがまだない場合の自前ビルドは [`desktop/README.md`](desktop/README.md) 参照。

### 2. 起動 → ほぼ何もしない

アプリを起動すると裏で Memoria サーバが立ち上がり、WebView が
`http://localhost:5180/` を表示する。

最低限必要な設定はぜんぶ右上 **⚙ AI** ボタンの中:

- **タスク別プロバイダ** (Claude / Gemini / Codex / OpenAI API)
- **CLI バイナリパス** (PATH に通っていない場合のみ)
- **🐚 Bash (Windows のみ)** — git-bash の絶対パス。Memoria が一般的な
  インストール先 (`C:\Program Files\Git\bin\bash.exe` 等) を自動検出
  するので、空欄のままで大体動く
- **OpenAI API Key** (gpt 系を使うとき)
- **🌐 マルチサーバ URL** (共有ハブに接続するとき)
- **🛠 ランタイム情報** (port / data dir / platform — 表示のみ)

これらはすべて SQLite の `app_settings` に保存され、再起動しても残る。
環境変数の手動設定は **不要**。

### 3. Chrome 拡張のインストール

ブラウザから保存するには Chrome 拡張が必要。

1. Chrome で `chrome://extensions`
2. 右上 **デベロッパーモード** ON
3. **「パッケージ化されていない拡張機能を読み込む」** → このリポの `extension/`
4. ツールバーに Memoria アイコンが出る

拡張のサーバ URL は既定で `http://localhost:5180`。

---

## B. server 直起動 (開発者向け)

CI を回したり、コードを触ったり、複数台で運用したいとき。

### 必要環境

| ツール | バージョン | 備考 |
|---|---|---|
| Node.js | 22 LTS+ | `--env-file-if-exists` を使う |
| npm | 10+ | Node 同梱 |
| Claude Code CLI | 最新 | `claude -p "hi"` が動くこと |
| Chrome | MV3 対応版 | 拡張を読み込むときだけ |
| Git for Windows | 任意 | Windows で `claude` CLI が `bash.exe` を要求するため |

### 起動

```bash
git clone https://github.com/LUDIARS/Memoria.git
cd Memoria/server
npm install
npm start
# → http://localhost:5180/
```

開発時は `npm run dev` (Node の `--watch` で自動再起動)。

### 設定はすべて UI から

`MEMORIA_PORT` / `MEMORIA_DATA` / `MEMORIA_CLAUDE_BIN` /
`CLAUDE_CODE_GIT_BASH_PATH` を環境変数で渡してもいいが、**通常は
不要** で、起動後 ⚙ AI 設定パネルから入力するだけで十分。env と UI
両方に値があれば UI の値が優先される。

ポート / データディレクトリだけは起動前に決まるので、変更したい場合
だけ env で渡す:

```bash
MEMORIA_PORT=6000 MEMORIA_DATA=/var/memoria npm start
```

### ディレクトリ構成

```
Memoria/
├ extension/        Chrome 拡張 (MV3)
├ server/           Node.js + Hono + better-sqlite3
│  ├ index.js       HTTP API + 静的配信
│  ├ db/            SQLite façade (Phase 0 シーム)
│  ├ db.js          スキーマ + クエリ (legacy export)
│  ├ claude.js      HTML→テキスト + claude CLI 呼出し
│  ├ llm.js         プロバイダ切替 (claude/gemini/codex/openai)
│  ├ dig.js         ディグ deep research
│  ├ diary.js       日記 + 週報
│  ├ domain-catalog.js  ドメイン分類 (site_name + できること自動推論)
│  ├ page-metadata.js   per-URL meta + kind
│  ├ wordcloud.js   ワードクラウド
│  ├ recommendations.js おすすめ
│  ├ queue.js       FIFO キュー
│  ├ local/         ローカル専用 (uptime, multi-client)
│  ├ multi/         マルチサーバ (Memoria Hub) — 別 Node プロセス
│  ├ types/         JSDoc から参照する .d.ts (Phase 1 TS migration)
│  └ public/        SPA (vanilla JS)
│
├ desktop/          Tauri ラッパ + bundle スクリプト
├ docs/             設計書 (multi-server-architecture.md, mobile-share.md)
├ mcp-server/       MCP として外部公開する実装 (Claude Desktop / Code 連携)
└ data/             ★ git 管理外 (HTML + SQLite)
```

---

## C. マルチサーバ (Memoria Hub) を建てる

辞書 / ディグ / ブックマークを **複数ユーザで共有** するハブ。Cernere
SSO で認証する別プロセス、Postgres 必須。個人利用の Memoria を 1 人で
動かすぶんにはいらない。

詳細は [`server/multi/README.md`](server/multi/README.md) と
[`docs/multi-server-architecture.md`](docs/multi-server-architecture.md)。

### docker compose で建てる (Phase 7)

```bash
cd server/multi
cp .env.example .env
# 編集: MEMORIA_CERNERE_*, MEMORIA_JWT_SECRET, MEMORIA_HUB_BASE,
#       POSTGRES_PASSWORD は最低限変更

docker compose up -d --build
docker compose logs -f hub
curl http://localhost:5280/healthz
```

ローカル Memoria の AI 設定 → 🌐 マルチサーバ にこの URL を入れて接続
すると、

- 自分のブックマーク / ディグ / 辞書を **📤 シェア**
- ハブの公開エントリを **🌐 マルチタブ** で閲覧
- 気に入ったエントリを **📥 ダウンロード** してローカルに取り込む
- admin / mod ロールがあれば **🛡 モデレーション** タブで非表示処理

ができる。本番 Cernere OAuth クライアント登録は
[`server/multi/README.md`](server/multi/README.md#cernere-oauth-クライアント登録ランブック)
の手順を参照。

---

## 主な機能 (学習効率化 × 可視化の観点で)

### インプットを溜める (ライフログ層)
- **ブックマーク**: Chrome 拡張で「いま見ているページ」を HTML ごと保存。
  ローカル `claude` CLI が要約・カテゴリ・タイトル・サイト分類を自動生成
- **アクセス履歴 / 訪問頻度**: per-URL の first/last/visit_count + 1 イベント
  単位の `visit_events` (日記 / トレンドの素材)
- **GPS 軌跡**: OwnTracks (iPhone) → Tailscale → Memoria。 停止区間は
  「始点 + 終点」 に圧縮して 1 日が地図 1 枚で見渡せる
- **開発活動**: git commit + Claude Code の UserPromptSubmit hook を
  `activity_events` に保存。 ブラウザ履歴が薄いスマホ開発日でも作業時間が
  推定できる
- **食事 / 作業場所 / プレゼンス**: 写真 EXIF + Vision API + GPS で食事を
  自動分類、 作業場所はジオフェンスで自動 check-in

### 知識を構造化する (ナレッジ層)
- **ノート (WYSIWYG)**: Notion 風ブロックエディタ。 テキスト / 見出し / リスト /
  Mermaid / テーブル / お絵描きキャンバス / フローティング注釈 / bookmark 埋込 /
  note→note リンク。 bookmark にスナップショット注釈 (canvas 上 floating) も可
- **ディグ (deep research)**: 1 つのテーマを (a) 生 SERP 即時表示 →
  (b) Claude WebSearch で AI overview → (c) WebSearch+WebFetch で深掘りまとめ
  の 3 段で取得。 過去の dig は再利用 (関連語グラフから「ここから派生 dig」)
- **辞書 (用語)**: dig / bookmark の中で出会った用語を「自分用辞書」 として
  自動蓄積。 source_kind=cloud/dig/bookmark で出典付き
- **ドメイン辞書**: 各サイトの `site_name` / `できること` / `kind` を Sonnet が
  自動分類 (= 「このサイトは何屋か」 を覚えなくて良くなる)

### 学んだことを可視化する (アウトプット層)
- **ワードクラウド + 関連語グラフ**: ブックマーク群 / dig 結果から抽象用語 ○ と
  具体名詞 □ を抽出、 力学レイアウトで配置。 ↪ 印で過去 dig 済の語を識別 →
  「自分が既に深く知っていること」 と「まだ未踏の語」 が一目で分かる
- **日記 (3 段生成) + 週報**: Sonnet が時系列の作業内容 → 決定論で commit/活動
  を集計 → Opus 1M でハイライト統合。 「昨日の自分が何を学んだか」 を毎朝
  受け取る
- **GPS / 活動バーチャート**: 1 日のタイムライン上に活動と移動が重なる
- **おすすめ**: 過去の閲覧傾向から「次に読むと面白そうなもの」 を提案
- **タスク AI 委託**: ノートのタスクを Claude / Codex / Gemini CLI に投げて
  「自分が手を動かさずに学習成果を再利用」 する経路

### 入出力の細部
- **マルチ LLM プロバイダ**: タスク別に Claude / Gemini / Codex / OpenAI を
  選択 (要約は Sonnet、 ハイライト統合は Opus 1M、 等)
- **PWA share_target** (Android) + iOS Shortcut で、 スマホからも瞬時に保存
  ([`docs/mobile-share.md`](docs/mobile-share.md))
- **モバイル GPS 受信** (内蔵 MQTT broker): OwnTracks (iOS/Android) を Tailscale
  経由で Memoria 同梱の broker に publish させて GPS 軌跡をリアルタイム取り込み。
  別途 Mosquitto / Legatus は不要 ([`docs/mqtt-vpn-setup.md`](docs/mqtt-vpn-setup.md))
- **PC WiFi → 位置情報**: モバイルが手元に無いときも `netsh wlan show networks` で
  BSSID を集めて Google Geolocation API に投げ、 10 分おきに `gps_locations` に
  PC 位置を積む (API key 設定時のみ有効、 Windows 限定)
- **WebPush 通知**: 日記 / dig / ブックマーク要約完了時にスマホへ push
- **マルチサーバ連携 (任意)**: Cernere SSO のハブに辞書 / dig / ブックマーク
  だけシェア。 個人ライフログ (GPS / 日記 / 履歴) は手元から出ない
- **作業キュー**: 重い AI ジョブ (要約 / dig / 日記生成) は FIFO シリアル化、
  進行状況を 1 画面で監視

## 環境変数 (省略可)

UI 設定が無い限り使うのは port / data dir くらい。

| 変数 | 既定 | 用途 |
|---|---|---|
| `MEMORIA_PORT` | `5180` | リッスンポート |
| `MEMORIA_DATA` | `<repo>/data` | DB と HTML 保存先 |
| `MEMORIA_DB_KIND` | `sqlite` | DB アダプタ (Phase 2 で `postgres` 追加予定) |
| `MEMORIA_CLAUDE_BIN` | `claude` | claude CLI のパス (UI が優先) |
| `CLAUDE_CODE_GIT_BASH_PATH` | (Windows のみ) | bash.exe 絶対パス (UI が優先) |
| `MEMORIA_GH_TOKEN` / `MEMORIA_GH_USER` | – | 日記が GitHub commits を引くとき (UI 優先) |
| `MEMORIA_MQTT_BROKER` | (起動) | `off` で内蔵 MQTT broker を停止 |
| `MEMORIA_MQTT_BROKER_PORT` | `1883` | broker port |
| `MEMORIA_MQTT_BROKER_HOST` | `0.0.0.0` | bind host (tailnet IP / `127.0.0.1` に絞ると安全) |
| `MEMORIA_MQTT_USERNAME` / `MEMORIA_MQTT_PASSWORD` | – | broker 認証 (両方設定で有効化) |
| `MEMORIA_GOOGLE_GEOLOCATION_API_KEY` | – | 設定すると PC WiFi → Google Geolocation API で位置取り込みを起動 (Windows のみ) |
| `MEMORIA_WIFI_INTERVAL_SEC` | `600` | WiFi 位置の実行間隔 |
| `MEMORIA_LEGATUS_WS` | (off) | `on` で旧 Legatus 経由 subscriber を opt-in (通常は内蔵 broker のみ) |

## ユーザがやる必要のある設定

各機能を使うには「ユーザ側で鍵を入れる / hook をインストールする」 など必須。
全部まとめた一覧 → [docs/setup/user-setup.md](docs/setup/user-setup.md)。

特によく聞かれるもの:
- git post-commit hook (= ローカル commit を活動ログに) → [docs/setup/git-hooks.md](docs/setup/git-hooks.md)
- Claude Code prompt hook → `server/hooks/claude-code-prompt.mjs` の冒頭コメント参照
- GitHub PAT / Steam ID / OwnTracks key / LLM provider → アプリの設定パネル

## ライセンス

MIT
