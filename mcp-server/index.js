#!/usr/bin/env node
// Memoria MCP server — bridges the local Memoria HTTP API to MCP-aware clients
// (Claude Desktop, Claude Code, and any other MCP host).
//
// Usage:
//   "command": "node",
//   "args": ["/abs/path/to/Memoria/mcp-server/index.js"],
//   "env": { "MEMORIA_URL": "http://localhost:5180" }

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVER_URL = (process.env.MEMORIA_URL ?? 'http://localhost:5180').replace(/\/+$/, '');

async function call(path, opts = {}) {
  const res = await fetch(SERVER_URL + path, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Memoria ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function callText(path) {
  const res = await fetch(SERVER_URL + path);
  if (!res.ok) throw new Error(`Memoria ${res.status}`);
  return res.text();
}

const server = new McpServer(
  { name: 'memoria', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// ── tools ────────────────────────────────────────────────────────────────

server.registerTool(
  'search_bookmarks',
  {
    title: 'Search Memoria bookmarks',
    description: 'Substring search across title / url / summary / memo of saved bookmarks. Optionally filter by category. Use this whenever the user asks about something they may have saved before.',
    inputSchema: {
      query: z.string().min(1).describe('Free-text query (case-insensitive substring match)'),
      category: z.string().optional().describe('Optional exact category name to filter by'),
      limit: z.number().int().positive().max(100).optional().describe('Max number of results (default 20)'),
    },
  },
  async ({ query, category, limit }) => {
    const qs = new URLSearchParams();
    if (category) qs.set('category', category);
    const { items } = await call(`/api/bookmarks?${qs.toString()}`);
    const q = query.toLowerCase();
    const matches = items
      .filter(b =>
        (b.title || '').toLowerCase().includes(q) ||
        (b.url || '').toLowerCase().includes(q) ||
        (b.summary || '').toLowerCase().includes(q) ||
        (b.memo || '').toLowerCase().includes(q)
      )
      .slice(0, limit ?? 20)
      .map(b => ({
        id: b.id,
        url: b.url,
        title: b.title,
        summary: b.summary,
        categories: b.categories,
        last_accessed_at: b.last_accessed_at,
        access_count: b.access_count,
      }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ count: matches.length, items: matches }, null, 2) }],
    };
  }
);

server.registerTool(
  'get_bookmark',
  {
    title: 'Get bookmark detail',
    description: 'Return full metadata for a single bookmark by id. Includes summary, categories, memo, and saved HTML excerpt.',
    inputSchema: {
      id: z.number().int().positive(),
      include_html: z.boolean().optional().describe('Whether to include the saved HTML body (truncated to ~30 KB).'),
    },
  },
  async ({ id, include_html }) => {
    const b = await call(`/api/bookmarks/${id}`);
    const out = { ...b };
    if (include_html) {
      try {
        const html = await callText(`/api/bookmarks/${id}/html`);
        out.html = html.slice(0, 30_000);
        if (html.length > 30_000) out.html_truncated = true;
      } catch (e) {
        out.html_error = e.message;
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }
);

server.registerTool(
  'save_url',
  {
    title: 'Save a URL as a Memoria bookmark',
    description: 'Tell Memoria to fetch and bookmark the given URL. Returns the new bookmark id (queued for summary). If the URL is already saved, returns the existing id.',
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => {
    const res = await call('/api/visits/bookmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url] }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(res.results[0] ?? res, null, 2) }] };
  }
);

server.registerTool(
  'list_categories',
  {
    title: 'List Memoria categories',
    description: 'Return all categories with bookmark counts.',
    inputSchema: {},
  },
  async () => {
    const { items } = await call('/api/categories');
    return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
  }
);

server.registerTool(
  'get_unsaved_visits',
  {
    title: 'List unsaved visits in the last N days',
    description: 'Return visited but un-bookmarked URLs, with a "miss-bookmark" score that gets higher when the same domain or path prefix already exists in the library.',
    inputSchema: {
      days: z.number().int().positive().max(365).optional().describe('Look-back window in days (default 7).'),
    },
  },
  async ({ days }) => {
    const { items } = await call(`/api/visits/suggested?days=${encodeURIComponent(days ?? 7)}`);
    return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
  }
);

server.registerTool(
  'recent_bookmarks',
  {
    title: 'List recent bookmarks',
    description: 'Return the most recently saved bookmarks ordered by save time.',
    inputSchema: {
      limit: z.number().int().positive().max(50).optional(),
    },
  },
  async ({ limit }) => {
    const { items } = await call('/api/bookmarks?sort=created_desc');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(items.slice(0, limit ?? 10).map(b => ({
          id: b.id, url: b.url, title: b.title, summary: b.summary,
          categories: b.categories, created_at: b.created_at,
        })), null, 2)
      }],
    };
  }
);

// ── resources ────────────────────────────────────────────────────────────

server.registerResource(
  'bookmark',
  new ResourceTemplate('memoria://bookmark/{id}', { list: undefined }),
  {
    title: 'Memoria bookmark',
    description: 'Reference a single bookmark by id. Returns a Markdown rendering of title, url, categories, summary, memo, and saved HTML.',
    mimeType: 'text/markdown',
  },
  async (uri, { id }) => {
    const b = await call(`/api/bookmarks/${id}`);
    let html = '';
    try { html = await callText(`/api/bookmarks/${id}/html`); } catch {}
    const md = [
      `# ${b.title}`,
      '',
      `<${b.url}>`,
      '',
      `**Categories:** ${(b.categories || []).join(', ') || '-'}`,
      `**Saved:** ${b.created_at}`,
      `**Last accessed:** ${b.last_accessed_at ?? '-'}`,
      `**Access count:** ${b.access_count ?? 0}`,
      '',
      '## Summary',
      b.summary || '_(no summary)_',
      '',
      '## Memo',
      b.memo || '_(empty)_',
      '',
      '## Saved HTML (excerpt)',
      '```html',
      html.slice(0, 20_000),
      '```',
    ].join('\n');
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] };
  }
);

// ── prompts ──────────────────────────────────────────────────────────────

server.registerPrompt(
  'review-todays-unsaved',
  {
    title: 'Review today\'s unsaved visits',
    description: 'Walk through pages the user accessed today but didn\'t save, suggesting which to keep.',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Use the get_unsaved_visits tool with days=1, then summarise what you see, group by domain, and suggest which 5 to keep. Use save_url for any I confirm.',
        },
      },
    ],
  })
);

server.registerPrompt(
  'summarise-recent',
  {
    title: 'Summarise recent saves',
    description: 'Give a short briefing of the latest N bookmarks the user added.',
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Call recent_bookmarks with limit=10, then write a 5-bullet briefing: what topics am I currently exploring, which categories are recurring, anything that looks redundant.',
        },
      },
    ],
  })
);

// ── run ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[memoria-mcp] connected. backend: ${SERVER_URL}`);
}

main().catch((err) => {
  console.error('[memoria-mcp] fatal:', err);
  process.exit(1);
});
