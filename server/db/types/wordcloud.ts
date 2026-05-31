// word_clouds domain
// Spec: spec/data/wordcloud.md

export type WordCloudOrigin = 'bookmark' | 'bookmarks' | 'dig' | 'merged';
export type WordCloudStatus = 'pending' | 'done' | 'error';

export interface WordCloudRow {
  id: number;
  origin: WordCloudOrigin;
  origin_dig_id: number | null;
  origin_bookmark_id: number | null;
  parent_cloud_id: number | null;     // chain: drilled-into clouds
  parent_word: string | null;
  label: string;
  status: WordCloudStatus;
  error: string | null;
  result_json: string | null;
  created_at: string;
}
