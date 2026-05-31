// external_chat_messages domain
// Spec: spec/data/chat.md

export interface ExternalChatMessageRow {
  id: number;
  source: string;             // e.g. 'discord' / 'slack' / 'manual'
  conversation_id: string | null;
  role: string | null;         // 'user' / 'assistant' / 'system' 等
  content: string;
  metadata_json: string | null;
  received_at: string;         // UTC ISO
}
