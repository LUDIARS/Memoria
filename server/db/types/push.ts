// push_subscriptions domain
// Spec: spec/db/push.md

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;            // unique
  p256dh: string;
  auth: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;          // UTC ISO
  revoked_at: string | null;   // UTC ISO. NULL = active
}
