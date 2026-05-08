// MCP server (mcp-server/index.js) を Memoria の child process として起動 / 停止する。
//
// 設定 → プライバシー → 「MCP autostart」 が ON のときだけ生やす。
// MEMORIA_URL を child env に渡し、 Claude Desktop / Code から
// LUDIARS の API を叩けるようにする。

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface McpServerControl {
  start: () => void;
  stop: () => void;
  /** privacy.mcp_autostart_enabled に従って start / stop を切り替える */
  sync: (autostartEnabled: boolean) => void;
}

export interface McpServerDeps {
  /** Memoria が listen している port (子プロセス env に MEMORIA_URL として渡す) */
  port: number;
  /** mcp-server ディレクトリの絶対パス。 default は `<server-dir>/../mcp-server` */
  mcpDir?: string;
}

export function makeMcpServer(deps: McpServerDeps): McpServerControl {
  let mcpChild: ChildProcess | null = null;
  const mcpDir = deps.mcpDir ?? resolve(process.cwd(), 'mcp-server');

  function start(): void {
    if (mcpChild) return;
    if (!existsSync(mcpDir)) return;
    const env = {
      ...process.env,
      MEMORIA_URL: process.env.MEMORIA_URL || `http://127.0.0.1:${deps.port}`,
    };
    const child = spawn(process.execPath, ['index.js'], {
      cwd: mcpDir,
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
      detached: false,
    });
    child.on('exit', () => { if (mcpChild?.pid === child.pid) mcpChild = null; });
    child.on('error', (e: Error) => console.error('[mcp] spawn failed:', e.message));
    mcpChild = child;
    console.log(`[mcp] started pid=${child.pid}`);
  }

  function stop(): void {
    if (!mcpChild) return;
    try { mcpChild.kill('SIGTERM'); } catch { /* ignore */ }
    mcpChild = null;
    console.log('[mcp] stopped');
  }

  function sync(autostartEnabled: boolean): void {
    if (autostartEnabled) start();
    else stop();
  }

  return { start, stop, sync };
}
