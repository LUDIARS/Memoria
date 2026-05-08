# extension — Chrome 拡張 (現在ページ → Memoria への dispatch)

## 概要
ブラウザ右下に常駐する floating ボタン。 単純な「保存 (= bookmark)」 だけでなく、 現在開いているページの種別を検出して **3 つの追加ボタン**を出し分ける。

| 種別 | 検出条件 | ボタン色 | 追加アクション |
|---|---|---|---|
| AI chat | `chatgpt.com` / `chat.openai.com` / `claude.ai` / `gemini.google.com` | 紫 (`#7b3ff2`) | (1) ブックマーク + 会話を `external_chat_messages` に message 単位保存、 (2) 会話を md にまとめて Note 作成 |
| 実装自慢候補 | 設定で許可されたドメイン + キーワード一致 (例: `github.com` × `LUDIARS`) | 黄 (`#f6b73c`) | 「実装自慢として展開」 ボタンを bookmark ボタンと並列表示 |
| ショッピング | `amazon.co.jp` / `amazon.com` / `rakuten.co.jp` 等 | 緑 (`#3ac26a`) | 「タスク (ほしいものリスト) に追加」 ボタンを bookmark ボタンと並列表示。 押下で `tasks` に `category='買い物'` で insert |

検出は content script 内で `location.host` + `URL.pathname` + 設定取得した keyword リストの突合せで行う。

## ユースケース
- ChatGPT 等で長い議論をした後、 「保存」 ボタンで会話 + 結論をまるごと Memoria に取り込み、 後から検索可能にする
- GitHub の自分の PR / repo を見ているとき、 「実装自慢として展開」 で `implementation_notes` ドラフト画面を開く (タイトル / URL / good_points は前埋め)
- Amazon で気になる商品を見つけたとき、 ブクマせず純粋に「ほしいものタスク」 として翌週の買い物計画に回す

## 画面 / 入口
- 全 web ページ (manifest の content_scripts で `<all_urls>` 注入)
- 拡張 popup: 現在ページ種別 + 利用可能アクション一覧表示 + 「新ルールを追加 / 設定」 リンク
- 拡張 options: 実装自慢用キーワードルール / ショッピングドメインリスト編集

## データ
- [app_settings](../db/settings.md) (新キー) — `extension.impl_rules` (JSON) / `extension.shopping_domains` (JSON) / `extension.chat_domains` (JSON、 default 値あり)
- [tasks](../db/task.md) — ショッピングボタン押下時 `category='買い物'` で insert
- [implementation_notes](../db/impl.md) — 実装自慢展開時のドラフト保存先 (shareable=0 で insert)
- [external_chat_messages](../db/chat.md) — chat 取り込み時 1 message 1 行
- [notes](../db/note.md) — chat 取り込み時 (`also_create_note=true`) Note + ブロック群を作成

## API
- 既存: `POST /api/bookmark` (全ボタン共通の保存)
- 新規:
  - `POST /api/notes/from-chat` ([note.md](../api/note.md)) — chat → Note + external_chat_messages
  - `POST /api/extension/dispatch-hint` — 拡張からの「現在ページ種別をサーバ側で確認」 (現ルール一覧を返す)
  - `GET / PUT /api/extension/rules` — ルール (`impl_rules` / `shopping_domains` / `chat_domains`) 取得 + 更新
- 関連: `POST /api/tasks` (買い物カテゴリで insert), `POST /api/implementation-notes` (impl 展開時)

## 設定スキーマ
`app_settings.extension_rules_json` (JSON) で一括保持:

```ts
{
  chat_domains: Array<{
    host: string;          // 'chatgpt.com', 'claude.ai', …
    source: 'chatgpt' | 'claude' | 'gemini';
    enabled: boolean;
  }>;
  impl_rules: Array<{
    label: string;         // 'LUDIARS GitHub' 等
    host_pattern: string;  // 'github.com' or 'github.com/LUDIARS/*'
    keywords: string[];    // 'LUDIARS' 等。 OR 一致 (1 つでもページに含まれれば候補)
    enabled: boolean;
  }>;
  shopping_domains: Array<{
    host: string;          // 'amazon.co.jp'
    label: string;         // 'Amazon (JP)'
    enabled: boolean;
  }>;
}
```

デフォルト値はサーバ起動時に `app_settings` 未設定なら埋める (chat 主要 3 ドメイン + Amazon JP/COM + 楽天)。

## シェア可能か
**local-only**

extension の dispatch ルール自体は個人ローカル設定。 dispatch 結果として作られる bookmark / impl note / task / note は各自の feature 仕様に従う。

## プライバシー観点
- **個人データを保持するテーブル**: 直接は持たないが、 dispatch 結果として `external_chat_messages` (チャット本文)、 `notes` / `note_blocks` (チャット要約)、 `bookmarks` (URL + HTML スナップショット) に大量データを書く。
- **LLM プロバイダに送る情報**: 拡張側は LLM を直接呼ばない。 ただし `/api/bookmark` 経由で書かれたエントリは後段の summarize ジョブで LLM に送られる (chat-domain 由来でも同じ扱い)。 機微なチャットを保存する場合、 LLM 連携を OFF にしたい場合は [llm-config.md](llm-config.md) で個別無効化する。
- **共有時に外部に出ない情報**: 拡張ルール本体 (`extension_rules_json`)、 dispatch 経路で書いた raw データ (Hub に出るのは feature ごとの shareable フラグに従う)。
- **削除時の挙動**: 拡張側で「保存」 = サーバ側に書く。 取り消しはサーバ側 UI から各 feature の DELETE を呼ぶ。

## ボタン挙動マトリクス

| 状況 | 「保存」 (青) | 「Note 化」 (紫) | 「実装自慢」 (黄) | 「ほしいもの」 (緑) |
|---|:---:|:---:|:---:|:---:|
| 通常ページ | ✅ | — | — | — |
| AI chat ドメイン | ✅ (色は紫) | ✅ | — | — |
| impl ルール一致 | ✅ | — | ✅ | — |
| shopping ドメイン | ✅ | — | — | ✅ |
| chat × shopping (同時) | 紫優先表示 | ✅ | — | ✅ (両方出す) |

複数条件一致時は dispatch ボタンを最大 3 つまで縦積みで表示。 「保存」 ボタンの色は「最も上位の dispatch」 (chat > impl > shopping > 通常) の色を継承する。
