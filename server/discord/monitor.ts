// monitor チャンネルの状態カード。 Discord 接続中、 Memoria カテゴリの monitor
// チャンネルに「状態 / 今日が締切のタスク数 / 次の通知までの時間 / 最終更新」 を
// 1 メッセージの embed として保ち、 60s ごとに edit-or-send で更新する。
// 全て best-effort (失敗は log のみ)。

import type { Client, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { getAppSettings, setAppSettings } from '../db.js';
import { channelIdFor } from './layout.js';
import { discordSettings } from './settings.js';
import { selectTasks } from './notify/select.js';
import { loadTriggers } from './notify/config.js';

type Db = BetterSqlite3.Database;

const MESSAGE_ID_KEY = 'features.discord.monitor.message_id';

/** "HH:MM" の time トリガーのうち、 now 以降で最も近い次回発火時刻 (epoch ms)。
 *  enabled な time トリガーが無ければ null。 random / gps は非決定なので対象外。 */
function nextTimeTriggerMs(db: Db, now: Date): number | null {
  let earliest: number | null = null;
  for (const t of loadTriggers(db)) {
    if (!t.enabled || t.trigger.type !== 'time') continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trigger.at);
    if (!m) continue;
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1); // 過ぎていれば翌日
    const ms = next.getTime();
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

/** 今日が締切 (or 期限超過) のアクティブタスク数。 通知エンジンと同じ select を再利用。 */
function dueTodayCount(db: Db, now: Date): number {
  return selectTasks(db, { categories: ['all'], deadline: 'due_today_or_overdue' }, now).length;
}

function buildEmbed(db: Db, now: Date): Record<string, unknown> {
  const due = dueTodayCount(db, now);
  const nextMs = nextTimeTriggerMs(db, now);
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: '状態', value: '🟢 稼働中', inline: true },
    { name: '今日が締切のタスク', value: `${due} 件`, inline: true },
  ];
  if (nextMs !== null) {
    const hours = (nextMs - now.getTime()) / 3_600_000;
    fields.push({
      name: '次の通知まで',
      value: `約 ${hours.toFixed(1)} 時間 (<t:${Math.floor(nextMs / 1000)}:R>)`,
      inline: true,
    });
  } else {
    fields.push({ name: '次の通知まで', value: '—（時刻トリガー未設定）', inline: true });
  }
  return {
    title: '🟢 Memoria Monitor',
    color: 0x5865f2,
    fields,
    footer: { text: '最終更新' },
    timestamp: now.toISOString(),
  };
}

async function updateMonitorCard(client: Client, db: Db): Promise<void> {
  const channelId = channelIdFor(db, 'monitor');
  if (!channelId) return;
  const ch = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!ch || ch.type !== ChannelType.GuildText) return;
  const channel = ch as TextChannel;

  const embed = buildEmbed(db, new Date());
  const messageId = getAppSettings(db)[MESSAGE_ID_KEY];
  if (messageId) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed] });
      return;
    }
  }
  const sent = await channel.send({ embeds: [embed] });
  setAppSettings(db, { [MESSAGE_ID_KEY]: sent.id });
}

/** Bot ready 時に呼ぶ。 60s interval で monitor カードを更新 (process 終了まで)。 */
export function startMonitor(client: Client, db: Db): void {
  if (!discordSettings(db).monitor) {
    console.log('[discord] monitor card 無効 (features.discord.monitor=false)');
    return;
  }
  const tick = () =>
    updateMonitorCard(client, db).catch((e: unknown) =>
      console.warn(`[discord] monitor update 失敗: ${e instanceof Error ? e.message : String(e)}`),
    );
  void tick();
  setInterval(() => { void tick(); }, 60_000).unref?.();
  console.log('[discord] monitor card started');
}
