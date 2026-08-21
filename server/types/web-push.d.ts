/**
 * `web-push` の最小型定義 (Memoria 内で使う API のみ)。
 *
 * `@types/web-push` は typecheck 用の一時インストールで解決できないことが
 * あり (TS7016) 、 型が環境依存で落ちる。 利用箇所が 3 API だけなので
 * リポジトリ側に固定して環境差を無くす。
 */
declare module 'web-push' {
  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }

  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  export function generateVAPIDKeys(): VapidKeys;
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: Record<string, unknown>,
  ): Promise<SendResult>;

  const webpush: {
    generateVAPIDKeys: typeof generateVAPIDKeys;
    setVapidDetails: typeof setVapidDetails;
    sendNotification: typeof sendNotification;
  };
  export default webpush;
}
