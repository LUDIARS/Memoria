// task API request/response types
// Spec: spec/interface/task.md

import type { TaskRow, TaskStatus, TaskCreatorType } from '../../db/types/task.js';
import type { AgentRunRow, AgentKind } from '../../db/types/agent.js';

export interface TaskListQuery {
  limit?: number;       // default 100, max 200
  offset?: number;      // default 0
  status?: TaskStatus;
}

export interface TaskListResponse {
  items: TaskRow[];
}

export interface TaskCreateRequest {
  title: string;
  details?: string;
  status?: TaskStatus;
  creator_type?: TaskCreatorType;
  due_at?: string | null;
  share_actio?: boolean;
  category?: string | null;     // カンマ区切り
}

export interface TaskUpdateRequest {
  title?: string;
  details?: string;
  status?: TaskStatus;
  due_at?: string | null;
  share_actio?: boolean;
  category?: string | null;
}

export interface TaskMutationResponse {
  task: TaskRow;
}

export interface TaskCategoriesResponse {
  items: string[];              // 重複排除 + ASCII/JIS 順 sort
}

export interface AgentRunStartRequest {
  project_id: number;
  agent?: AgentKind;
  model?: string;
}

export interface AgentRunStartResponse {
  run: AgentRunRow;
}
