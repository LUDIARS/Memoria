import { ChannelType, type Client, type TextChannel } from "discord.js";
import type { Database } from "better-sqlite3";
import type { DiscordLayout } from "./layout.js";
import type { AppSettingsRepo } from "../settings/app-settings-repo.js";
import { selectDueTodayTasks } from "./notify/select.js";
import { loadNotifyConfig } from "./notify/config.js";
import { earliestNextFire } from "./notify/scheduler.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("discord.monitor");

const MONITOR_MESSAGE_KEY = "discord.monitor.message_id";
const UPDATE_INTERVAL_MS = 60_000;

export interface MonitorHandle {
  stop(): void;
}

export interface MonitorDeps {
  client: Client;
  db: Database;
  appSettings: AppSettingsRepo;
  layout: DiscordLayout;
}

// Memoria カテゴリの monitor チャンネルに、サービス状態 / 今日が締切のタスク数 /
// 次の通知までの時間 / 最終更新時間を 1 枚のカード (1 メッセージ) として保つ。
// Discord に接続している間だけ動き、edit-or-send で 1 メッセージを更新し続ける。
export function startMonitor(deps: MonitorDeps): MonitorHandle {
  const tick = () =>
    updateMonitorCard(deps).catch((e) => log.warn(`monitor update failed: ${String(e)}`));
  void tick();
  const timer = setInterval(() => void tick(), UPDATE_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function updateMonitorCard(deps: MonitorDeps): Promise<void> {
  const channel = await resolveMonitorChannel(deps);
  if (!channel) {
    log.warn("monitor channel not found");
    return;
  }
  const embed = buildMonitorEmbed(deps);

  const messageId = deps.appSettings.get(MONITOR_MESSAGE_KEY);
  if (messageId) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed] });
      return;
    }
  }
  const sent = await channel.send({ embeds: [embed] });
  deps.appSettings.set(MONITOR_MESSAGE_KEY, sent.id);
}

async function resolveMonitorChannel(deps: MonitorDeps): Promise<TextChannel | null> {
  const channelId =
    deps.layout.channels["monitor"] ?? deps.appSettings.get("discord.channel.monitor_id");
  if (!channelId) return null;
  const ch =
    deps.client.channels.cache.get(channelId) ??
    (await deps.client.channels.fetch(channelId).catch(() => null));
  if (!ch || ch.type !== ChannelType.GuildText) return null;
  return ch;
}

function buildMonitorEmbed(deps: MonitorDeps): Record<string, unknown> {
  const nowMs = Date.now();
  const dueTodayCount = selectDueTodayTasks(deps.db, nowMs).tasks.length;
  const config = loadNotifyConfig(deps.appSettings);
  const nextFire = earliestNextFire(config.triggers, nowMs);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "状態", value: "🟢 稼働中", inline: true },
    { name: "今日が締切のタスク", value: `${dueTodayCount} 件`, inline: true },
  ];
  if (nextFire !== null) {
    const hours = (nextFire - nowMs) / (60 * 60 * 1000);
    fields.push({
      name: "次の通知まで",
      value: `約 ${hours.toFixed(1)} 時間 (<t:${Math.floor(nextFire / 1000)}:R>)`,
      inline: true,
    });
  } else {
    fields.push({ name: "次の通知まで", value: "—（時刻トリガー未設定）", inline: true });
  }

  return {
    title: "🟢 Memoria Monitor",
    color: 0x5865f2,
    fields,
    footer: { text: "最終更新" },
    timestamp: new Date(nowMs).toISOString(),
  };
}
