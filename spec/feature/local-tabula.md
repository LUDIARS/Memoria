---
type: feature
title: Local Tabula embedded in Memoria
service: memoria
domain: knowledge-integration
status: implemented
---

# MemoriaのローカルTabula

## SPEC-MM-LOCAL-TABULA

Memoriaから開くTabulaは `services/tabula` にGit submoduleとして取得したローカルアプリ。
既定の `MEMORIA_TABULA_MODE=local` では、未ログインでもこの端末のメモを作成する。
本文・改訂本文・保存HTMLはファイル、メタデータ・索引・コメントはSQLiteに保持する。
保存先 `Memoria/data/tabula/` はsubmoduleのcheckout外で、submodule更新では触れない。

メモ画面の一覧・閲覧オーバーレイ・編集画面は同じローカルTabulaを使う。
リンクには `workspace=local` を付け、共有セッションが残っていてもローカル文書を開く。
AI記事・チャット・Notion・スクラップ済みブックマークの明示登録も同じ保存先を使う。
未設定・停止・不正な接続先はエラーを返し、遠隔TabulaやMemoria内の旧DBへ代替保存しない。

## SPEC-MM-TABULA-ACCESS

接続先は所有catalogが提供する `MEMORIA_TABULA_URL`。アプリ内にポートを直書きしない。
localの接続先はloopbackのみ。Memoria側は既存のAccess保護済みブラウザAPIと同じく、
ローカルの接続元socket・許可された公開Host・同一Originを確認する。Cloudflare Accessを
認証境界とし、Accessで許可されたMemoria利用者はこの設置先の個人メモを閲覧・編集できる。
CFヘッダーがあるだけでは許可しない。未知のHost、直接の遠隔socket、別Originは拒否する。
Tabula自体の直接loopback制約は維持し、秘密トークンをブラウザへ渡さない。

## SPEC-MM-TABULA-BROWSER-PROXY

編集リンク・取り込み後のリンクはMemoriaと同一Originの `/tabula/` を使う。
API応答ではその経路を現在のMemoriaの絶対URLに変換し、更新前から開いている画面や
絶対URLを前提にするクライアントとの互換性を保つ。公開Originは検証済みHostと転送protocolで決める。
別端末のブラウザをその端末自身の127.0.0.1へ誘導しない。保存先はMemoria設置先のまま。
中継は静的編集画面、ローカルセッション、ローカル文書APIだけを許可し、共有ログイン・
共有文書・任意の接続先は公開しない。共有利用は独立Tabulaの既存経路で行う。
書き込みには同一Originを必須とし、ブラウザのCookie・Authorization・転送ヘッダーは
上流に渡さず、固定loopback先への新規リクエストを構築する。セッションはlocalに固定する。
応答はキャッシュ不可とし、保存済みHTMLのsandbox CSPを維持する。

明示的に `MEMORIA_TABULA_MODE=shared` とした環境だけは、既存の `TABULA_URL` /
`TABULA_PUBLIC_URL` と読み取り・登録用の別トークンで共有連携する。
ローカルモードへの変更で既存ノート・共有DB・遠隔データを自動移行しない。

## SPEC-MM-TABULA-EMBEDDED-EDITOR

ノート一覧は高さを抑えた丸い行とし、タップで閲覧オーバーレイ、明示的な編集ボタンで
編集画面を開く。左スワイプは削除ボタンの表示だけを行い、削除は確認後に実行する。
ヘッダー直下の旧「Tabulaの記事も表示」チェック行は撤去する。リモート環境の操作は
この共通ヘッダーへ戻さず専用ページに分離する方針で、詳細仕様・実装は別途確定する。

Memoriaのメモ画面内にTabulaのフロントエンドをiframeで表示し、Memoriaのナビゲーションを
残したまま一覧・作成・編集を利用する。編集UIはTabula所有のまま複製しない。
初回表示時のみ接続先とローカルセッションを確認し、同一Originの `/tabula/` を読み込む。
Memoriaのタブ切替ではiframeを作り直さず、編集中の状態を保持する。
接続失敗は画面に表示し再接続を提供する。「別タブで開く」は補助導線とする。
iframeにだけ `embedded=memoria` クエリ識別子を渡し、Tabulaはローカル埋め込み時のみ
アプリヘッダーを省く。この識別子は表示専用で認証に使わない。別タブのURLには付けない。
Memoria側のTabula見出しと接続成功時の案内文は表示せず、接続中・失敗時の案内は残す。
明示設定されたsharedモードは既存の別タブ導線を維持し、外部Originを埋め込まない。
受入条件は、別タブへ移動せず一覧・作成・編集・保存を行えること、およびタブを往復しても
未保存の編集状態が保持されること。実ブラウザの受入確認は別途実施する。

## 導入と起動

1. 本体のmainで `git submodule update --init services/tabula`。非公開Tabulaを読めるGitHub認証が必要。
2. `npm --prefix services/tabula ci --include=dev`。実装コードは親repoのgitlinkで固定する。
3. Concordiaへ `memoria-tabula` のテストclaimを取り、Excubitorから起動する。
   catalogのcwdは本体 `Memoria/services/tabula`。worktreeのsubmoduleは起動しない。
4. Memoria自身への設定反映も、必要な場合に別claimでExcubitorから行う。
5. Memoriaのメモ画面で一覧・閲覧・編集・保存・再読込、AI記事・ブックマーク登録を確認。
   終了時にclaimを解放する。これらの実行権限は人間の指示範囲に従う。

共有認証のCernere停止中でもローカルメモは利用できる。旧ノートの本番移行は別途判断する。
バックアップはTabula停止中に `data/tabula` 全体を保存し、SQLiteとファイルを組で復元する。

## 検証

`server/tabula/connection.test.ts` はローカル接続先の選択、不正URLの拒否、共有設定との分離、
許可されたAccess中継と不正な接続の拒否を確認する。`server/tabula/browser-proxy.test.ts` は
編集経路の限定、認証情報の除去、同一Origin、HTML隔離、同一Originのリンクを確認する。
Tabula自身のファイル永続化・再読込・認証境界は
submodule側の登録テストが担当する。実ブラウザと再起動後の受入確認は本体反映後に別途記録する。
