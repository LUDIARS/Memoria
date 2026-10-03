/** コミット内の 1 ファイルの変更行数。 */
export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * GitHub に載ったコミット 1 件の変更行数。 キャッシュと集計の単位。
 * コード判定は集計時に files から行うので、 判定を変えても再取得は要らない。
 */
export interface CommitVolume {
  sha: string;
  /** `owner/name` */
  repo: string;
  /** commit author date (ISO 8601, GitHub が返すまま) */
  authoredAt: string;
  additions: number;
  deletions: number;
  files: FileChange[];
  /** ファイル一覧が GitHub の上限で切れ、 code 行数が下限値になっている */
  filesTruncated: boolean;
}

/** 検索に使う本人の識別子。 login は `author:`、 email は `author-email:` で引く。 */
export interface AuthorIdentity {
  kind: 'login' | 'email';
  value: string;
}

/** 1 か月分の集計。 changed = additions + deletions。 */
export interface MonthVolume {
  month: string; // YYYY-MM
  days: number;
  commits: number;
  repos: number;
  additions: number;
  deletions: number;
  changed: number;
  codeAdditions: number;
  codeDeletions: number;
  codeChanged: number;
  /** 月合計 ÷ (日数 / 7) */
  weeklyAvgChanged: number;
  weeklyAvgCodeChanged: number;
  topRepos: { repo: string; changed: number; codeChanged: number }[];
  truncatedCommits: number;
}

export interface VolumeReport {
  generatedAt: string;
  authors: AuthorIdentity[];
  timeZone: string;
  months: MonthVolume[];
  /** 選んだ月の平均 (1 か月あたり) */
  monthlyAvgChanged: number;
  monthlyAvgCodeChanged: number;
  /** 選んだ月の合計 ÷ (総日数 / 7) */
  weeklyAvgChanged: number;
  weeklyAvgCodeChanged: number;
}
