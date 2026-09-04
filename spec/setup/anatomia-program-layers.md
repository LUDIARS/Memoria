# Anatomia のプログラムドメイン層宣言 (`.anatomia/layers.json`)

Anatomia のドメイン判定は 2 軸ある。

| 軸 | 何を表すか | 正本 |
|---|---|---|
| ビジネスドメイン | 「何の機能か」(ai-hub / books / clever-search …) | `spec/domains/*.domain.json` |
| **プログラムドメイン (層)** | **「どの層か」(presentation / application / domain-logic / infrastructure)** | **`.anatomia/layers.json`** |

このファイルは後者の正本。**リポジトリが持つ設定であって解析キャッシュではない**ので、
`.gitignore` の `.anatomia/*` から `!.anatomia/layers.json` で明示的に除外して追跡している。

## なぜ要るか

`layers.json` が無いと Anatomia は層を 1 つも決められず、変更された anchor が**全部**
「未分類 (`unclassified`)」として報告される。Revisor のレビューではこれが
`Anatomia dual-layer (program): N changed anchor(s) unclassified` という非ブロック所見になる。

2026-08-31 の時点で PR #1136 / #1154 / #1164 がそれぞれ 17 / 18 / 19 件の未分類 anchor を
出していたが、原因は個々の PR ではなく**このファイルが存在しなかったこと**だった。

## 書き方の注意 (踏むと分類が壊れる)

1. **glob はファイルパスに完全一致で当たる。** `*` は 1 階層、`**` は任意階層。
   前方一致ではないので `server/routes` ではなく `server/routes/*` と書く。
2. **記述順は効かない。** ローダーが glob 文字列でソートしてから先勝ちで評価する
   (`Anatomia/src/domains/program/config.ts`)。読みやすさのために層ごとに並べてよいが、
   優先順位を順序で表現してはいけない。
3. **したがって glob 同士を重ねない。** モジュール 1 つにつき `<dir>/*` を 1 本置き、
   入れ子のディレクトリには別途 1 本置く。`server/**` のような広い glob を 1 本置くと、
   ソート順しだいで `server/routes/*` を飲み込んで層が入れ替わる。
4. **サブモジュールの中も対象になる。** `server/plugins/memoria-plugin` は別リポジトリ
   (LUDIARS/MemoriaPlugin) だが、Anatomia は解析対象リポの `layers.json` しか読まないので、
   submodule を初期化した状態で解析すると、その中のモジュールも Memoria 側で宣言していないと
   未分類になる。現在は `server/plugins/memoria-plugin/**` の 6 モジュール分を宣言している。

## 層の割り当て方針

| 層 | 入るもの |
|---|---|
| `presentation` | 人や外部クライアントに向いた面 — `server/routes/`、`server/api/types/`、`server/public/`、`server/discord/`、`server/alexa/`、`extension/`、`desktop/src/`、`mcp-server/` |
| `application` | 起動・配線・オーケストレーション — `server/` 直下 (index / bootstrap / queue / notifications …)、`server/plugins/`、各種 scripts |
| `domain-logic` | 機能そのもの — `server/ai-hub/`、`server/books/`、`server/task-triage/`、`server/spending-log/` など |
| `infrastructure` | 永続化と外部 I/O — `server/db/`、`server/types/`、`server/lib/` (外部クライアント・OS サンプラ)、`server/mqtt/`、`server/owntracks/`、`server/local/` |

## 確認のしかた

```sh
node ../Anatomia/bin/anatomia.mjs domains program --repo .
```

上記は Anatomia と Memoria を同じ親ディレクトリに checkout した場合の例。別の配置では
`../Anatomia` を Anatomia checkout への相対パスに置き換える。

`unclassified: 0 module(s), 0 symbol(s)` になっていれば二層ゲートは通る。
モジュールを増やしたら (= 新しいディレクトリに実装を足したら) このコマンドを回して
0 を保つこと。ゲートではなくレンズなので、放置しても exit code は 0 のまま静かに増える。

## ビルド成果物を解析対象に入れない

Anatomia は **「未追跡だが `.gitignore` にも載っていない」ファイルを意図的に解析対象に含める**
(`Anatomia/src/fs/git-ignore.ts`)。そのため Electron のビルド出力
(`desktop/dist/`、`desktop/dist-release/`、`desktop/out/`) を ignore し忘れると、
`server/` 以下のコピーが丸ごと二重に解析される。

実測 (2026-09-04、ignore 追加前): 全 86 モジュール 8,635 シンボルのうち
**38 モジュール 3,958 シンボルが `desktop/dist-release/` のコピー**だった。
