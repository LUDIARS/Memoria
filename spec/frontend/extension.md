# Chrome 拡張 (MV3)

## 目的

ユーザーが見ている Web ページを **ワンクリック** で Memoria サーバーへ送り、要約キューに乗せる。
タブ切替時の URL ping でアクセス頻度を集計する。

## 構成

| ファイル | 役割 |
|---------|------|
| `extension/manifest.json` | MV3 manifest (permissions, content_scripts, background, options) |
| `extension/popup.html / popup.js` | ツールバーアイコンの popup — 「このページを保存」ボタン |
| `extension/content.js` | 全ページに常駐するフローティング保存ボタン (Shadow DOM) |
| `extension/background.js` | service worker — `/api/access` ping、popup/content からのメッセージ中継、認証ヘッダー付与 |
| `extension/options.html / options.js` | サーバー URL / トラッキング無効化 / Bearer JWT 設定 |

## 権限

```jsonc
"permissions": ["activeTab", "scripting", "storage", "tabs", "alarms"],
"host_permissions": ["http://localhost/*", "http://127.0.0.1/*"]
```

`host_permissions` を `localhost` に絞ることで CORS と権限要求の角度を最小化。本番 (online) で外部サーバーを叩く場合は options のサーバー URL を別ホスト名にし、ユーザーが拡張を更新する際にホスト権限を許可する。

## 状態 (chrome.storage.sync)

| キー | 用途 | 既定 |
|------|------|------|
| `server` | Memoria HTTP API のベース URL | `http://localhost:5180` |
| `disableTracking` | true で `/api/access` 送信を停止 | `false` |
| `authToken` | Bearer JWT (Cernere の service_token) | `''` |
| `buttonPos` | フローティングボタンの `{right, bottom}` | `{24, 24}` |

## フローティングボタン (content.js)

- `http(s)://*` 全ページに content script として注入 (チェックボックス UI で options から無効化はしない — `disableTracking` は ping のみに作用)
- Shadow DOM (`mode: open`) でページの CSS 干渉を遮断
- ドラッグで位置移動 (4px 閾値、storage に保存)
- ホバーで `×` 閉じるボタンが浮上 — 当該タブセッション限定で非表示
- クリックで `chrome.runtime.sendMessage({ type: 'memoria.save', payload })` → background が fetch
- トースト通知 (3 秒、ok / err / 既存重複)

## 背景 service worker (background.js)

- `chrome.tabs.onActivated` / `onUpdated` / `windows.onFocusChanged` / 5 分 alarm でアクティブタブ URL を `/api/access` に POST
- 同一 URL は 60 秒スロットル
- `disableTracking=true` のときは ping を完全に止める
- popup/content からの `memoria.save` メッセージを受けて `/api/bookmark` に転送、Authorization ヘッダーを付与

## オプション画面 (options.html)

UI:
- サーバー URL (`url` input)
- 「URL をトラッキングしない」チェック
- Bearer JWT (`password` input)

すべて `chrome.storage.sync.set` で保存され、即座に背景 SW / popup / content が反映する。

## 制限

- `chrome://`, `chrome-extension://`, Chrome Web Store, PDF ビューア等では content script が動かない (Chrome の方針)
- service_token の自動発行はしない — Cernere admission flow で発行されたトークンを手動で options 入力する想定。将来 `/api/auth/cernere/exchange` 的なフローを足す。

## ロードマップ

- popup から「online サインイン」ボタンで Cernere 認証ポップアップを起動 → service_token を自動取得
- 拡張のバッジ (アイコン右上) で要約待ち件数を表示
- ホットキー対応 (Alt+S で保存)
