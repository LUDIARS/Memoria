#!/usr/bin/env node
// Memoria git hooks のインストールヘルパー。
//
// 使い方:
//   node server/hooks/setup.mjs [--global | --repo <path> | --print]
//
// オプション:
//   --global         (default) ~/.memoria-hooks/ にコピーし、 git config --global
//                    core.hooksPath をそこへ設定。 既存設定がある場合は警告して中止。
//   --repo <path>    指定した repo の .git/hooks/post-commit にコピー (= 1 repo のみ)
//   --force          既存ファイル / 既存設定があっても上書き
//   --print          手動でやる人向け、 install するファイル一覧と実行コマンドを出すだけ
//
// 動作確認: 完了後に dummy commit を作ると Memoria backend のログに
//   [http] {... method: "POST", path: "/api/activity/event", status: 200 ...}
// が出る。 出ない場合は server/hooks/post-commit.mjs を直接実行して
// デバッグ可 (MEMORIA_GIT_HOOK_DEBUG=1)。

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = __dirname;
const HOOKS = ["post-commit", "post-commit.mjs"];

function args() {
  const a = { mode: "global", force: false, repo: null, print: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--global") a.mode = "global";
    else if (argv[i] === "--repo") { a.mode = "repo"; a.repo = argv[++i]; }
    else if (argv[i] === "--force") a.force = true;
    else if (argv[i] === "--print") a.print = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`Usage: node setup.mjs [--global | --repo <path> | --print] [--force]`);
      process.exit(0);
    }
  }
  return a;
}

function copyHook(srcDir, dstDir, force) {
  mkdirSync(dstDir, { recursive: true });
  for (const f of HOOKS) {
    const src = join(srcDir, f);
    const dst = join(dstDir, f);
    if (existsSync(dst) && !force) {
      // 既に同 size + 同 content ならスキップ
      if (readFileSync(src).equals(readFileSync(dst))) {
        console.log(`  ✓ ${f} (already up-to-date)`);
        continue;
      }
      console.error(`  ⚠ ${dst} already exists. Use --force to overwrite.`);
      process.exit(1);
    }
    copyFileSync(src, dst);
    if (!f.endsWith(".mjs")) {
      try { chmodSync(dst, 0o755); } catch { /* Windows: chmod は no-op */ }
    }
    console.log(`  → ${dst}`);
  }
}

function setGlobalHooksPath(dstDir, force) {
  let current = "";
  try { current = execSync("git config --global core.hooksPath", { encoding: "utf8" }).trim(); } catch { /* unset */ }
  if (current && current !== dstDir && !force) {
    console.error(`⚠ git config --global core.hooksPath is already set to: ${current}`);
    console.error("  Use --force to override, or copy server/hooks/* into the existing dir manually.");
    process.exit(1);
  }
  execSync(`git config --global core.hooksPath "${dstDir}"`, { stdio: "inherit" });
  console.log(`  → git config --global core.hooksPath ${dstDir}`);
}

function main() {
  const a = args();
  if (a.print) {
    console.log("# 手動で git hook を入れる場合の手順:");
    console.log("");
    console.log("# 1. hooks dir を準備");
    console.log("mkdir -p ~/.memoria-hooks");
    console.log("");
    console.log("# 2. Memoria の hooks ファイルをコピー");
    console.log(`cp "${SRC_DIR}/post-commit"     ~/.memoria-hooks/`);
    console.log(`cp "${SRC_DIR}/post-commit.mjs" ~/.memoria-hooks/`);
    console.log("chmod +x ~/.memoria-hooks/post-commit");
    console.log("");
    console.log("# 3. git config に登録");
    console.log("git config --global core.hooksPath ~/.memoria-hooks");
    console.log("");
    console.log("# 4. 動作確認 (適当な repo で commit して Memoria backend ログに POST が出るか)");
    return;
  }

  if (a.mode === "global") {
    const dst = join(homedir(), ".memoria-hooks");
    console.log(`Installing Memoria git hooks to ${dst} ...`);
    copyHook(SRC_DIR, dst, a.force);
    setGlobalHooksPath(dst, a.force);
    console.log("\n✓ Done. Test with a dummy commit in any repo; check the Memoria backend log.");
  } else if (a.mode === "repo") {
    if (!a.repo) { console.error("--repo requires a path"); process.exit(1); }
    const repoAbs = resolve(a.repo);
    const dst = join(repoAbs, ".git", "hooks");
    if (!existsSync(dst)) { console.error(`Not a git repo (no ${dst})`); process.exit(1); }
    console.log(`Installing to ${dst} ...`);
    copyHook(SRC_DIR, dst, a.force);
    console.log(`\n✓ Done. Test with a dummy commit in ${repoAbs}.`);
  }
}

main();
