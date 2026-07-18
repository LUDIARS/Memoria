// server/personality-export/features.ts
//
// 「作業傾向からのMBTI風性格診断」の特徴量計算。 MBTIそのものではなく、 Memoriaの作業データから
// 素直に測れる範囲の5軸(両極)を独自に定義する (Voluptasが Bartle をそのまま使わず
// 独自12次元+15軸体系を持つのと同じ流儀)。
//
// 入力は task/diary/activity の生テーブルではなく、 このファイル専用の最小フィールドのみを
// 持つ narrow interface (title/details/work_content 等の本文は一切受け取らない — 呼び出し側
// [server/routes/personality-export.ts] が db.ts の listTasks/listDiariesInRange/listActivityEvents
// から必要なフィールドだけを抽出して渡す)。
//
// 全関数は純粋 (DB非依存) でテスト可能。 サンプル不足時は null を返す (無言のゼロスコアで
// 誤った確信度を出さない)。

export interface TaskFeatureInput {
  status: 'todo' | 'doing' | 'done';
  kind: 'task' | 'goal';
  created_at: string;   // ISO
  due_at: string | null;
  category: string | null; // カンマ区切りの複数値 (task.ts の規約通り)
}

export interface DiaryFeatureInput {
  date: string;              // 'YYYY-MM-DD'
  work_minutes: number | null;
}

export interface ActivityFeatureInput {
  kind: string;
  occurred_at: string;       // ISO
}

export interface AxisScore {
  id: string;
  label: string;
  /** [negative pole label, positive pole label] */
  poles: [string, string];
  /** -1..1. 負に近いほど poles[0] 寄り、正に近いほど poles[1] 寄り。 */
  score: number;
  sampleSize: number;
}

const MIN_TASK_SAMPLE = 5;
const MIN_ACTIVITY_SAMPLE = 20;
const MIN_DIARY_SAMPLE = 5;

function clamp(v: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function parseCategories(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map((c) => c.trim()).filter(Boolean);
}

/** Structuring: 計画型(due_atを細かく設定) ↔ 即応型(その場で動く) */
export function computeStructuringAxis(tasks: TaskFeatureInput[]): AxisScore | null {
  if (tasks.length < MIN_TASK_SAMPLE) return null;
  const withDue = tasks.filter((t) => !!t.due_at).length;
  const ratio = withDue / tasks.length;
  return {
    id: 'structuring',
    label: 'Structuring',
    poles: ['即応型', '計画型'],
    score: round4(clamp(2 * ratio - 1)),
    sampleSize: tasks.length,
  };
}

/** Focus: 探索型(カテゴリを頻繁に切り替える) ↔ 持続型(同じカテゴリに留まる) */
export function computeFocusAxis(tasks: TaskFeatureInput[]): AxisScore | null {
  const withCategory = tasks.filter((t) => parseCategories(t.category).length > 0);
  if (withCategory.length < MIN_TASK_SAMPLE) return null;
  const allCategories = withCategory.flatMap((t) => parseCategories(t.category));
  const uniqueRatio = new Set(allCategories).size / allCategories.length;
  return {
    id: 'focus',
    label: 'Focus',
    poles: ['探索型', '持続型'],
    score: round4(clamp(1 - 2 * uniqueRatio)),
    sampleSize: withCategory.length,
  };
}

function shannonEntropyNormalized(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const buckets = counts.length;
  let entropy = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(buckets);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Rhythm: 変動型(活動時間帯がバラバラ・作業量が日によって大きく変わる) ↔
 *         規則型(決まった時間帯・作業量が安定)
 * activity_events の時間帯分布のエントロピーと、 diary work_minutes の変動係数を
 * 半々で合成する (どちらか片方しかサンプルが無ければそちらのみ使う)。
 */
export function computeRhythmAxis(
  activities: ActivityFeatureInput[],
  diaries: DiaryFeatureInput[]
): AxisScore | null {
  const hourCounts = new Array(24).fill(0) as number[];
  for (const a of activities) {
    const d = new Date(a.occurred_at);
    if (Number.isNaN(d.getTime())) continue;
    hourCounts[d.getHours()] += 1;
  }
  const activityEligible = activities.length >= MIN_ACTIVITY_SAMPLE;
  const entropyVariability = activityEligible ? shannonEntropyNormalized(hourCounts) : null;

  const minutes = diaries.map((d) => d.work_minutes).filter((m): m is number => typeof m === 'number' && m > 0);
  const diaryEligible = minutes.length >= MIN_DIARY_SAMPLE;
  const cv = diaryEligible ? coefficientOfVariation(minutes) : null;
  // CV は理論上青天井なので 0..1.5 を 0..1 にクランプして正規化する。
  const cvVariability = cv === null ? null : clamp(cv / 1.5, 0, 1);

  const signals = [entropyVariability, cvVariability].filter((v): v is number => v !== null);
  if (signals.length === 0) return null;
  const variability = signals.reduce((a, b) => a + b, 0) / signals.length;
  return {
    id: 'rhythm',
    label: 'Rhythm',
    poles: ['規則型', '変動型'],
    score: round4(clamp(2 * variability - 1)),
    sampleSize: activities.length + diaries.length,
  };
}

/** Completion: 着手型(始めるが完了させない) ↔ 完遂型(始めたことをやり切る) */
export function computeCompletionAxis(tasks: TaskFeatureInput[]): AxisScore | null {
  if (tasks.length < MIN_TASK_SAMPLE) return null;
  const done = tasks.filter((t) => t.status === 'done').length;
  const ratio = done / tasks.length;
  return {
    id: 'completion',
    label: 'Completion',
    poles: ['着手型', '完遂型'],
    score: round4(clamp(2 * ratio - 1)),
    sampleSize: tasks.length,
  };
}

const DISCORD_KINDS = new Set(['discord_message', 'discord_presence', 'discord_voice', 'discord_reaction']);

/**
 * Social: 単独型 ↔ 協調型 (Discord系activity_eventsの比率)。
 * Discordアクティビティが記録されていない (=Bot連携未使用) ユーザには軸自体を返さない。
 */
export function computeSocialAxis(activities: ActivityFeatureInput[]): AxisScore | null {
  if (activities.length < MIN_ACTIVITY_SAMPLE) return null;
  const discordCount = activities.filter((a) => DISCORD_KINDS.has(a.kind)).length;
  if (discordCount === 0) return null;
  const ratio = discordCount / activities.length;
  return {
    id: 'social',
    label: 'Social',
    poles: ['単独型', '協調型'],
    score: round4(clamp(2 * ratio - 1)),
    sampleSize: activities.length,
  };
}

export interface PersonalityFeatures {
  axes: AxisScore[];
  sampleWindowDays: number;
  computedAt: string;
  counts: { tasks: number; diaries: number; activities: number };
}

export function computePersonalityFeatures(
  input: { tasks: TaskFeatureInput[]; diaries: DiaryFeatureInput[]; activities: ActivityFeatureInput[] },
  opts: { sampleWindowDays: number; now?: () => Date }
): PersonalityFeatures {
  const now = opts.now ?? (() => new Date());
  const axes = [
    computeStructuringAxis(input.tasks),
    computeFocusAxis(input.tasks),
    computeRhythmAxis(input.activities, input.diaries),
    computeCompletionAxis(input.tasks),
    computeSocialAxis(input.activities),
  ].filter((a): a is AxisScore => a !== null);

  return {
    axes,
    sampleWindowDays: opts.sampleWindowDays,
    computedAt: now().toISOString(),
    counts: { tasks: input.tasks.length, diaries: input.diaries.length, activities: input.activities.length },
  };
}
