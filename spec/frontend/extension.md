# Chrome 拡張 (MV3)

## 目的

ユーザーが見ている Web ページを **ワンクリック** で Memoria に登録する。
個人運用は Memoria サーバーへ直送、共有運用は Imperativus 経由でリレーする。

## 動作モード (`storage.sync.mode`)

| mode | 送信先 | 認証 | アクセス追跡 |
|------|--------|------|--------------|
| `local` (既定) | `${server}/api/bookmark` | なし | `/api/access` を送る (ON 時) |
| `relay` | `${imperativusUrl}/api/relay/memoria/save_html` | Cernere `Bearer JWT` 必須 | 送らない (privacy) |

`relay` モードでは Memoria サーバーへ直接書き込むパスは消える。
すべての保存は Imperativus を経由し、Imperativus 内で `user_id` がトークンから強制設定される。

## 旧来動作との差分

| | v0.4 (PR #14) | v0.5 (本仕様) |
|---|---|---|
| online での書込 | 拡張から Memoria に Bearer 付き直送 | **削除** — Imperativus 中継のみ |
| options の認証欄 | `authToken` (Memoria 用 Bearer) | `authToken` (Cernere service_token) + relay モード切替 |

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

## Cernere SSO (v0.6.0+, options 画面)

`relay` モードのフィールドに **「Cernere でサインイン」** ボタンを追加。

```
[Cernere でサインイン] (chrome.identity.launchWebAuthFlow)
   ↓
Memoria の /api/mode から hints.cernere_base_url を取得
   ↓
${cernereBase}/api/auth/extension?service=memoria&redirect_uri=<chrome-extension://...>
   ↓
ユーザーが Cernere でログイン (popup)
   ↓
Cernere が redirect_uri に #token=<service_token> でリダイレクト
   ↓
拡張が token を chrome.storage.sync.authToken に保存
```

**前提:** Cernere 側に `/api/auth/extension` エンドポイントが必要。chrome-extension URL を redirect_uri allowlist に追加する設定も必要。これらが未対応な間は手動で token を貼り付ける。

権限: manifest に `"identity"` を追加。

## ロードマップ

- 拡張のバッジ (アイコン右上) で要約待ち件数を表示
- ホットキー対応 (Alt+S で保存)
- token 失効時の自動再 SSO
