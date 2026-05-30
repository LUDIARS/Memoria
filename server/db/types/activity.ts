// activity domain — activity_events / server_events
// Spec: spec/db/activity.md

export type ActivityKind =
  | 'git_commit'
  | 'claude_code_prompt'
  | 'gemini_prompt'
  | 'codex_prompt'
  | 'task_created'
  | 'task_done'
  | 'task_updated'
  | 'goal_created'
  | 'goal_done'
  | 'goal_updated'
  | 'discord_message'
  | 'discord_presence'
  | 'discord_voice'
  | 'discord_reaction';

export interface ActivityEventRow {
  id: number;
  kind: ActivityKind;
  occurred_at: string;       // UTC ISO
  source: string | null;
  ref_id: string | null;     // unique-with-kind (commit sha / prompt UUID)
  content: string | null;
  metadata_json: string | null;
  ingested_at: string;       // UTC ISO
}

export type ServerEventType = 'start' | 'stop' | 'downtime' | 'restart';

export interface ServerEventRow {
  id: number;
  type: ServerEventType;
  occurred_at: string;        // UTC ISO
  ended_at: string | null;    // UTC ISO
  duration_ms: number | null;
  details_json: string | null;
}
