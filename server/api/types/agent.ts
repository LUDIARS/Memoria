// agent API request/response types
// Spec: spec/interface/agent.md

import type { AgentProjectRow, AgentRunRow, AgentKind, AgentRunStatus } from '../../db/types/agent.js';

export interface AgentProjectsResponse {
  items: AgentProjectRow[];
}

export interface AgentProjectCreateRequest {
  name: string;
  path: string;                  // absolute path
  rules?: string | null;
  default_agent?: AgentKind;
}

export interface AgentProjectUpdateRequest {
  name?: string;
  path?: string;
  rules?: string | null;
  default_agent?: AgentKind;
}

export interface AgentProjectMutationResponse {
  project: AgentProjectRow;
}

export interface AgentRunListQuery {
  task_id?: number;
  project_id?: number;
  limit?: number;                // default 100, max 500
  status?: AgentRunStatus;
}

export interface AgentRunListResponse {
  items: AgentRunRow[];
}

export interface AgentRunDetailResponse {
  run: AgentRunRow;
  running: boolean;
}

export interface AgentRunLogResponse {
  run: AgentRunRow;
  running: boolean;
  log: string;
}
