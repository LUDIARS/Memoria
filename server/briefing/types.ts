// 定期ブリーフィングの中間表現。 各ソースは SectionBlock を 1 つ返し、
// compose がそれを順序付きで束ね、 format が sink (Discord / Hora) ごとに描画する。
// ソースは「取得 + 整形」 だけを担い、 送信先を一切知らない (SRP)。

export interface SectionBlock {
  /** セクション識別子 (train / weather_now など)。 ログ・並べ替え用。 */
  key: string;
  /** 見出し (絵文字 + 日本語)。 例 '🚆 運行情報'。 */
  heading: string;
  /** 本文行。 空配列なら「情報なし」 を意味する 1 行を入れておく。 */
  lines: string[];
}

export interface Briefing {
  /** 生成時刻 (ローカル)。 */
  generatedAt: Date;
  /** 表示順に並んだセクション。 無効化されたセクションは含まれない。 */
  blocks: SectionBlock[];
}
