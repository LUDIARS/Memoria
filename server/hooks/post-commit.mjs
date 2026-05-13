#!/usr/bin/env node
// Memoria git post-commit hook.
//
// commit 直後に走らせて Memoria に `git_commit` activity event を送る。
// `claude-code-prompt.mjs` と同じスタイル: 失敗は黙殺、 stdout/stderr 汚さない、
// 1 秒タイムアウト。
//
// 文字化け対策:
//   Windows 既定の OEM code page (= 932 / Shift-JIS) で git log の出力を
//   そのまま curl --data に渡すと、 Memoria が UTF-8 として解釈して文字化けする。
//   ここでは:
//     - child_process.execFileSync で `git log -1 --format=...` を実行
//     - encoding: 'utf8' を明示
//     - GIT 自体には `-c i18n.logoutputencoding=utf-8` と `-c i18n.commitencoding=utf-8` を渡す
//     - body は JSON.stringify で encode (= 確定 UTF-8)
//
// インストール:
//   1) `~/.memoria-hooks/` に本ファイルを post-commit (拡張子なし) でコピー
//      or symlink。 実行ビット必須 (`chmod +x`)。
//   2) `git config --global core.hooksPath "$HOME/.memoria-hooks"` で全 repo 有効化。
//      既に別 hook 運用がある場合は repo ごとに `.git/hooks/post-commit` に置く。
//   3) Memoria local backend が起動していること (= MEMORIA_URL に到達できる)。
//   docs/setup/git-hooks.md に手順詳細あり。
//
// 環境変数:
//   MEMORIA_URL  — base URL (default http://localhost:5180)
//   MEMORIA_GIT_HOOK_DEBUG — '1' で stderr に診断出力

import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";

const MEMORIA_URL = process.env.MEMORIA_URL || "http://localhost:5180";
const TIMEOUT_MS = 1000;
const DEBUG = process.env.MEMORIA_GIT_HOOK_DEBUG === "1";

function dbg(msg) {
  if (DEBUG) process.stderr.write(`[memoria-hook] ${msg}\n`);
}

function runGit(args) {
  try {
    return execFileSync(
      "git",
      ["-c", "i18n.logoutputencoding=utf-8", "-c", "i18n.commitencoding=utf-8", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    ).trim();
  } catch (e) {
    dbg(`git ${args.join(" ")} failed: ${e && e.message}`);
    return "";
  }
}

async function main() {
  // commit が無い (= rebase の途中とか) なら諦める
  const sha = runGit(["rev-parse", "HEAD"]);
  if (!sha || sha.length < 7) return;

  // commit 情報 (UTF-8 強制)
  const subject = runGit(["log", "-1", "--format=%s"]);
  const body = runGit(["log", "-1", "--format=%B"]);
  const author = runGit(["log", "-1", "--format=%an <%ae>"]);
  const committedAt = runGit(["log", "-1", "--format=%cI"]);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const repoTop = runGit(["rev-parse", "--show-toplevel"]);
  const remoteUrl = runGit(["config", "--get", "remote.origin.url"]);
  const filesChangedRaw = runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  const filesChanged = filesChangedRaw ? filesChangedRaw.split(/\r?\n/).filter(Boolean) : [];

  // 短く要約された 1 行 content (= 検索 / 一覧用)
  const content = subject || `commit ${sha.slice(0, 7)}`;

  // 詳細は metadata に。 個人情報的に問題ない範囲。
  const metadata = {
    sha,
    branch,
    repo: repoTop ? repoTop.replace(/\\/g, "/").split("/").slice(-1)[0] : null,
    repo_path: repoTop,
    remote_url: remoteUrl || null,
    author,
    committed_at: committedAt,
    subject,
    body: body && body !== subject ? body.slice(0, 4000) : null,
    files_changed: filesChanged.slice(0, 200),
    files_changed_total: filesChanged.length,
    host: hostname(),
    user: (() => { try { return userInfo().username; } catch { return null; } })(),
  };

  const payload = {
    kind: "git_commit",
    source: metadata.repo || metadata.repo_path || null,
    ref_id: sha,
    content,
    occurred_at: committedAt || undefined,
    metadata,
  };

  // 1 秒 timeout 付きの POST。 失敗は完全黙殺。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MEMORIA_URL}/api/activity/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    dbg(`POST ${MEMORIA_URL}/api/activity/event → ${res.status}`);
  } catch (e) {
    dbg(`POST failed: ${e && e.message}`);
    // intentional: commit を妨げない
  } finally {
    clearTimeout(timer);
  }
}

void main().catch((e) => {
  dbg(`unhandled: ${e && e.message}`);
  process.exit(0);
});
