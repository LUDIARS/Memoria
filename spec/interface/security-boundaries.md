# 管理・ブックマーク・保存 HTML・要約の境界

タスク参照: `actio:9ecb314b-65e8-4c19-9ed5-f74220113417`

## 資格情報

Infisical / サービス環境に用途別の十分に長いランダム token を設定する。値を同じにしない。

| 変数 | 用途 | クライアント |
| --- | --- | --- |
| `MEMORIA_ADMIN_TOKEN` | `/api/llm/config` GET/PATCH | `X-Memoria-Admin-Token` |
| `MEMORIA_BOOKMARK_TOKEN` | `/api/bookmark`、`/api/bookmarks/from-url`、再要約 | `X-Memoria-Bookmark-Token` |
| `MEMORIA_SUMMARY_CLAUDE_TOKEN` | 要約専用 Claude OAuth credential | サーバから要約子プロセスだけへ |
| `MEMORIA_SUMMARY_API_KEY` | 要約専用 OpenAI/Gamma credential | サーバから設定済み provider だけへ |

直接 loopback の socket、loopback Host、同じ Origin を満たす既存ローカル UI は token 不要。Origin の無い直接ローカル CLI も許可する。proxy の転送ヘッダではこの例外を得られない。外部 Web UI は権限エラー時に用途別 token を入力し、タブのメモリだけに保持する。

拡張はオプション画面の「ブックマーク取込 token」に設定する。token は Chrome 同期ストレージへ送らず、この端末の local storage に保存する。既存 server URL と投稿形式は維持するが、拡張の Origin はローカル UI と異なるため token 設定が必要。新サーバへの移行前に拡張を更新・設定する。LAN/Tailscale/MCP などの外部クライアントも取込ヘッダが必要。外部クライアント全件の実地互換性は未確認。

管理 token は拡張へ設定しない。既存 `MEMORIA_AGENT_TOKEN`、位置情報 ingest key とは別物。待受は既存どおり。CF Access など既存の外側の認証を置き換えない。

## 取得と表示

URL は HTTP(S) のみ、userinfo 禁止。各 redirect で全 DNS 応答を検査し、private/loopback/link-local/tailnet 等を拒否する。接続 lookup を検証済み IP へ固定し、TLS 証明書検証には元 hostname を使う。redirect は最大 5、取得は既定 30 秒、本文は最大 4 MiB。別 origin に転送すると資格情報ヘッダを除去する。identity 応答を要求し、非対応の圧縮応答は明示エラーとする。

保存 HTML の直接閲覧にも CSP `sandbox`（許可フラグ無し）を付与。script、ネットワーク要求、form、親画面の操作、アプリの同一 origin 権限を与えない。外部画像・外部 CSS は表示されない。元データ自体は保持する。

## 要約の実行

bookmark の `summarize` は agent 実行と分離した text-only runner を使う。Claude は専用 credential と一時 HOME/cwd、tools 空、strict MCP 空、settings sources 空、hooks 無効、session 保存無し。終了時に一時領域を削除する。Codex/Gemini を設定していた場合、安全な実行境界が未確認のため明示エラーになる。対応 provider へ管理者が変更する必要がある。一般 agent API の挙動は変えない。

API provider は tools を渡さず、tool_calls 応答を拒否し、redirect を追わない。専用資格情報が不足しても agent CLI に fallback しない。Gamma は資格情報無しのローカル API も明示設定可能。

個人単一利用者モデルの共通予算として同時数 2、1 分 10 開始、入力 40000 文字、出力 1 MiB、API 最大 4096 token、実行最大 180 秒。複数人の identity ごとの利用枠はこの個人サービスでは導入していない。CLI 自身の OS sandbox は新設しておらず、ツール・設定・環境・資格情報の分離を実施する。
