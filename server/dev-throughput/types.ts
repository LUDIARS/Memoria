// 開発量の日次集計 (dev-throughput) の型。 1 日 = JST の暦日 (YYYY-MM-DD)。

export interface DailyThroughput {
  /** JST の暦日 YYYY-MM-DD */
  day: string;
  /** Revisor でマージされた PR の件数 */
  rvMerged: number;
  /** リポジトリ (owner/name) ごとのマージ件数 */
  rvByRepo: Record<string, number>;
  /** GitHub の既定ブランチに載ったコミット件数。 まだ数えていない日は null */
  commits: number | null;
  /** 最後に集計した時刻 (ISO) */
  collectedAt: string;
}

/** Revisor の一覧 (view=summary) から使う項目だけ。 */
export interface MergedPullRequest {
  repository: string;
  status: string;
  updatedAt: string;
}

export interface MergeCount {
  total: number;
  byRepo: Record<string, number>;
}

export interface SyncStatus {
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
}
