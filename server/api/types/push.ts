// push API request/response types
// Spec: spec/api/push.md

import type { PushSubscriptionRow } from '../../db/types/push.js';

export interface VapidKeyResponse {
  key: string;                    // base64url
}

export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
  user_agent?: string;
}

export interface PushSubscribeResponse {
  id: number;
  duplicate?: true;
}

export interface PushSubscriptionsListResponse {
  items: PushSubscriptionRow[];
}

export interface PushTestRequest {
  title?: string;
  body?: string;
}

export interface PushTestResponse {
  result: { sent: number; failed: number; errors: string[] };
}
