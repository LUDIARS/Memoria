// /api/agent-projects*, /api/agent-runs*, /api/tasks/:id/agent-run
// Spec: spec/interface/agent.md

import { Hono, type Context } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';
import {
  listAgentProjects, getAgentProject, insertAgentProject,
  updateAgentProject, deleteAgentProject,
  listAgentRuns, getAgentRun,
  getTask, getAppSettings,
} from '../db.js';
import {
  startAgentRun, cancelAgentRun, readAgentRunLog, isRunning as isAgentRunning,
} from '../agent-dispatch.js';

type Db = BetterSqlite3.Database;

const VALID_AGENTS = new Set(['claude_code', 'codex', 'gemini'] as const);

export interface AgentRouterDeps {
  db: Db;
  dataDir: string;
}

export function makeAgentRouter(deps: AgentRouterDeps): Hono {
  const { db, dataDir } = deps;
  const r = new Hono();

  r.get('/api/agent-projects', (c: Context) => {
    return c.json({ items: listAgentProjects(db) });
  });

  r.post('/api/agent-projects', async (c: Context) => {
    const body = await c.req.json().catch(() => ({})) as
      { name?: unknown; path?: unknown; rules?: unknown; default_agent?: unknown };
    const name = String(body.name ?? '').trim();
    const path = String(body.path ?? '').trim();
    if (!name) return c.json({ error: 'name required' }, 400);
    if (!path) return c.json({ error: 'path required' }, 400);
    const id = insertAgentProject(db, {
      name,
      path,
      rules: typeof body.rules === 'string' ? body.rules : null,
      default_agent: VALID_AGENTS.has(body.default_agent as 'claude_code' | 'codex' | 'gemini') ? body.default_agent as 'claude_code' | 'codex' | 'gemini' : 'claude_code',
    });
    return c.json({ project: getAgentProject(db, id) }, 201);
  });

  r.patch('/api/agent-projects/:id', async (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getAgentProject(db, id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as
      { name?: unknown; path?: unknown; rules?: unknown; default_agent?: unknown };
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.path === 'string') patch.path = body.path.trim();
    if (typeof body.rules === 'string' || body.rules === null) patch.rules = body.rules;
    if (VALID_AGENTS.has(body.default_agent as 'claude_code' | 'codex' | 'gemini')) patch.default_agent = body.default_agent;
    updateAgentProject(db, id, patch);
    return c.json({ project: getAgentProject(db, id) });
  });

  r.delete('/api/agent-projects/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    if (!getAgentProject(db, id)) return c.json({ error: 'not found' }, 404);
    deleteAgentProject(db, id);
    return c.json({ ok: true });
  });

  // Spawn an agent run for a task.
  // Body: { project_id, agent?, model? }
  r.post('/api/tasks/:id/agent-run', async (c: Context) => {
    const taskId = Number(c.req.param('id'));
    const task = getTask(db, taskId);
    if (!task) return c.json({ error: 'task not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as
      { project_id?: unknown; agent?: unknown; model?: unknown };
    const projectId = Number(body.project_id);
    if (!projectId) return c.json({ error: 'project_id required' }, 400);
    const project = getAgentProject(db, projectId);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const agent = (typeof body.agent === 'string' && VALID_AGENTS.has(body.agent as 'claude_code' | 'codex' | 'gemini'))
      ? body.agent as 'claude_code' | 'codex' | 'gemini'
      : (project.default_agent as 'claude_code' | 'codex' | 'gemini' | undefined) ?? 'claude_code';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    try {
      const settings = getAppSettings(db);
      const runId = startAgentRun(db, {
        dataDir,
        settings,
        task,
        project,
        agent,
        model: model || null,
        gitBashPath: settings['runtime.git_bash_path'] || null,
      });
      return c.json({ run: getAgentRun(db, runId) }, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  r.get('/api/agent-runs', (c: Context) => {
    const taskQ = c.req.query('task_id');
    const taskId = taskQ ? Number(taskQ) : null;
    const projectQ = c.req.query('project_id');
    const projectId = projectQ ? Number(projectQ) : null;
    const limit = Math.min(Number(c.req.query('limit') || 100), 500);
    return c.json({ items: listAgentRuns(db, { taskId, projectId, limit }) });
  });

  r.get('/api/agent-runs/:id', (c: Context) => {
    const id = Number(c.req.param('id'));
    const run = getAgentRun(db, id);
    if (!run) return c.json({ error: 'not found' }, 404);
    return c.json({ run, running: isAgentRunning(id) });
  });

  r.get('/api/agent-runs/:id/log', (c: Context) => {
    const id = Number(c.req.param('id'));
    const run = getAgentRun(db, id);
    if (!run) return c.json({ error: 'not found' }, 404);
    const tail = Math.min(Number(c.req.query('tail') || 64 * 1024), 1024 * 1024);
    const log = readAgentRunLog(dataDir, run, { tail });
    return c.json({ run, running: isAgentRunning(id), log });
  });

  r.post('/api/agent-runs/:id/cancel', (c: Context) => {
    const id = Number(c.req.param('id'));
    const run = getAgentRun(db, id);
    if (!run) return c.json({ error: 'not found' }, 404);
    const r2 = cancelAgentRun(db, id);
    return c.json(r2);
  });

  return r;
}
