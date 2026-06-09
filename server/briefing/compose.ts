// ブリーフィング組み立て。 位置を解決し、 有効なセクションのソースを並列に走らせて
// SectionBlock を表示順に束ねる。 送信先 (Discord / Hora) は一切知らない。

import type BetterSqlite3 from 'better-sqlite3';
import type { Briefing, SectionBlock } from './types.js';
import type { BriefingConfig } from './config.js';
import { fetchForecast, readLatestGpsLatLon } from '../lib/weather.js';
import { buildTrainBlock } from './sources/train.js';
import { buildNext3hWeatherBlock, buildCurrentWeatherBlock } from './sources/weather.js';
import { buildEnvironmentBlock } from './sources/environment.js';
import { buildNewsBlock } from './sources/news.js';
import { buildTasksBlock } from './sources/tasks.js';
import { buildDisasterBlock } from './sources/disaster.js';

type Db = BetterSqlite3.Database;

function resolveLocation(db: Db, cfg: BriefingConfig): { lat: number; lon: number } | null {
  return cfg.fixedLocation ?? readLatestGpsLatLon(db);
}

export async function buildBriefing(db: Db, cfg: BriefingConfig): Promise<Briefing> {
  const loc = resolveLocation(db, cfg);
  // 各タスクは SectionBlock か SectionBlock[] (天気は 2 枚) を返す。 表示順は push 順。
  const tasks: Promise<SectionBlock | SectionBlock[]>[] = [];

  if (cfg.sections.train) {
    tasks.push(buildTrainBlock(cfg.trainLines));
  }

  if (cfg.sections.weather) {
    tasks.push((async (): Promise<SectionBlock | SectionBlock[]> => {
      if (!loc) {
        return { key: 'weather', heading: '🌤 天気', lines: ['（位置情報が無いため天気を取得できません — 設定で固定座標か GPS を）'] };
      }
      try {
        const f = await fetchForecast(loc.lat, loc.lon);
        return [buildNext3hWeatherBlock(f), buildCurrentWeatherBlock(f)];
      } catch (e: unknown) {
        return { key: 'weather', heading: '🌤 天気', lines: [`⚠️ 天気の取得に失敗しました（${e instanceof Error ? e.message : String(e)}）`] };
      }
    })());
  }

  if (cfg.sections.environment) {
    tasks.push((async (): Promise<SectionBlock> => {
      if (!loc) return { key: 'environment', heading: '🌫 空気質・紫外線', lines: ['（位置情報が無いため取得できません）'] };
      return buildEnvironmentBlock(loc.lat, loc.lon);
    })());
  }

  if (cfg.sections.news) {
    tasks.push(Promise.resolve(buildNewsBlock(db, cfg.newsWindowMinutes)));
  }

  if (cfg.sections.tasks) {
    tasks.push(Promise.resolve(buildTasksBlock(db)));
  }

  if (cfg.sections.disaster) {
    tasks.push(buildDisasterBlock({ jmaAreaCode: cfg.jmaAreaCode, earthquakeMinScale: cfg.earthquakeMinScale }));
  }

  const settled = await Promise.all(tasks);
  const blocks: SectionBlock[] = [];
  for (const r of settled) {
    if (Array.isArray(r)) blocks.push(...r);
    else blocks.push(r);
  }

  return { generatedAt: new Date(), blocks };
}
