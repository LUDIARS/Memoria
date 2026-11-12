# Memoria native (C++17)

Memoria の常駐プロセスを、Node から小さな C++ の実行ファイルへ 1 つずつ置き換えるための置き場。
目的は 2 つ: プロセスごとに抱える V8 のメモリ (約 60MB) を無くすことと、npm の依存ツリーを
取り込まないこと。

| ディレクトリ | 実行ファイル | 置き換える TS | 状態 |
|---|---|---|---|
| `owntracks/` | `memoria-owntracks` | `server/owntracks-server.ts` (`npm run owntracks`) | Linux で検証済み。Windows は未確認 |

TS 版は、ユーザの Windows 機で C++ 版を確かめ終えるまで残す (どちらを使ってもよい)。

## 依存

- C++17 コンパイラと CMake 3.16 以上
- OpenSSL 3.x と SQLite3 の開発パッケージ (Debian / Ubuntu: `libssl-dev libsqlite3-dev`)
- git サブモジュール (コミットを固定している):
  - `lib/portus` — [Portus](https://github.com/LUDIARS/Portus) の C++ 版 (イベントループ・JSON・ログ・`.env`・MQTT 3.1.1 の購読クライアント)
  - `lib/lapilli` — [Lapilli](https://github.com/LUDIARS/Lapilli) の `cpp/sqlite` (`lapilli::sqlite`)

取得・同梱したサードパーティのコードは置かない。テストの枠も自前 (`owntracks/tests/test.hpp`)。

## ビルド

```sh
git submodule update --init lib/portus lib/lapilli
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
ctest --test-dir native/build --output-on-failure
```

- ビルドディレクトリは `native/build*/` (gitignore 済み) かリポジトリの外に置く
- サブモジュールの代わりに別の checkout を使うときは `-DMEMORIA_PORTUS_DIR=<portus>` / `-DMEMORIA_LAPILLI_DIR=<lapilli>`
- テストは `MEMORIA_NATIVE_BUILD_TESTS` (native/ がトップのとき既定 ON)
- Lorica (社内のハードニング、任意): `-DMEMORIA_LORICA_DIR=<lorica>`。指定したときだけ CMake 3.24 以上が要る。
  Memoria のターゲットすべてと `lapilli_sqlite` に `lorica_harden_target` を当てる (Portus のターゲットには当てない)
- 変更したら通常のビルドに加えて、別のビルドディレクトリで
  `-DCMAKE_CXX_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer"` と `-DCMAKE_CXX_FLAGS="-fsanitize=thread"` でも ctest を通す

テストは 2 本:

- `memoria_owntracks_tests` — 設定・payload の受け入れ表・時刻の字面・UTF-8 の置き換え・`gps_locations` への書き込み
  (重複 / 圧縮 / 挿入、NULL の device、`samples_first_at`、列の型、スキーマの確認、BUSY)。期待値は Node 22 と TS 版の実際の出力
- `memoria_owntracks_e2e` — 実際の `mosquitto` (パスワード認証) と組み上げた実行ファイルを起動し、行が入ること・
  ブローカーの再起動後も入ること・SIGTERM で 0 で終わることを確かめる。`mosquitto` / `mosquitto_pub` /
  `mosquitto_passwd` が無ければ **スキップ** (通過とは数えない)。POSIX だけ

## memoria-owntracks

OwnTracks の位置を MQTT で受け、Memoria の SQLite (`gps_locations`) へ書く。外部の broker
(リポジトリ同梱の `docker-compose.yml` の mosquitto、既定 1884) を購読する構成で使う。
Memoria サーバ内蔵の broker (aedes, 1883) を使うときは、このプロセスは要らない。

### 起動

**`server/` を作業ディレクトリにして** 起動する (`npm run owntracks` と同じ)。

```sh
cd server
../native/build/owntracks/memoria-owntracks
```

- 起動時に作業ディレクトリの `.env.secrets` を読む (Node の `--env-file-if-exists=.env.secrets` と同じファイル)。
  既に設定されている環境変数は上書きしない (Node と同じ)。無ければ何もしない
- SIGINT / SIGTERM で DISCONNECT を送り、DB を閉じて 0 で終わる (ブローカーに繋がっていなくても待たない)
- 設定・DB の不備で始められないときは 1 で終わる

### 環境変数 (TS 版と同じ名前・既定値)

| 変数 | 既定 |
|---|---|
| `MEMORIA_MQTT_URL` | `mqtt://localhost:1884` (`mqtt://` だけ) |
| `MEMORIA_MQTT_USERNAME` / `MEMORIA_MQTT_PASSWORD` | 空 (送らない) |
| `MEMORIA_MQTT_TOPIC` | `owntracks/+/+` (QoS 1、接続のたびに購読し直す) |
| `MEMORIA_MQTT_CLIENT_ID` | `memoria-owntracks-<pid>` |
| `MEMORIA_USER_ID` | `me` (空文字列のときも書き込みでは `me`) |
| `MEMORIA_DB_PATH` | `./data/memoria.db` |
| `LOG_LEVEL` / `LOG_FORMAT` / `LOG_DIR` | Portus のロガー (`info` / `pretty` / なし) |

再接続は 5 秒後、接続のタイムアウト (TCP から CONNACK まで) は 10 秒、keep-alive 60 秒 (mqtt.js の既定と同じ)。

### DB パスの決め方

相対の `MEMORIA_DB_PATH` は **作業ディレクトリの親** を基準に解決する (先頭の `./` を 1 回落としてから、
Node の `path.resolve(<cwd>, '..', p)` と同じく字面で正規化)。絶対パスはそのまま。解決した絶対パスは
起動時の 1 行目に出る (`starting (user_id=me, db=/.../data/memoria.db)`)。

TS 版は `resolve(<owntracks-server.ts のあるディレクトリ>, '..', p)` で、`tsx` でソースを動かすと
基準は `server/..` (= リポジトリの root)。つまり `server/` で起動すれば、どちらも
`<repo>/data/memoria.db` (Memoria サーバの `index.ts` が使う既定の DB) になる。
(`owntracks-server.ts` は `dist/` に事前コンパイルされていないが、もし `dist/` へ bundle して動かすと
基準が `server/` になり `server/data/memoria.db` を指してしまう。TS 側の潜在的な食い違い)

### TS 版との違い

意図したもの:

- **スキーマを作らない・移行しない。** TS 版は `openDb` を呼び、DB ファイルと全テーブルを作って移行する。
  C++ 版は既存の DB を開くだけ (`create=false`、WAL、busy timeout 5 秒、foreign_keys ON) で、
  `gps_locations` に必要な列が無ければ「Memoria サーバを一度起動して作らせる」よう出して 1 で終わる。
  スキーマの持ち主は Node サーバ
- 読みから書きまでを 1 つの `BEGIN IMMEDIATE` で包む (TS 版は包まない)。同じ表へ書く Node サーバとの競合を無くすため。
  1 プロセスで書いたときの結果は同じ
- ログは Portus のロガー (`時刻 レベル [owntracks] ...`)。文面は TS 版と同じ (挿入の行は字面まで同じ。
  `toFixed(5)` と `String(tst)` を写している)。接続できないとき、mqtt.js は何も出さずに再接続するが、
  C++ 版は `mqtt error: cannot connect to ...` を毎回出す
- `password` だけで `username` が空、`mqtts://`、URL の誤りは起動時に 1 で終わる (mqtt.js は `mqtts://` に繋ぎ、
  `password` だけのときは接続のたびにエラーを出し続ける)
- mqtt.js は再接続時に自動で購読し直したうえで `connect` の中でも購読するので 2 回購読する。C++ 版は 1 回

同じにしたもの (確かめたもの):

- topic / payload の受け入れ規則 (4 段目以降の無視、空の段の拒否、`_type`、lat / lon / tst の範囲と有限性、
  任意項目の型)。JSON の桁あふれ (`1e999`) は Infinity になって弾かれ、任意項目では Infinity のまま書かれる
- 不正な UTF-8 は `Buffer#toString('utf8')` と同じ置き換え方で U+FFFD にし、置き換え後を `raw_json` に入れる
- `recorded_at` は `new Date(tst * 1000).toISOString()` と同じ字面 (0 方向への切り捨て、6 桁の年)。
  Date の範囲外の tst は `location handler threw: Invalid time value` を出して書かない
- 重複 (skipped) / 停止区間の圧縮 (merged) / 挿入 (inserted) の SQL と haversine の式・定数。
  数値は REAL で bind するので、`battery_pct` は整数値なら INTEGER、端数があれば REAL (better-sqlite3 と同じ)
- 書き込みに失敗 (BUSY など) してもログを出して続ける。QoS 1 の PUBACK は処理が戻った後に送るので、
  失敗したメッセージも受領済みになる (TS 版と同じ。clean session なので再送もされない)

残っている小さな違い:

- `sin` / `cos` / `asin` は C の libm で、V8 (fdlibm) と最後の 1 ulp で違うことがある (20 万組中 1.3%)。
  距離がちょうど 50m の境目にある点だけ、圧縮するかどうかが変わりうる (突き合わせでは 0 件)
- `.env.secrets` の読み方は Portus の `parse_env`: 引用符無しの値の途中の `#` (空白が前に無いもの)・バッククォート・
  複数行の値の扱いが Node と違う
- JSON の入れ子は 256 段まで (JSON.parse には実用上の上限が無い)。1MiB を超える MQTT パケットは受けずに繋ぎ直す
- 対になっていないサロゲートの `\u` エスケープの直後に別の `\u` エスケープが続くと、Portus の JSON は
  2 つ合わせて 1 文字の U+FFFD にする (JS は 2 文字目を残す)。`conn` の値にだけ影響する
- topic が不正な UTF-8 のパケットは、Portus が壊れたパケットとして接続を捨てて繋ぎ直す

### TS 版との突き合わせ (2026-11-12, Linux)

- 決定的な疑似乱数で作った 450 系列 (直接書く 300 系列: 停止・移動・50m 境界・重複・時刻の逆行・NULL / 空の device・
  任意項目の欠け、payload 経由の 150 系列: 壊れた JSON・範囲外・不正な UTF-8 など)、計 10,372 回の呼び出しを、
  `openDb` で作った同じ新しい DB の複製へ TS (`openDb` + `insertGpsLocation`) と C++ (`GpsStore`) で流した。
  呼び出しごとの結果 (種類と id、例外の文) と、`gps_locations` の 7,228 行の全列 (received_at 以外、値と
  `typeof`) が一致。テスト用の DDL (`owntracks/tests/gps_fixture.hpp`) と `openDb` が作る `gps_locations` の
  定義・索引の一致も確かめた
- 同じ mosquitto に繋いだ状態で同じ 1,000 件を受け、挿入ログ 1,000 行が字面まで一致

### メモリ (VmRSS、同じ mosquitto に接続し 1,000 件受けた後)

| プロセス | 待機時 | 1,000 件後 |
|---|---|---|
| `npm run owntracks` の npm | 61.0 MB | 61.0 MB |
| tsx (親 node) | 49.0 MB | 49.0 MB |
| node (接続を持つ子) | 108.8 MB | 117.9 MB |
| esbuild (tsx の子) | — | 16.6 MB |
| **memoria-owntracks** | **6.1 MB** | **6.8 MB** |

Linux x86-64、Node 22.23、gcc 13 `-O2`。1 回の計測値で、傾向の確認用。

### Windows

未確認。Portus は Winsock に対応しているが実機での確認は無く、このディレクトリのコードも Windows では
ビルドしていない (結合テストは POSIX だけ)。OpenSSL と SQLite3 の開発パッケージ (vcpkg など) が要る。
