---
name: memoria-worklog
description: Record concise worklogs, tasks, chat excerpts, and implementation notes into the local Memoria instance.
---

# Memoria Worklog

Use this skill when the user asks Codex to record progress in Memoria, add a task, save a chat excerpt, or leave an implementation note.

## Endpoint

Use `MEMORIA_URL` when set. Otherwise use `http://localhost:5180`.

## Actions

- Worklog: send activity or chat notes to Memoria as factual summaries.
- Task: call `POST /api/tasks` with `title`, optional `details`, optional `due_at`, and optional `share_actio`.
- External chat: call `POST /api/external-chat/messages` with `source`, `content`, optional `role`, optional `conversation_id`, and optional `metadata`.
- Implementation note: call `POST /api/implementation-notes` with `product`, `title`, `good_points`, `bad_points`, and `shareable`.

## Rules

- Keep entries concise and fact-based.
- Do not include secrets, tokens, passwords, or private personal information.
- Ask before marking a note or task as shareable when the user has not explicitly said to share it.
