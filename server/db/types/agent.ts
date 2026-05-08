// agent domain — agent_projects / agent_runs (タスクの AI 委託)
// Spec: spec/db/agent.md

export type AgentKind = 'claude_code' | 'codex' | 'gemini';

export interface AgentProjectRow {
  id: number;
  name: string;
  path: string;                  // 絶対パス (CLI の cwd)
  rules: string | null;          // Markdown
  default_agent: AgentKind;
  created_at: string;
  updated_at: string;
}

export type AgentRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface AgentRunRow {
  id: number;
  task_id: number | null;
  project_id: number | null;
  agent: AgentKind;
  model: string | null;
  prompt: string | null;
  status: AgentRunStatus;
  exit_code: number | null;
  log_path: string | null;
  pid: number | null;
  summary: string | null;
  started_at: string;            // UTC ISO
  finished_at: string | null;    // UTC ISO
}
