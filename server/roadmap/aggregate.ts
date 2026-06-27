// 事業ライン別 private ロードマップ (LUDIARS_ROOT/roadmap-*) を走査して、
// 各ラインの構成リポ・現状・月次計画/達成率を 1 つの構造化進捗 (consolidated)
// に畳む。 Memoria の「目標」タブと、 同じ JSON を読む Actio など他 consumer の
// 共通契約。 正本データは各 roadmap-* リポの data/services.json + data/roadmap.json。
//
// 設定不備は無言フォールバックせず、 root 不在・JSON 破損は呼び出し側に伝える
// (= 空配列で握り潰さない)。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** roadmap-* リポの data/services.json の形。 */
export interface RoadmapServices {
  line: {
    id: string; code: string; title: string; subtitle: string;
    icon: string; accent: string; visibility: string;
    summary: string; status: string; updated: string;
  };
  members: Array<{
    repo: string; role: string; importance: number;
    status: string; statusLabel?: string;
    completion: number | null; note?: string; lines?: string[];
  }>;
}

/** roadmap-* リポの data/roadmap.json の形。 */
export interface RoadmapMonths {
  months: Array<{
    month: string; theme: string; created: string;
    achievement: number | null; evaluated: string | null;
    goals: Array<{ text: string; metric?: string; done: boolean | null }>;
  }>;
}

export interface ContractGrade {
  grade: string;
  summary: { violations: number; skipped: number; bySeverity: Record<string, number>; worst: string | null };
  global: { grade: string; violations: number; skipped: number; reposScanned: string[] };
  generated: string;
}

export interface RoadmapLine extends RoadmapServices, RoadmapMonths {
  repo: string;            // ディレクトリ名 (roadmap-musa 等)
  memberCount: number;
  coreCount: number;       // importance === 3 の数
  refMaturity: number | null; // importance 重み付き平均 (completion=null 除外)
  currentMonth: RoadmapMonths['months'][number] | null;
  goalDone: number;        // currentMonth の done 目標数
  goalTotal: number;       // currentMonth の目標総数
  contract: ContractGrade | null; // Foedus 連結レビュー結果 (未生成なら null)
}

export interface RoadmapAggregate {
  generated: string;
  root: string;
  count: number;
  lines: RoadmapLine[];
  errors: Array<{ repo: string; message: string }>;
}

export function ludiarsRoot(): string {
  return resolve(process.env.LUDIARS_ROOT ?? 'E:/Document/Ars');
}

function currentMonthKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function weightedMaturity(members: RoadmapServices['members']): number | null {
  const scored = members.filter((m) => typeof m.completion === 'number');
  const wsum = scored.reduce((a, m) => a + m.importance, 0);
  if (!wsum) return null;
  return Math.round(scored.reduce((a, m) => a + (m.completion as number) * m.importance, 0) / wsum);
}

/** LUDIARS_ROOT 配下の roadmap-* を走査して consolidated 進捗を返す。 */
export function aggregateRoadmaps(root = ludiarsRoot()): RoadmapAggregate {
  if (!existsSync(root)) {
    throw new Error(`LUDIARS_ROOT が存在しません: ${root} (env LUDIARS_ROOT で上書き可)`);
  }
  const curKey = currentMonthKey();
  const lines: RoadmapLine[] = [];
  const errors: Array<{ repo: string; message: string }> = [];

  const dirs = readdirSync(root)
    .filter((name) => /^roadmap-/.test(name))
    .filter((name) => {
      try { return statSync(join(root, name)).isDirectory(); } catch { return false; }
    })
    .sort();

  for (const repo of dirs) {
    const svcPath = join(root, repo, 'data', 'services.json');
    const rmPath = join(root, repo, 'data', 'roadmap.json');
    if (!existsSync(svcPath) || !existsSync(rmPath)) {
      errors.push({ repo, message: 'data/services.json または data/roadmap.json が無い' });
      continue;
    }
    try {
      const services = JSON.parse(readFileSync(svcPath, 'utf8')) as RoadmapServices;
      const roadmap = JSON.parse(readFileSync(rmPath, 'utf8')) as RoadmapMonths;
      const months = roadmap.months ?? [];
      const currentMonth = months.find((m) => m.month === curKey) ?? months[months.length - 1] ?? null;
      const goals = currentMonth?.goals ?? [];
      const contractPath = join(root, repo, 'data', 'contract.json');
      let contract: ContractGrade | null = null;
      if (existsSync(contractPath)) {
        try {
          const raw = JSON.parse(readFileSync(contractPath, 'utf8'));
          contract = { grade: raw.grade, summary: raw.summary, global: raw.global, generated: raw.generated };
        } catch { /* contract は任意 — 破損しても他データへ影響させない */ }
      }
      lines.push({
        repo,
        line: services.line,
        members: services.members,
        months,
        memberCount: services.members.length,
        coreCount: services.members.filter((m) => m.importance === 3).length,
        refMaturity: weightedMaturity(services.members),
        currentMonth,
        goalDone: goals.filter((g) => g.done === true).length,
        goalTotal: goals.length,
        contract,
      });
    } catch (e) {
      errors.push({ repo, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // 公開区分→中核度→code 順で安定ソート (社内/非公開混在でも見やすく)
  lines.sort((a, b) => b.coreCount - a.coreCount || a.line.code.localeCompare(b.line.code));

  return {
    generated: new Date().toISOString().slice(0, 10),
    root,
    count: lines.length,
    lines,
    errors,
  };
}
