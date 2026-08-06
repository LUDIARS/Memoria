import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { getLlmConfig } from '../llm.js';
import type { LocalLlmModel } from './types.js';

type Db = BetterSqlite3.Database;

export interface InventorySnapshot {
  capturedAt: string;
  skillCount: number;
  memoryCount: number;
  geniusCardCount: number | null;
  judgmentLogCount: number;
  localLlms: Array<{ configuredModel: string; available: boolean; models: LocalLlmModel[] }>;
  sourceErrors: string[];
}

export async function captureInventory(db: Db): Promise<InventorySnapshot> {
  const errors: string[] = [];
  const [skillCount, memoryCount, geniusCardCount, localLlms] = await Promise.all([
    countFiles([
      join(homedir(), '.codex', 'skills'),
      join(homedir(), '.codex', 'plugins', 'cache'),
      join(homedir(), '.claude', 'skills'),
    ], (name) => name === 'SKILL.md'),
    countFiles([
      join(homedir(), '.claude', 'projects'),
      join(homedir(), '.codex', 'memories'),
    ], (_name, path) => isMemoryFilePath(path)),
    fetchGeniusCardCount(errors),
    inspectLocalLlm(errors),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    skillCount,
    memoryCount,
    geniusCardCount,
    judgmentLogCount: countJudgmentLogs(db),
    localLlms,
    sourceErrors: errors,
  };
}

export function isMemoryFilePath(path: string): boolean {
  return /[\\/](?:memory|memories)[\\/]/i.test(path);
}

async function countFiles(
  roots: string[],
  accept: (name: string, path: string) => boolean,
): Promise<number> {
  let count = 0;
  for (const root of roots) count += await walkCount(root, accept);
  return count;
}

async function walkCount(root: string, accept: (name: string, path: string) => boolean): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // Provider-specific inventory roots are optional and may not exist.
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += await walkCount(path, accept);
    else if (entry.isFile() && accept(entry.name, path)) count += 1;
  }
  return count;
}

async function fetchGeniusCardCount(errors: string[]): Promise<number | null> {
  const baseUrl = process.env.GENIUS_URL;
  if (!baseUrl) {
    errors.push('GENIUS_URL is not supplied by the Excubitor topology');
    return null;
  }
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/clone/stats`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { total?: unknown };
    if (typeof body.total !== 'number') throw new Error('response.total is missing');
    return body.total;
  } catch (error: unknown) {
    errors.push(`Genius stats unavailable: ${message(error)}`);
    return null;
  }
}

async function inspectLocalLlm(errors: string[]): Promise<InventorySnapshot['localLlms']> {
  const config = getLlmConfig();
  const endpoint = config.gamma_base_url;
  if (!endpoint) {
    errors.push('Gamma local LLM endpoint is not configured');
    return [];
  }
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, {
      headers: config.gamma_api_key ? { Authorization: `Bearer ${config.gamma_api_key}` } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? []).flatMap((item) => typeof item.id === 'string'
      ? [{ id: item.id }]
      : []);
    return [{ configuredModel: config.gamma_model, available: models.length > 0, models }];
  } catch (error: unknown) {
    errors.push(`Local LLM unavailable: ${message(error)}`);
    return [{ configuredModel: config.gamma_model, available: false, models: [] }];
  }
}

function countJudgmentLogs(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM blackbox_decisions').get() as { count: number }).count;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
