// user_stopwords domain
// Spec: spec/data/stopwords.md

/** ワードクラウドや傾向ページから除外したいユーザー定義単語. */
export interface UserStopwordRow {
  word: string;                 // PK (lowercased)
  added_at: string;             // UTC ISO
}
