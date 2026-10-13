// 共通の通知送り先 (shared/notify-sink) に Discord を登録する。 Bot の ready で登録、 停止で外す。

import type { Client } from 'discord.js';
import type BetterSqlite3 from 'better-sqlite3';
import { registerNotifySink, unregisterNotifySink } from '../shared/notify-sink.js';
import { postToChannel } from './notifier.js';

type Db = BetterSqlite3.Database;

export function registerDiscordSink(client: Client, db: Db): void {
  registerNotifySink('discord', async (destination, text) => {
    if (destination.kind !== 'discord') return false;
    return postToChannel(client, db, destination.channel, text);
  });
}

export function unregisterDiscordSink(): void {
  unregisterNotifySink('discord');
}
