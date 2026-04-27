# Module: Content Filter

NG/R18 ワード + ドメインで保存をブロックする最低限のフィルタ。

## 目的
オンライン共有モードで意図せず不適切なコンテンツを保存して晒さないようにする。
本格的なコンテンツモデレーションではなく、**「明らかに NG」を弾く** 程度のセーフネット。

## 責務
- `bookmarks` の保存前に URL / title / 本文を走査
- ヒット時は `422 {error, reason, matches}` を返して保存を中止
- `MEMORIA_CONTENT_FILTER=0` で完全無効化

## ファイル
`service/content-filter.js`

## デフォルト NG ワード (case-insensitive substring)

URL / title / body どこでも match で reject。例:
- 英語: `porn`, `pornhub`, `xvideos`, `xnxx`, `redtube`, `youporn`, `onlyfans`, `r18`, `r-18`
- 日本語: `アダルト`, `成人向け`, `エロ動画`, `エロ漫画`, `エッチ`
- 違法系 (極小): `cp porn`, `child porn`

## デフォルト NG ドメイン

完全一致 + サブドメイン (`endsWith('.' + bad)`):
- `pornhub.com`, `xvideos.com`, `xnxx.com`, `redtube.com`, `youporn.com`, `onlyfans.com`

## 拡張

- `MEMORIA_NGWORDS_FILE` パスでワード追加 (1 行 1 語、`#` でコメント、または JSON 配列)
- `MEMORIA_NG_DOMAINS_FILE` 同形式

## チェック順序

1. URL の host を抽出 → blocked_domain と照合
2. URL/title を toLowerCase() して NG ワードと substring 照合
3. body は `quickText(html)` でテキスト抽出後、先頭 30,000 字を toLowerCase() → 5 件まで matches

最初にヒットした reason で 422 を返す:
- `blocked_domain` — URL がドメインリストに合致
- `ng_word_in_url_or_title` — URL/title に NG ワード
- `ng_word_in_body` — 本文に NG ワード

## API レスポンス

```json
{
  "error": "content blocked by NG word filter",
  "reason": "ng_word_in_body",
  "matches": ["アダルト", "..."]
}
```

## 制限

- substring 一致のみ (regex なし)
- 多言語対応は単純なケース畳み込みのみ
- 文脈は読まない (例: "アダルト水泳教室" のような誤検出はあり得る)

## regex pattern (re: 接頭辞)

ファイル中の行頭が `re:` で始まる場合、続く文字列が JS 正規表現として解釈される (case-insensitive)。マッチは substring と同様 (anchorless)。

```
re:tracking-[0-9]+        # トラッカー ID 形式を弾く
re:^.+\.example\.bad$     # ホスト末尾固定マッチ
```

不正な regex は literal substring にフォールバック (`re:` を含む文字列として比較)。

## whitelist (ホワイトリスト)

`MEMORIA_WHITELIST_FILE` で誤検出を逃がす。URL/title/body のいずれかにヒットすると、その候補は **絶対 reject されない**。フォーマットは NG ワードと同じ (substring + `re:` 接頭辞)。

例:
```
アダルト水泳教室     # アダルト という NG 語を含むが許容したい
re:^https://my-trusted-domain\.com/
```

## ロードマップ

- claude による意味的判定 (オプション、コスト高)
- ドメイン regex 対応
