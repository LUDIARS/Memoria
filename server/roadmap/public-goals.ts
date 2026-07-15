// Pages の公開ロードマップを、Memoria の公開目標表示へそのまま渡す。
// 正本は LUDIARS/docs/data/services.json。private ロードマップの集約とは分離する。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ludiarsRoot } from './aggregate.js';

export interface PublicGoalMember {
  repo: string;
  mediumTermTarget: number;
}

export interface PublicGoal {
  id: string;
  title: string;
  accent: string;
  summary: string;
  members: PublicGoalMember[];
}

export interface PublicGoals {
  goals: PublicGoal[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function asTarget(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a percentage between 0 and 100`);
  }
  return value;
}

function parsePublicGoal(value: unknown, index: number): PublicGoal | null {
  const roadmap = asRecord(value, `roadmaps[${index}]`);
  if (roadmap.visibility !== 'public') return null;

  if (!Array.isArray(roadmap.members)) {
    throw new Error(`roadmaps[${index}].members must be an array`);
  }

  const members = roadmap.members.map((member, memberIndex) => {
    const item = asRecord(member, `roadmaps[${index}].members[${memberIndex}]`);
    return {
      repo: asString(item.repo, `roadmaps[${index}].members[${memberIndex}].repo`),
      mediumTermTarget: asTarget(
        item.mediumTermTarget,
        `roadmaps[${index}].members[${memberIndex}].mediumTermTarget`,
      ),
    };
  });

  return {
    id: asString(roadmap.id, `roadmaps[${index}].id`),
    title: asString(roadmap.title, `roadmaps[${index}].title`),
    accent: asString(roadmap.accent, `roadmaps[${index}].accent`),
    summary: asString(roadmap.summary, `roadmaps[${index}].summary`),
    members,
  };
}

function pagesServicesPath(root: string): string {
  return process.env.LUDIARS_PAGES_SERVICES_PATH
    ?? join(root, 'LUDIARS', 'docs', 'data', 'services.json');
}

export function loadPublicGoalsFromPath(sourcePath: string): PublicGoals {
  if (!existsSync(sourcePath)) {
    throw new Error(`public roadmap source is missing: ${sourcePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read public roadmap source: ${message}`);
  }

  const source = asRecord(parsed, 'public roadmap source');
  if (!Array.isArray(source.roadmaps)) {
    throw new Error('public roadmap source.roadmaps must be an array');
  }

  const goals = source.roadmaps
    .map((roadmap, index) => parsePublicGoal(roadmap, index))
    .filter((goal): goal is PublicGoal => goal !== null);
  return { goals };
}

export function loadPublicGoals(root = ludiarsRoot()): PublicGoals {
  return loadPublicGoalsFromPath(pagesServicesPath(root));
}
