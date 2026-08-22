export type ReleaseSourceKind = 'github_releases' | 'github_tags' | 'rss' | 'html';

export interface ReleaseSource {
  id: string;
  name: string;
  kind: ReleaseSourceKind;
  /** 監視先 URL。 github_* は `https://github.com/<owner>/<repo>` 形式、 rss は feed URL、 html は公式ページ。 */
  url: string;
  /** github_tags 向け: タグ名から版本文を取りに行くテンプレ (`{version}` / `{tag}` 置換)。 */
  notesUrlTemplate: string | null;
  /** タグ/エントリの絞り込み正規表現 (null = すべて)。 */
  includePattern: string | null;
  enabled: boolean;
}

export interface ReleaseWatchConfig {
  defaultsVersion: number;
  enabled: boolean;
  refreshHour: number;
  versionsPerSource: number;
  sources: ReleaseSource[];
}

/** 取得直後の生エントリ (要約前)。 */
export interface RawRelease {
  version: string;
  url: string;
  publishedAt: string | null;
  body: string;
}

export interface ReleaseEntry {
  version: string;
  url: string;
  publishedAt: string | null;
  /** 日本語の簡潔な要約 (Markdown 箇条書き)。 */
  summaryJa: string;
  summarizedAt: string;
}

export interface ReleaseSourceDigest {
  sourceId: string;
  sourceName: string;
  sourceKind: ReleaseSourceKind;
  url: string;
  entries: ReleaseEntry[];
  fetchedAt: string;
  error: string | null;
}

export interface ReleaseDigest {
  /** 全ソースを巡回し切った日 (`YYYY-MM-DD`)。 1 ソースのみの更新では進めない。 未完なら null。 */
  date: string | null;
  generatedAt: string;
  sources: ReleaseSourceDigest[];
}
