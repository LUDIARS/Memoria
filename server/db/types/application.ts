// applications — process_name 単位の「何のアプリか」 分類カタログ。
// domain_catalog と同じパターン (= 取り込まれるたびに AI 分類 → user_edited=1
// なら手動値を保護)。

export type AppKind =
  | 'game'      // ゲーム (= 🎮 ゲームタブに集計、 仕事時間にはカウントしない)
  | 'work'      // IDE / オフィス / ターミナル等 (= 仕事時間にカウント)
  | 'browser'   // Chrome / Edge / Firefox 等
  | 'messaging' // Discord / Slack / Teams 等
  | 'media'     // 動画 / 音楽プレイヤー
  | 'creative'  // Photoshop / Blender / DAW 等
  | 'other';

export const APP_KINDS: ReadonlyArray<AppKind> = [
  'game', 'work', 'browser', 'messaging', 'media', 'creative', 'other',
];

export interface ApplicationRow {
  process_name: string;
  name: string | null;
  kind: AppKind | string | null;
  description: string | null;
  icon_url: string | null;
  /** 1 のとき auto-classify は値を上書きしない */
  user_edited: 0 | 1;
  /** 'pending' | 'done' | 'error' */
  status: string;
  error: string | null;
  classified_at: string | null;
}
