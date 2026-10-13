// 通知の送り先 (sink) の登録と送信。
// 送り先の実装 (Discord / LINE) は各ドメインが起動時に登録し、 通知を出す側は kind と target だけを知る。
// spec/feature/home-presence-notify.md「送り先 (sink)」。

/** Discord の送り先に選べる channel kind。 discord/layout.ts が作る channel と揃える。 */
export const DISCORD_CHANNEL_KINDS = [
  'announce', 'task', 'memo', 'bookmark', 'meal', 'recommend', 'activity',
] as const;

export type NotifySinkKind = 'discord' | 'line';

/** 送り先 1 件。 discord は channel kind (announce/task/...) を target に持つ。 */
export type NotifyDestination =
  | { kind: 'discord'; channel: string }
  | { kind: 'line' };

/** text を送って成否を返す。 送れない状態 (未設定・停止中) は false。 */
export type NotifySinkSender = (destination: NotifyDestination, text: string) => Promise<boolean>;

const sinks = new Map<NotifySinkKind, NotifySinkSender>();

export function registerNotifySink(kind: NotifySinkKind, sender: NotifySinkSender): void {
  sinks.set(kind, sender);
}

export function unregisterNotifySink(kind: NotifySinkKind): void {
  sinks.delete(kind);
}

export interface SinkSendResult {
  destination: NotifyDestination;
  ok: boolean;
  reason?: string;
}

/** 送り先ごとに送る。 1 件の失敗で他の送り先を止めない。 */
export async function sendToDestinations(
  destinations: NotifyDestination[],
  text: string,
): Promise<SinkSendResult[]> {
  const results: SinkSendResult[] = [];
  for (const destination of destinations) {
    const sender = sinks.get(destination.kind);
    if (!sender) {
      results.push({ destination, ok: false, reason: `${destination.kind} は未起動` });
      continue;
    }
    try {
      const ok = await sender(destination, text);
      results.push(ok ? { destination, ok } : { destination, ok, reason: `${destination.kind} へ送れませんでした` });
    } catch (e: unknown) {
      results.push({ destination, ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
