# Markdown 表示境界の生 HTML 防止

- Actio: `actio:70af739f-1884-4535-acc8-b44ca92a938c`
- 到達経路: 外部節 API → `diary-sections-view.ts` → `renderMarkdownBlock` → `renderInline` → `innerHTML`。
- 原因: `renderInline` が `<...>` をそのまま出力し、呼び出し側もサニタイズしていなかった。
- 方針: Markdown の生 HTML はエスケープして文字として表示する。既存の装飾・コード・許可 URL のリンク・ブロック構造は維持する。
- 再利用: 既存 `escapeHtml` と共通レンダラーを使用する。`sanitizeInlineHtml` は編集用 HTML の許可処理であり、未知タグを unwrap する経路に未処理の子要素が残るため、この境界には採用しない。

## 契約

C-19 renderInlineEvidence(input): 生HTMLを文字として表示し、生成タグはb・i・code・安全なaだけに限定する
C-20 renderBlockEvidence(input): 外部日記と同じMarkdown表示経路で危険なHTML・属性・URLを出力せずブロック構造を維持する

契約は Node 専用アダプターから実際のブラウザ用レンダラーを呼ぶ。観測用のファイルシステム依存をブラウザへ混入させない。

## 検証計画

`augur plan` の挙動固定の提案に沿い、生HTML、イベント属性、SVG、iframe、危険URL、引用内や表内のHTMLを回帰対象とする。正常な装飾、許可リンク、コード、見出し、リスト、表も固定する。回帰テストを追加するが委託指示により実行しない。明示された契約証跡の取得だけをサービス起動なしで実行する。
