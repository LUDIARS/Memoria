import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { ensureRssSchema } from './rss/index.js';
import type { BookmarkRow } from './db/types/bookmark.js';
import type { TaskRow } from './db/types/task.js';
import type { AgentRunRow, AgentProjectRow } from './db/types/agent.js';
import type { WorkLocationRow } from './db/types/workplace.js';
import type { GpsLocationRow } from './db/types/gps.js';
import type { MealRow } from './db/types/meal.js';
import type { DigSessionRow } from './db/types/dig.js';
import type { DiaryEntryRow, WeeklyReportRow } from './db/types/diary.js';
import type { DictionaryEntryRow, DictionaryLinkRow } from './db/types/dictionary.js';
import type { WordCloudRow } from './db/types/wordcloud.js';
import type { PageVisitRow, VisitEventRow } from './db/types/visit.js';
import type { PageMetadataRow, DomainCatalogRow } from './db/types/page.js';
import type { ApplicationRow } from './db/types/application.js';
import type { ServerEventRow, ActivityEventRow, ActivityKind } from './db/types/activity.js';
import type { AttendanceEventRow } from './db/types/attendance.js';
import type { PushSubscriptionRow } from './db/types/push.js';
import type { ExternalChatMessageRow } from './db/types/chat.js';
import type { UserStopwordRow } from './db/types/stopwords.js';
import type { ImplementationNoteRow } from './db/types/impl.js';
import type {
  NoteRow, NoteBlockRow, NoteBlockType, NoteKind,
  NoteCommentSetRow, NoteCommentRow,
} from './db/types/note.js';
import { NOTE_BLOCK_TYPES } from './db/types/note.js';

type Db = BetterSqlite3.Database;

// ── helpers (parsing / domain extraction) ─────────────────────────

function safeParse(s: string | null | undefined): unknown {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function extractDomain(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function firstPathSegment(url: string): string | null {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs[0] || null;
  } catch { return null; }
}

// ── openDb / schema ───────────────────────────────────────────────

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── notes schema rev1 → rev2 migration ─────────────────────────────────
  // PR #120 rev1 (notes INTEGER PK) を rev2 (UUID PK + bookmark linkage +
  // comment sets) に変換。 既存行は保持: 旧データを memory に load → 旧 table を
  // drop → 新 table を CREATE → UUID 生成して INSERT。
  let pendingNotesMigration: { notes: Array<Record<string, unknown>>; blocks: Array<Record<string, unknown>> } | null = null;
  try {
    const cols = (db.prepare(`PRAGMA table_info(notes)`).all() as { name: string; type: string; pk: number }[]);
    if (cols.length > 0) {
      const idCol = cols.find((c) => c.name === 'id');
      const isOldSchema = idCol && idCol.type === 'INTEGER';
      if (isOldSchema) {
        const oldNotes = db.prepare(`SELECT * FROM notes`).all() as Array<Record<string, unknown>>;
        const oldBlocks = db.prepare(`SELECT * FROM note_blocks`).all() as Array<Record<string, unknown>>;
        if (oldNotes.length > 0 || oldBlocks.length > 0) {
          pendingNotesMigration = { notes: oldNotes, blocks: oldBlocks };
          console.log(`[notes] rev1→rev2 migration: queued ${oldNotes.length} notes / ${oldBlocks.length} blocks for UUID re-insert`);
        }
        db.exec(`DROP TABLE IF EXISTS note_blocks; DROP TABLE IF EXISTS notes;`);
      }
    }
  } catch { /* first boot: tables don't exist yet, ignore */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      url               TEXT NOT NULL,
      title             TEXT NOT NULL,
      html_path         TEXT NOT NULL,
      summary           TEXT,
      memo              TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'pending',
      error             TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at  TEXT,
      access_count      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bookmark_categories (
      bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      category    TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, category)
    );

    CREATE TABLE IF NOT EXISTS accesses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      bookmark_id  INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      accessed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dig_sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      query         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      status        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      result_json   TEXT,
      preview_json  TEXT,
      raw_results_json TEXT,
      theme         TEXT,
      -- レビュー画面から起こした dig の出自 (= レビュー画面の対応するファイル下に
      -- 再表示するため)。 origin_kind = 'review' / NULL のいずれか。
      origin_kind   TEXT,
      origin_repo   TEXT,
      origin_date   TEXT,
      origin_file   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dig_sessions_created
      ON dig_sessions(created_at DESC);

    CREATE TABLE IF NOT EXISTS recommendation_dismissals (
      url           TEXT PRIMARY KEY,
      dismissed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS page_visits (
      url            TEXT PRIMARY KEY,
      title          TEXT,
      first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
      visit_count    INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_page_visits_last_seen
      ON page_visits(last_seen_at DESC);

    CREATE INDEX IF NOT EXISTS idx_bookmark_categories_category
      ON bookmark_categories(category);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_status
      ON bookmarks(status);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_url
      ON bookmarks(url);
    CREATE INDEX IF NOT EXISTS idx_accesses_bookmark
      ON accesses(bookmark_id, accessed_at DESC);

    CREATE TABLE IF NOT EXISTS page_metadata (
      url               TEXT PRIMARY KEY,
      title             TEXT,
      meta_description  TEXT,
      og_title          TEXT,
      og_description    TEXT,
      og_image          TEXT,
      og_type           TEXT,
      content_type      TEXT,
      http_status       INTEGER,
      summary           TEXT,
      kind              TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      error             TEXT,
      fetched_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_page_metadata_status
      ON page_metadata(status);

    CREATE TABLE IF NOT EXISTS domain_catalog (
      domain        TEXT PRIMARY KEY,
      title         TEXT,
      site_name     TEXT,
      description   TEXT,
      can_do        TEXT,
      kind          TEXT,
      notes         TEXT,
      user_edited   INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      fetched_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS server_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,
      occurred_at  TEXT NOT NULL,
      ended_at     TEXT,
      duration_ms  INTEGER,
      details_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_server_events_at
      ON server_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_server_events_type
      ON server_events(type);

    CREATE TABLE IF NOT EXISTS visit_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT NOT NULL,
      domain      TEXT,
      title       TEXT,
      visited_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_visit_events_visited_at
      ON visit_events(visited_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visit_events_domain
      ON visit_events(domain);

    -- 開発系の活動イベント (git commit / Claude Code prompt 等) を時系列で保存。
    -- ブラウザ閲覧 (visit_events) では拾えない作業 (スマホ開発、 ターミナル作業
    -- 中心の日) を可視化し、 仕事時間推定の根拠にする。
    -- kind: 'git_commit' | 'claude_code_prompt' (将来追加可能)
    -- source: kind 別の文脈 (リポ名 / セッション ID 等)
    -- ref_id: 一意性のあるキー (commit sha / prompt UUID) — 重複登録防止
    -- content: 短い本文 (commit message 1 行目 / プロンプト先頭〜200 文字)
    -- metadata_json: JSON で kind 別の追加情報 (branch, author, model, cwd 等)
    CREATE TABLE IF NOT EXISTS activity_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL,
      occurred_at   TEXT NOT NULL,
      source        TEXT,
      ref_id        TEXT,
      content       TEXT,
      metadata_json TEXT,
      ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_events_at
      ON activity_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_events_kind_at
      ON activity_events(kind, occurred_at DESC);
    -- 同一 ref_id (sha 等) の重複登録を防ぐ — kind+ref_id の組で一意。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_ref
      ON activity_events(kind, ref_id) WHERE ref_id IS NOT NULL;

    -- 出席チェックイン (Aedilis → Memoria webhook、 CONTRACTS.md §5)。
    -- 在席ログの 1 種としてローカルに記録する。 個人データは user_id アンカー
    -- のみ ([[project_personal_data_rule]])。 生 PII は持たない。
    CREATE TABLE IF NOT EXISTS attendance_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      facility_id   TEXT NOT NULL,
      checked_in_at INTEGER NOT NULL,
      reservation_id TEXT,
      source        TEXT NOT NULL DEFAULT 'aedilis',
      event_type    TEXT NOT NULL DEFAULT 'attendance.checked_in',
      ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_events_user
      ON attendance_events(user_id, checked_in_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attendance_events_recent
      ON attendance_events(checked_in_at DESC);
    -- 同一の出席 (同 user × 同施設 × 同時刻) を二重記録しない。 webhook は
    -- fire-and-forget で再送されうるので冪等ガードを置く。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_events_dedup
      ON attendance_events(user_id, facility_id, checked_in_at);

    CREATE TABLE IF NOT EXISTS diary_entries (
      date                  TEXT PRIMARY KEY,
      summary               TEXT,
      work_content          TEXT,
      highlights            TEXT,
      notes                 TEXT,
      metrics_json          TEXT,
      github_commits_json   TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      error                 TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekly_reports (
      week_start            TEXT PRIMARY KEY,
      week_end              TEXT NOT NULL,
      month                 TEXT NOT NULL,
      week_in_month         INTEGER NOT NULL,
      summary               TEXT,
      github_summary_json   TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      error                 TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_month
      ON weekly_reports(month);

    CREATE TABLE IF NOT EXISTS diary_settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS dictionary_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      term         TEXT NOT NULL UNIQUE,
      definition   TEXT,
      notes        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS dictionary_links (
      entry_id      INTEGER NOT NULL REFERENCES dictionary_entries(id) ON DELETE CASCADE,
      source_kind   TEXT NOT NULL,
      source_id     INTEGER NOT NULL,
      added_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (entry_id, source_kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dict_links_entry
      ON dictionary_links(entry_id);
    CREATE INDEX IF NOT EXISTS idx_dict_links_source
      ON dictionary_links(source_kind, source_id);

    CREATE TABLE IF NOT EXISTS word_clouds (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      origin              TEXT NOT NULL,
      origin_dig_id       INTEGER,
      origin_bookmark_id  INTEGER REFERENCES bookmarks(id) ON DELETE CASCADE,
      parent_cloud_id     INTEGER,
      parent_word         TEXT,
      label               TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      error               TEXT,
      result_json         TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_word_clouds_created
      ON word_clouds(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_word_clouds_bookmark
      ON word_clouds(origin_bookmark_id);

    CREATE TABLE IF NOT EXISTS gps_locations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          TEXT NOT NULL DEFAULT 'me',
      device_id        TEXT,
      recorded_at      TEXT NOT NULL,
      lat              REAL NOT NULL,
      lon              REAL NOT NULL,
      accuracy_m       REAL,
      altitude_m       REAL,
      velocity_kmh     REAL,
      course_deg       REAL,
      battery_pct      INTEGER,
      conn             TEXT,
      raw_json         TEXT,
      received_at      TEXT NOT NULL DEFAULT (datetime('now')),
      -- 圧縮メタデータ: 停止区間で 2 行 (始点 + 終点) に集約する際、 終点行が
      -- 何件の raw 発行を代表しているかを保持する。
      -- samples_count: この行が代表する raw 発行数 (通常は 1、 圧縮後の終点行は 2+)
      -- samples_first_at: 圧縮窓の開始時刻 (NULL = recorded_at と同じ = 未圧縮)
      samples_count    INTEGER NOT NULL DEFAULT 1,
      samples_first_at TEXT,
      -- 位置照合 (Google Geocoding/Places で取得した日本語の場所説明)
      -- place_resolved_at が NULL なら未解決 / バックフィル対象
      place_name       TEXT,
      place_address    TEXT,
      place_source     TEXT,                       -- 'places' | 'geocode' | 'cached' | 'failed'
      place_resolved_at INTEGER
    );
    -- 注: idx_gps_locations_unresolved は ALTER TABLE で place_resolved_at を
    -- 後付けしてから作るため、 ここでは作らない (旧 DB に対する CREATE INDEX で
    -- "no such column" になるのを避ける).
    CREATE INDEX IF NOT EXISTS idx_gps_locations_at
      ON gps_locations(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gps_locations_user_at
      ON gps_locations(user_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gps_locations_dedup
      ON gps_locations(user_id, device_id, recorded_at);

    -- アプリ活動サンプル: 一定周期 (default 30秒) で PC の活動を記録する。
    -- foreground row = 取得時に最前面だったプロセス (= 1 サンプル 1 件)。
    -- 同じ sample_at に複数 process 行を入れない設計 (= 表面に出ていたものだけ
    -- 残す。 全プロセス列挙は別運用)。 集計はカウント * sample_interval_sec で
    -- おおよその使用時間を出す。
    CREATE TABLE IF NOT EXISTS app_samples (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      sampled_at          TEXT NOT NULL,
      process_name        TEXT NOT NULL,
      window_title        TEXT,
      sample_interval_sec INTEGER NOT NULL DEFAULT 30
    );
    CREATE INDEX IF NOT EXISTS idx_app_samples_at ON app_samples(sampled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_app_samples_proc_at ON app_samples(process_name, sampled_at);

    -- applications: process_name 単位で「何のアプリか」 を AI 分類するカタログ。
    -- domain_catalog と同じパターン。
    -- kind は以下のいずれか (UI 側 enum):
    --   game     — ゲーム (= 🎮 ゲームタブに集計、 「仕事時間」 にはカウントしない)
    --   work     — 仕事系 (= IDE / オフィスツール / ターミナル等、 仕事時間にカウント)
    --   browser  — ブラウザ (= Chrome / Edge 等)
    --   messaging— Discord / Slack / Teams 等
    --   media    — 動画 / 音楽プレイヤー
    --   creative — Photoshop / Blender / DAW 等
    --   other    — 上記に当てはまらない
    CREATE TABLE IF NOT EXISTS applications (
      process_name  TEXT PRIMARY KEY,
      name          TEXT,
      kind          TEXT,
      description   TEXT,
      icon_url      TEXT,
      user_edited   INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      classified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_applications_kind ON applications(kind);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

    -- Steam recently-played スナップショット。 1 時間おきに Web API で取得して
    -- 各 game 行を 1 つ insert。 集計 (今日の Steam プレイ時間) は同じ appid の
    -- 連続スナップショット間で playtime_forever_min の差分から出す。
    CREATE TABLE IF NOT EXISTS steam_activity (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      sampled_at           TEXT NOT NULL,
      appid                INTEGER NOT NULL,
      name                 TEXT NOT NULL,
      playtime_2weeks_min  INTEGER,
      playtime_forever_min INTEGER,
      img_icon_url         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_steam_activity_at ON steam_activity(sampled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_steam_activity_app ON steam_activity(appid, sampled_at);

    -- Steam Store API (= keyless) で appid → name を解決するキャッシュ。
    -- VDF fallback で uninstalled な appid は appmanifest_<appid>.acf が無いので
    -- 「appid:XXXXX」 にしか出来ない。 起動後に Store API で resolve して
    -- このテーブルに入れる → 以後の表示で name を上書き。 一度解決した name は
    -- 永続化する (= 再取得しない)。 not_found=1 (= delisted/private) のみ 7 日後に再試行。
    CREATE TABLE IF NOT EXISTS steam_apps_cache (
      appid           INTEGER PRIMARY KEY,
      name            TEXT,
      header_image    TEXT,
      type            TEXT,
      short_desc      TEXT,
      fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
      not_found       INTEGER NOT NULL DEFAULT 0
    );

    -- ローカル駅マスタ (HeartRails Express から起動時に bulk import)。
    -- transit autocomplete を Places API に依存せず、 GPS 近い順 + ターミナル駅
    -- 優先で候補を出すための索引。 同一 「駅名 + 路線 + 都道府県」 で UNIQUE
    -- (= 同じ駅名でも複数路線が乗り入れる場合は別行)。
    --
    -- is_terminal: 同一 line 内で prev_station もしくは next_station が NULL
    -- (= 路線の端) なら 1。 ヒューリスティック。
    CREATE TABLE IF NOT EXISTS stations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      line          TEXT NOT NULL,
      prefecture    TEXT,
      lat           REAL NOT NULL,
      lon           REAL NOT NULL,
      postal        TEXT,
      prev_station  TEXT,
      next_station  TEXT,
      is_terminal   INTEGER NOT NULL DEFAULT 0,
      imported_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, line, prefecture)
    );
    CREATE INDEX IF NOT EXISTS idx_stations_name        ON stations(name);
    CREATE INDEX IF NOT EXISTS idx_stations_prefecture  ON stations(prefecture);
    CREATE INDEX IF NOT EXISTS idx_stations_latlon      ON stations(lat, lon);

    -- 乗った電車/バスの記録。 検索結果 (= ekispert 経路) からそのまま取り込んでも、
    -- 手動入力でも作れる。 segments_json は SearchSegment[] と互換 (= 1 経路に
    -- 複数 line 乗換が入る)。 from_lat/lon は記録時点の GPS (= 開始駅周辺)、
    -- 移動経路 (= tracks) と時系列でマージする際に使う。 終了駅側の lat/lon は
    -- arrival_lat/lon に保持。
    CREATE TABLE IF NOT EXISTS transit_rides (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at       TEXT NOT NULL DEFAULT (datetime('now')),
      from_station      TEXT NOT NULL,
      to_station        TEXT NOT NULL,
      line_name         TEXT,
      train_type        TEXT,
      departure_at      TEXT,
      arrival_at        TEXT,
      duration_min      INTEGER,
      fare_yen          INTEGER,
      from_lat          REAL,
      from_lon          REAL,
      arrival_lat       REAL,
      arrival_lon       REAL,
      transfer_count    INTEGER NOT NULL DEFAULT 0,
      segments_json     TEXT,
      notes             TEXT,
      -- GPS 自動検出の出自を保持 (= detector からのみセット):
      detected_from_gps INTEGER NOT NULL DEFAULT 0,
      gps_start_id      INTEGER,
      gps_end_id        INTEGER,
      max_speed_kmh     REAL
    );
    CREATE INDEX IF NOT EXISTS idx_transit_rides_departure
      ON transit_rides(departure_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transit_rides_recorded
      ON transit_rides(recorded_at DESC);
    -- gps_end_id 一意化で detector 再実行時の重複作成を防ぐ。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transit_rides_gps_end
      ON transit_rides(gps_end_id) WHERE gps_end_id IS NOT NULL;

    -- 天気スナップショット。 1 fetch = 1 行 append。 同じ date に複数行入る
    -- (= 朝・昼・夜と再 fetch しても履歴は残す)。 日記生成は date の最新行を読む。
    -- current/hourly/daily は Open-Meteo の payload を分割して保存。
    CREATE TABLE IF NOT EXISTS weather_snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at   INTEGER NOT NULL,
      date         TEXT NOT NULL,
      lat          REAL NOT NULL,
      lon          REAL NOT NULL,
      current_json TEXT,
      hourly_json  TEXT,
      daily_json   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_weather_snapshots_date
      ON weather_snapshots(date DESC, fetched_at DESC);

    -- マルチソース・アンサンブルの保存。 1 fetch = 1 行。 全API の予報を時刻別に
    -- 突き合わせた結果 (hours_json) と、 どのソースが成功したか (sources_json) を残す。
    -- spec/feature/weather-multisource.md / spec/data/weather.md。
    CREATE TABLE IF NOT EXISTS weather_ensemble_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at          INTEGER NOT NULL,
      date                TEXT NOT NULL,
      lat                 REAL NOT NULL,
      lon                 REAL NOT NULL,
      label               TEXT,
      agreement_threshold REAL NOT NULL,
      sources_json        TEXT NOT NULL,
      hours_json          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_weather_ensemble_fetched
      ON weather_ensemble_snapshots(fetched_at DESC);

    -- 成長型ブラックボックス (汎用ルールエンジン)。 spec/feature/blackbox.md。
    -- ドメイン非依存: 天気 (weather.will_rain / weather.likely_place) が最初の利用者。
    -- when_json は直列化された Condition AST。 output_json は条件成立時の判断結果。
    CREATE TABLE IF NOT EXISTS blackbox_rules (
      id           TEXT PRIMARY KEY,
      domain       TEXT NOT NULL,
      description  TEXT NOT NULL,
      when_json    TEXT NOT NULL,
      output_json  TEXT,
      confidence   REAL NOT NULL DEFAULT 0.7,
      enabled      INTEGER NOT NULL DEFAULT 1,
      source       TEXT NOT NULL DEFAULT 'manual',   -- 'llm' | 'manual' | 'seed'
      approvals    INTEGER NOT NULL DEFAULT 0,
      rejections   INTEGER NOT NULL DEFAULT 0,
      priority     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blackbox_rules_domain
      ON blackbox_rules(domain, enabled, priority DESC);

    -- 判断 ledger。 status='pending_review' AND verdict IS NULL がレビュー待ちキュー。
    CREATE TABLE IF NOT EXISTS blackbox_decisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      domain        TEXT NOT NULL,
      input_json    TEXT,
      features_json TEXT,
      output_json   TEXT,
      source        TEXT NOT NULL,                    -- 'rule' | 'llm'
      rule_id       TEXT,
      confidence    REAL NOT NULL DEFAULT 0,
      rationale     TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL,                    -- 'auto' | 'pending_review'
      verdict       TEXT,                             -- 'ok' | 'ng' | NULL
      created_at    TEXT NOT NULL,
      reviewed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_blackbox_decisions_pending
      ON blackbox_decisions(status, verdict, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blackbox_decisions_domain
      ON blackbox_decisions(domain, created_at DESC);

    -- レビュー対象リポジトリ。 ludiars-review skill (= cloud routine) が
    -- iterate するリスト。 起動時に LUDIARS_ROOT 配下の git clone を seed し、
    -- ユーザは UI から任意のローカルパスを足せる。 format_key は将来カスタム
    -- フォーマットを追加するための拡張点 (現状は 'aiformat' のみ)。
    CREATE TABLE IF NOT EXISTS review_targets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      local_path  TEXT NOT NULL UNIQUE,
      format_key  TEXT NOT NULL DEFAULT 'aiformat',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_targets_enabled ON review_targets(enabled);

    -- AI 主導おすすめ run の履歴。 1 run = 6 agent 並列 Sonnet + Opus 統合の結果。
    -- agent_logs_json:  各 agent の入出力サマリ (= 「なぜ・どうおすすめしたか」 の根拠)
    -- results_json:     Opus 統合済みの最終おすすめリスト (RecommendationItem[])
    -- status:           pending / running / done / error
    CREATE TABLE IF NOT EXISTS recommendation_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      error           TEXT,
      agent_logs_json TEXT,
      results_json    TEXT,
      model_sonnet    TEXT,
      model_opus      TEXT,
      duration_ms     INTEGER,
      result_count    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_recommendation_runs_started
      ON recommendation_runs(started_at DESC);

    -- ウォッチ対象のソース管理リポジトリ。 PR / Issue / デフォルトブランチの
    -- 最終更新を一覧するためのレジストリ。 内部ビューアは持たず、 表示は
    -- すべて元のホスティング先 (GitHub 等) へリンクするだけ。
    -- provider は将来 GitHub 以外 (gitlab / bitbucket / gitea ...) を足す
    -- ための拡張点 (現状は 'github' のみ実装)。
    -- 各 *_count / last_commit_* / fetched_at / fetch_error はホスティング先
    -- API レート制限を避けるための直近フェッチのキャッシュ。 表示は常に
    -- このキャッシュから行い、 refresh で明示的に取り直す。
    CREATE TABLE IF NOT EXISTS repo_watch (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      provider            TEXT NOT NULL DEFAULT 'github',
      owner               TEXT NOT NULL,
      name                TEXT NOT NULL,
      html_url            TEXT NOT NULL,
      default_branch      TEXT,
      open_pr_count       INTEGER,
      open_issue_count    INTEGER,
      last_commit_sha     TEXT,
      last_commit_message TEXT,
      last_commit_url     TEXT,
      last_commit_at      TEXT,
      fetched_at          TEXT,
      fetch_error         TEXT,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, owner, name)
    );
    CREATE INDEX IF NOT EXISTS idx_repo_watch_sort ON repo_watch(sort_order, id);

    -- repo_watch の各リポについて、 直近フェッチ時の open PR / Issue を最大 50 件まで
    -- キャッシュする。 一覧上には top 5 を updated_at DESC で表示、 「more」 で
    -- 50 件まで展開する。 表示時に外部リンクへ飛ばすだけなので body 等は保持しない。
    CREATE TABLE IF NOT EXISTS repo_watch_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id    INTEGER NOT NULL REFERENCES repo_watch(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,                   -- 'pr' | 'issue'
      number     INTEGER NOT NULL,
      title      TEXT NOT NULL,
      html_url   TEXT NOT NULL,
      state      TEXT,                            -- 'open' | 'closed' (現状 open のみ取得)
      author     TEXT,
      updated_at TEXT,                            -- ISO8601
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, kind, number)
    );
    CREATE INDEX IF NOT EXISTS idx_repo_watch_items_recent
      ON repo_watch_items(repo_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint    TEXT NOT NULL UNIQUE,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      label       TEXT,
      user_agent  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active
      ON push_subscriptions(revoked_at) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS meals (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_path                  TEXT NOT NULL,
      eaten_at                    TEXT NOT NULL,
      eaten_at_source             TEXT NOT NULL DEFAULT 'manual',
      lat                         REAL,
      lon                         REAL,
      location_label              TEXT,
      location_source             TEXT,
      description                 TEXT,
      calories                    INTEGER,
      items_json                  TEXT,
      nutrients_json              TEXT,
      ai_status                   TEXT NOT NULL DEFAULT 'pending',
      ai_error                    TEXT,
      user_note                   TEXT,
      user_corrected_description  TEXT,
      user_corrected_calories     INTEGER,
      additions_json              TEXT,
      created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_meals_eaten_at ON meals(eaten_at DESC);
    CREATE INDEX IF NOT EXISTS idx_meals_ai_status ON meals(ai_status);

    CREATE TABLE IF NOT EXISTS implementation_notes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      product       TEXT NOT NULL,
      title         TEXT NOT NULL,
      good_points   TEXT,
      bad_points    TEXT,
      shareable     INTEGER NOT NULL DEFAULT 0,
      shared_at     TEXT,
      shared_origin TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_implementation_notes_created
      ON implementation_notes(created_at DESC);

    CREATE TABLE IF NOT EXISTS tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      details       TEXT,
      status        TEXT NOT NULL DEFAULT 'todo',
      kind          TEXT NOT NULL DEFAULT 'task',
      creator_type  TEXT NOT NULL DEFAULT 'human',
      due_at        TEXT,
      share_actio   INTEGER NOT NULL DEFAULT 0,
      shared_at     TEXT,
      shared_origin TEXT,
      category      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status_created
      ON tasks(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_due
      ON tasks(due_at);
    -- idx_tasks_kind は ALTER で kind カラムを足した後にしか作れないので、
    -- migration block の末尾で作成する (下記 ALTER 群の直後を参照)。

    CREATE TABLE IF NOT EXISTS goal_eval_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id      INTEGER NOT NULL,
      date         TEXT NOT NULL,
      status       TEXT NOT NULL,
      evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(goal_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_eval_logs_date
      ON goal_eval_logs(date DESC);
    CREATE INDEX IF NOT EXISTS idx_goal_eval_logs_goal
      ON goal_eval_logs(goal_id, date DESC);

    CREATE TABLE IF NOT EXISTS agent_projects (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      path           TEXT NOT NULL,
      rules          TEXT,
      default_agent  TEXT NOT NULL DEFAULT 'claude_code',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id        INTEGER,
      project_id     INTEGER,
      agent          TEXT NOT NULL,
      model          TEXT,
      prompt         TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      exit_code      INTEGER,
      log_path       TEXT,
      pid            INTEGER,
      summary        TEXT,
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT,
      mode           TEXT NOT NULL DEFAULT 'local',
      concordia_session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_task
      ON agent_runs(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status
      ON agent_runs(status);

    CREATE TABLE IF NOT EXISTS work_locations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      address        TEXT,
      latitude       REAL,
      longitude      REAL,
      description    TEXT,
      url            TEXT,
      tags           TEXT,
      wifi_ssids     TEXT,
      is_home        INTEGER NOT NULL DEFAULT 0,
      radius_m       INTEGER,
      shareable      INTEGER NOT NULL DEFAULT 0,
      shared_at      TEXT,
      shared_origin  TEXT,
      owner_user_id  TEXT,
      owner_user_name TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_work_locations_created
      ON work_locations(created_at DESC);

    CREATE TABLE IF NOT EXISTS external_chat_messages (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source         TEXT NOT NULL,
      conversation_id TEXT,
      role           TEXT,
      content        TEXT NOT NULL,
      metadata_json  TEXT,
      received_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_external_chat_received
      ON external_chat_messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_external_chat_source
      ON external_chat_messages(source, received_at DESC);

    CREATE TABLE IF NOT EXISTS notes (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL DEFAULT '',
      kind            TEXT NOT NULL DEFAULT 'doc',
      tags_json       TEXT,
      bookmark_id     INTEGER,
      bookmark_url    TEXT,
      source_kind     TEXT,
      source_ref      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      owner_user_id   TEXT,
      owner_user_name TEXT,
      shared_at       TEXT,
      shared_origin   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind);
    CREATE INDEX IF NOT EXISTS idx_notes_bookmark ON notes(bookmark_id);
    CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(source_kind, source_ref);

    CREATE TABLE IF NOT EXISTS note_blocks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid        TEXT NOT NULL UNIQUE,
      note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      position    REAL NOT NULL,
      block_type  TEXT NOT NULL DEFAULT 'text',
      text        TEXT NOT NULL DEFAULT '',
      data_json   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_note_blocks_note_position
      ON note_blocks(note_id, position);
    CREATE INDEX IF NOT EXISTS idx_note_blocks_uuid
      ON note_blocks(uuid);

    CREATE TABLE IF NOT EXISTS note_comment_sets (
      id              TEXT PRIMARY KEY,
      note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      owner_user_id   TEXT,
      owner_user_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      shared_at       TEXT,
      shared_origin   TEXT,
      UNIQUE (note_id, owner_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_note_comment_sets_note
      ON note_comment_sets(note_id);

    CREATE TABLE IF NOT EXISTS note_comments (
      id                TEXT PRIMARY KEY,
      set_id            TEXT NOT NULL REFERENCES note_comment_sets(id) ON DELETE CASCADE,
      target_block_uuid TEXT,
      position          REAL NOT NULL,
      text              TEXT NOT NULL DEFAULT '',
      data_json         TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_note_comments_set_position
      ON note_comments(set_id, position);
    CREATE INDEX IF NOT EXISTS idx_note_comments_target
      ON note_comments(target_block_uuid);
  `);

  // notes rev1 → rev2: 旧 INTEGER 行を UUID で再挿入
  if (pendingNotesMigration) {
    const idMap = new Map<number, string>();
    const insertNoteStmt = db.prepare(`
      INSERT INTO notes (id, title, kind, tags_json, source_kind, source_ref, created_at, updated_at,
                         owner_user_id, owner_user_name, shared_at, shared_origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBlockStmt = db.prepare(`
      INSERT INTO note_blocks (uuid, note_id, position, block_type, text, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const n of pendingNotesMigration!.notes) {
        const oldId = Number(n.id);
        const newId = randomUUID();
        idMap.set(oldId, newId);
        insertNoteStmt.run(
          newId,
          (n.title ?? '') as string,
          (n.kind ?? 'doc') as string,
          (n.tags_json ?? null) as string | null,
          (n.source_kind ?? null) as string | null,
          (n.source_ref ?? null) as string | null,
          (n.created_at ?? null) as string | null,
          (n.updated_at ?? null) as string | null,
          (n.owner_user_id ?? null) as string | null,
          (n.owner_user_name ?? null) as string | null,
          (n.shared_at ?? null) as string | null,
          (n.shared_origin ?? null) as string | null,
        );
      }
      for (const b of pendingNotesMigration!.blocks) {
        const oldNoteId = Number(b.note_id);
        const newNoteId = idMap.get(oldNoteId);
        if (!newNoteId) continue;
        insertBlockStmt.run(
          randomUUID(),
          newNoteId,
          (b.position ?? 0) as number,
          (b.block_type ?? 'text') as string,
          (b.text ?? '') as string,
          (b.data_json ?? null) as string | null,
          (b.created_at ?? null) as string | null,
          (b.updated_at ?? null) as string | null,
        );
      }
    });
    tx();
    console.log(`[notes] rev1→rev2 migration applied (${idMap.size} notes preserved)`);
    pendingNotesMigration = null;
  }

  // Forward-compat: 既存 DB に列を ALTER で追加
  // Forward-compat: work_locations に wifi_ssids 列を追加 (Electron 起動時の SSID
  // matching 用、 旧 DB は NULL のまま)。
  const wlCols = (db.prepare(`PRAGMA table_info(work_locations)`).all() as { name: string }[]).map(c => c.name);
  if (wlCols.length > 0 && !wlCols.includes('wifi_ssids')) {
    db.exec(`ALTER TABLE work_locations ADD COLUMN wifi_ssids TEXT`);
  }
  // is_home: 有線接続時のデフォルト workplace。 1 つだけ true にできる (= UI で
  // 排他制御、 ここでは制約までは設けない)。
  if (wlCols.length > 0 && !wlCols.includes('is_home')) {
    db.exec(`ALTER TABLE work_locations ADD COLUMN is_home INTEGER NOT NULL DEFAULT 0`);
  }
  // radius_m: 場所ごとの GPS 誤差許容半径 (m)。 NULL の場合は global の
  // `workplace_match_radius_m` 設定を使う。 都市公園 vs オフィスビルなど、
  // 場所の物理的な大きさに応じて個別に設定できるようにする。
  if (wlCols.length > 0 && !wlCols.includes('radius_m')) {
    db.exec(`ALTER TABLE work_locations ADD COLUMN radius_m INTEGER`);
  }

  // repo_watch: CI (GitHub Actions 最新 run) のキャッシュ列を後付け。
  const repoWatchCols = (db.prepare(`PRAGMA table_info(repo_watch)`).all() as { name: string }[]).map(c => c.name);
  const repoWatchAlters: ReadonlyArray<readonly [string, string]> = [
    ['ci_status', 'TEXT'],         // queued / in_progress / completed
    ['ci_conclusion', 'TEXT'],     // success / failure / cancelled / skipped / null
    ['ci_url', 'TEXT'],            // workflow run の html_url
    ['ci_workflow_name', 'TEXT'],
    ['ci_run_at', 'TEXT'],         // ISO8601 (workflow run の updated_at)
  ];
  for (const [col, ddl] of repoWatchAlters) {
    if (repoWatchCols.length > 0 && !repoWatchCols.includes(col)) {
      db.exec(`ALTER TABLE repo_watch ADD COLUMN ${col} ${ddl}`);
    }
  }

  const mealsCols = (db.prepare(`PRAGMA table_info(meals)`).all() as { name: string }[]).map(c => c.name);
  if (mealsCols.length > 0 && !mealsCols.includes('additions_json')) {
    db.exec(`ALTER TABLE meals ADD COLUMN additions_json TEXT`);
  }
  if (mealsCols.length > 0 && !mealsCols.includes('nutrients_json')) {
    db.exec(`ALTER TABLE meals ADD COLUMN nutrients_json TEXT`);
  }

  const implCols = (db.prepare(`PRAGMA table_info(implementation_notes)`).all() as { name: string }[]).map(c => c.name);
  for (const col of ['shared_at', 'shared_origin']) {
    if (implCols.length > 0 && !implCols.includes(col)) {
      db.exec(`ALTER TABLE implementation_notes ADD COLUMN ${col} TEXT`);
    }
  }
  if (implCols.length > 0 && !implCols.includes('attachment_type')) {
    db.exec(`ALTER TABLE implementation_notes ADD COLUMN attachment_type TEXT`);
  }
  if (implCols.length > 0 && !implCols.includes('attachment_value')) {
    db.exec(`ALTER TABLE implementation_notes ADD COLUMN attachment_value TEXT`);
  }

  const taskCols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(c => c.name);
  const taskAlters: ReadonlyArray<readonly [string, string]> = [
    ['due_at', 'TEXT'],
    ['creator_type', `TEXT NOT NULL DEFAULT 'human'`],
    ['share_actio', 'INTEGER NOT NULL DEFAULT 0'],
    ['shared_at', 'TEXT'],
    ['shared_origin', 'TEXT'],
    ['category', 'TEXT'],
    ['kind', `TEXT NOT NULL DEFAULT 'task'`],
  ];
  for (const [col, ddl] of taskAlters) {
    if (taskCols.length > 0 && !taskCols.includes(col)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${ddl}`);
    }
  }
  // kind カラムは ALTER で足したばかり (or 元から存在) — どちらにせよ
  // index を作る。 IF NOT EXISTS で冪等。
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)`);
  // agent_runs.model / .mode / .concordia_session_id — add if missing on existing DBs.
  // CREATE INDEX は ALTER の後で発行する (memory: sqlite-create-index-after-alter).
  const arCols = (db.prepare(`PRAGMA table_info(agent_runs)`).all() as { name: string }[]).map(c => c.name);
  if (arCols.length > 0 && !arCols.includes('model')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN model TEXT`);
  }
  if (arCols.length > 0 && !arCols.includes('mode')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'local'`);
  }
  if (arCols.length > 0 && !arCols.includes('concordia_session_id')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN concordia_session_id TEXT`);
  }

  // Forward-compat: ensure newer columns exist on older word_clouds tables.
  const wcCols = (db.prepare(`PRAGMA table_info(word_clouds)`).all() as { name: string }[]).map(c => c.name);
  if (!wcCols.includes('origin_bookmark_id')) {
    db.exec(`ALTER TABLE word_clouds ADD COLUMN origin_bookmark_id INTEGER`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_word_clouds_bookmark ON word_clouds(origin_bookmark_id)`);
  }

  const dsCols = (db.prepare(`PRAGMA table_info(dig_sessions)`).all() as { name: string }[]).map(c => c.name);
  if (!dsCols.includes('preview_json')) {
    db.exec(`ALTER TABLE dig_sessions ADD COLUMN preview_json TEXT`);
  }
  if (!dsCols.includes('theme')) {
    db.exec(`ALTER TABLE dig_sessions ADD COLUMN theme TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dig_sessions_theme
              ON dig_sessions(theme, created_at DESC)`);
  }
  // Raw SERP scrape (no LLM) — populated within ~2s of dig submit so the UI
  // can show Google-style hits instantly. Lives alongside `preview_json`
  // (Claude's annotated overview) and `result_json` (full deep dig).
  if (!dsCols.includes('raw_results_json')) {
    db.exec(`ALTER TABLE dig_sessions ADD COLUMN raw_results_json TEXT`);
  }
  // レビュー画面から発生した dig の出自を保存。
  //   origin_kind  : 'review' のみ (将来別の発生源を足すための拡張)
  //   origin_repo  : 'Memoria' 等の repo 名
  //   origin_date  : 'YYYY-MM-DD' のレビュー日付
  //   origin_file  : 'REVIEW.md' / 'REVIEW_DESIGN.md' 等
  // dig タブ側は無視して良い。 レビュー画面で同じ repo×date×file の dig
  // を再表示するために使う。
  if (!dsCols.includes('origin_kind'))  db.exec(`ALTER TABLE dig_sessions ADD COLUMN origin_kind TEXT`);
  if (!dsCols.includes('origin_repo'))  db.exec(`ALTER TABLE dig_sessions ADD COLUMN origin_repo TEXT`);
  if (!dsCols.includes('origin_date'))  db.exec(`ALTER TABLE dig_sessions ADD COLUMN origin_date TEXT`);
  if (!dsCols.includes('origin_file'))  db.exec(`ALTER TABLE dig_sessions ADD COLUMN origin_file TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dig_sessions_origin_review
            ON dig_sessions(origin_kind, origin_repo, origin_date, origin_file, created_at DESC)
           WHERE origin_kind = 'review'`);

  const deCols = (db.prepare(`PRAGMA table_info(diary_entries)`).all() as { name: string }[]).map(c => c.name);
  if (!deCols.includes('work_content')) db.exec(`ALTER TABLE diary_entries ADD COLUMN work_content TEXT`);
  if (!deCols.includes('highlights'))   db.exec(`ALTER TABLE diary_entries ADD COLUMN highlights TEXT`);
  // Sonnet (`diary_work`) infers focused work minutes from the URL timeline
  // and writes it here. Replaces the visit_events session heuristic, which
  // over-counted days with long idle browser tabs (see trendsWorkHours).
  if (!deCols.includes('work_minutes')) db.exec(`ALTER TABLE diary_entries ADD COLUMN work_minutes INTEGER`);

  // gps_locations: 圧縮メタ列を後付けで足す
  const gpsCols = (db.prepare(`PRAGMA table_info(gps_locations)`).all() as { name: string }[]).map(c => c.name);
  if (gpsCols.length > 0 && !gpsCols.includes('samples_count')) {
    db.exec(`ALTER TABLE gps_locations ADD COLUMN samples_count INTEGER NOT NULL DEFAULT 1`);
  }
  if (gpsCols.length > 0 && !gpsCols.includes('samples_first_at')) {
    db.exec(`ALTER TABLE gps_locations ADD COLUMN samples_first_at TEXT`);
  }
  // 位置照合 (Google Geocoding/Places で日本語の場所説明を付ける) 用 4 列
  if (gpsCols.length > 0 && !gpsCols.includes('place_name')) {
    db.exec(`ALTER TABLE gps_locations ADD COLUMN place_name TEXT`);
  }
  if (gpsCols.length > 0 && !gpsCols.includes('place_address')) {
    db.exec(`ALTER TABLE gps_locations ADD COLUMN place_address TEXT`);
  }
  if (gpsCols.length > 0 && !gpsCols.includes('place_source')) {
    db.exec(`ALTER TABLE gps_locations ADD COLUMN place_source TEXT`);
  }
  if (gpsCols.length > 0 && !gpsCols.includes('place_resolved_at')) {
    db.exec(`ALTER TABLE gps_locations ADD COLUMN place_resolved_at INTEGER`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gps_locations_unresolved
           ON gps_locations(place_resolved_at) WHERE place_resolved_at IS NULL`);

  // transit_rides: GPS 自動検出由来のカラムを後付け。
  //   detected_from_gps : 1 なら検出器が作った行 (= UI で🛰 バッジ)
  //   gps_start_id      : 出発駅相当 (= 移動開始直前の settled 点) gps_locations.id
  //   gps_end_id        : 到着駅相当 (= 移動完了後の settled 点) gps_locations.id
  //   max_speed_kmh     : 移動中の最大速度 (= 列車/バス/自動車の判別ヒント)
  const trCols = (db.prepare(`PRAGMA table_info(transit_rides)`).all() as { name: string }[]).map(c => c.name);
  if (trCols.length > 0) {
    if (!trCols.includes('detected_from_gps')) db.exec(`ALTER TABLE transit_rides ADD COLUMN detected_from_gps INTEGER NOT NULL DEFAULT 0`);
    if (!trCols.includes('gps_start_id'))      db.exec(`ALTER TABLE transit_rides ADD COLUMN gps_start_id INTEGER`);
    if (!trCols.includes('gps_end_id'))        db.exec(`ALTER TABLE transit_rides ADD COLUMN gps_end_id INTEGER`);
    if (!trCols.includes('max_speed_kmh'))     db.exec(`ALTER TABLE transit_rides ADD COLUMN max_speed_kmh REAL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transit_rides_gps_end
             ON transit_rides(gps_end_id) WHERE gps_end_id IS NOT NULL`);
  }

  const dcCols = (db.prepare(`PRAGMA table_info(domain_catalog)`).all() as { name: string }[]).map(c => c.name);
  if (!dcCols.includes('site_name'))   db.exec(`ALTER TABLE domain_catalog ADD COLUMN site_name TEXT`);
  if (!dcCols.includes('can_do'))      db.exec(`ALTER TABLE domain_catalog ADD COLUMN can_do TEXT`);
  if (!dcCols.includes('notes'))       db.exec(`ALTER TABLE domain_catalog ADD COLUMN notes TEXT`);
  if (!dcCols.includes('user_edited')) db.exec(`ALTER TABLE domain_catalog ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0`);
  if (!dcCols.includes('domain_private')) db.exec(`ALTER TABLE domain_catalog ADD COLUMN domain_private INTEGER NOT NULL DEFAULT 0`);

  // Phase 1 (multi-server): ownership / share metadata on the three shareable
  // resources. NULL owner_user_id = "this is mine" on a local server.
  // Same columns exist on the multi-server schema (Postgres) — see docs/.
  const shareCols = ['owner_user_id', 'owner_user_name', 'shared_at', 'shared_origin'];
  for (const tbl of ['bookmarks', 'dictionary_entries', 'dig_sessions']) {
    const existing = (db.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string }[]).map(c => c.name);
    for (const col of shareCols) {
      if (!existing.includes(col)) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} TEXT`);
    }
  }

  // visit_events: external タップ (Legatus DNS / SNI) 対応カラム
  // device_label = Tailscale でタグ付けされた発信元 (例: "iphone-of-foo")
  // device_os    = "iOS" / "Android" / "macOS" / "Windows" / "Linux" / null
  // source       = "browser" (拡張機能からの POST), "dns" (Legatus dnstap),
  //                "sni" (Legatus SNI tap, 将来拡張)
  const veCols = (db.prepare(`PRAGMA table_info(visit_events)`).all() as { name: string }[]).map(c => c.name);
  if (!veCols.includes('device_label')) db.exec(`ALTER TABLE visit_events ADD COLUMN device_label TEXT`);
  if (!veCols.includes('device_os'))    db.exec(`ALTER TABLE visit_events ADD COLUMN device_os TEXT`);
  if (!veCols.includes('source'))       db.exec(`ALTER TABLE visit_events ADD COLUMN source TEXT`);

  // Forward-compat: ensure newer columns exist on older DBs.
  const cols = (db.prepare(`PRAGMA table_info(bookmarks)`).all() as { name: string }[]).map(c => c.name);
  if (!cols.includes('last_accessed_at')) {
    db.exec(`ALTER TABLE bookmarks ADD COLUMN last_accessed_at TEXT`);
  }
  if (!cols.includes('access_count')) {
    db.exec(`ALTER TABLE bookmarks ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
  }

  // RSS リーダー + トレンド取り込みドメインのスキーマ (自己完結モジュール)。
  ensureRssSchema(db);

  return db;
}

// ── push_subscriptions DAO ────────────────────────────────────

export function findPushSubscriptionByEndpoint(db: Db, endpoint: string): PushSubscriptionRow | undefined {
  return db.prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`).get(endpoint) as PushSubscriptionRow | undefined;
}

export interface PushSubscriptionListItem {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
}

export function listActivePushSubscriptions(db: Db): PushSubscriptionListItem[] {
  return db.prepare(`
    SELECT id, endpoint, p256dh, auth, label, user_agent, created_at
    FROM push_subscriptions
    WHERE revoked_at IS NULL
    ORDER BY created_at DESC
  `).all() as PushSubscriptionListItem[];
}

export interface PushSubscriptionMetaItem {
  id: number;
  endpoint: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
  revoked_at: string | null;
}

export function listPushSubscriptions(db: Db): PushSubscriptionMetaItem[] {
  return db.prepare(`
    SELECT id, endpoint, label, user_agent, created_at, revoked_at
    FROM push_subscriptions
    ORDER BY (revoked_at IS NOT NULL), created_at DESC
  `).all() as PushSubscriptionMetaItem[];
}

export interface InsertPushSubscriptionInput {
  id?: number | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string | null;
  userAgent?: string | null;
  revokedAt?: string | null;
}

/**
 * Insert / update a subscription. If `id` is supplied the row is upserted
 * (used to re-enable a revoked endpoint without losing its label).
 * Returns the row id.
 */
export function insertPushSubscription(
  db: Db,
  { id, endpoint, p256dh, auth, label, userAgent, revokedAt }: InsertPushSubscriptionInput,
): number {
  if (id) {
    db.prepare(`
      UPDATE push_subscriptions
      SET endpoint = ?, p256dh = ?, auth = ?, label = ?, user_agent = ?, revoked_at = ?
      WHERE id = ?
    `).run(endpoint, p256dh, auth, label ?? null, userAgent ?? null, revokedAt ?? null, id);
    return id;
  }
  const info = db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(endpoint, p256dh, auth, label ?? null, userAgent ?? null);
  return Number(info.lastInsertRowid);
}

export function markPushSubscriptionRevoked(db: Db, id: number): void {
  db.prepare(`UPDATE push_subscriptions SET revoked_at = datetime('now') WHERE id = ?`).run(id);
}

export function deletePushSubscription(db: Db, id: number): number {
  const info = db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(id);
  return info.changes;
}

// ── bookmarks DAO ─────────────────────────────────────────────

export type BookmarkSort = 'created_desc' | 'created_asc' | 'accessed_desc' | 'accessed_asc' | 'title_asc';

export interface ListBookmarksOptions {
  category?: string;
  sort?: BookmarkSort;
  limit?: number;
  offset?: number;
  q?: string;
}

export interface BookmarkWithCategories extends BookmarkRow {
  categories: string[];
}

/**
 * List bookmarks with optional category / search / pagination.
 *
 * - `q` does a SQL LIKE across title / url / summary so the front-end
 *   doesn't have to keep all rows in memory just to do client-side filtering
 *   (the original UI fetched everything and filtered locally — fine at
 *   100 bookmarks, painful at thousands).
 * - `limit` is opt-in. Internal callers that want every bookmark (cloud
 *   extraction, export, recommendations) keep working unchanged because
 *   the function still returns a plain array; pagination is only applied
 *   when `limit` is a positive number. Use `countBookmarks` for the total
 *   when paginating.
 */
export function listBookmarks(
  db: Db,
  { category, sort = 'created_desc', limit, offset = 0, q }: ListBookmarksOptions = {},
): BookmarkWithCategories[] {
  const orderClauses: Record<BookmarkSort, string> = {
    created_desc: 'b.created_at DESC',
    created_asc: 'b.created_at ASC',
    accessed_desc: 'COALESCE(b.last_accessed_at, b.created_at) DESC',
    accessed_asc: 'COALESCE(b.last_accessed_at, b.created_at) ASC',
    title_asc: 'b.title ASC',
  };
  const orderBy = orderClauses[sort] ?? orderClauses.created_desc;
  const where: string[] = [];
  const params: unknown[] = [];
  let join = '';
  if (category) {
    join = 'JOIN bookmark_categories bc ON bc.bookmark_id = b.id';
    where.push('bc.category = ?');
    params.push(category);
  }
  if (q) {
    where.push("(b.title LIKE ? OR b.url LIKE ? OR COALESCE(b.summary, '') LIKE ?)");
    const pat = `%${q}%`;
    params.push(pat, pat, pat);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let sql = `SELECT b.* FROM bookmarks b ${join} ${whereClause} ORDER BY ${orderBy}`;
  const queryParams: unknown[] = [...params];
  if (Number.isFinite(limit) && (limit as number) > 0) {
    sql += ' LIMIT ? OFFSET ?';
    queryParams.push(Math.floor(limit as number), Math.max(0, Math.floor(offset) || 0));
  }
  const rows = db.prepare(sql).all(...queryParams) as BookmarkRow[];
  return rows.map(r => ({ ...r, categories: getCategories(db, r.id) }));
}

export interface CountBookmarksOptions {
  category?: string;
  q?: string;
}

/** Count bookmarks matching the same filters as `listBookmarks`. Cheaper
 * than fetching everything just to check `length`, and lets the UI show
 * "全 N 件中 M 件表示中" when paginating. */
export function countBookmarks(db: Db, { category, q }: CountBookmarksOptions = {}): number {
  const where: string[] = [];
  const params: unknown[] = [];
  let join = '';
  if (category) {
    join = 'JOIN bookmark_categories bc ON bc.bookmark_id = b.id';
    where.push('bc.category = ?');
    params.push(category);
  }
  if (q) {
    where.push("(b.title LIKE ? OR b.url LIKE ? OR COALESCE(b.summary, '') LIKE ?)");
    const pat = `%${q}%`;
    params.push(pat, pat, pat);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(DISTINCT b.id) AS n FROM bookmarks b ${join} ${whereClause}`)
    .get(...params) as { n: number };
  return row.n;
}

export function getBookmark(db: Db, id: number): BookmarkWithCategories | null {
  const row = db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id) as BookmarkRow | undefined;
  if (!row) return null;
  return { ...row, categories: getCategories(db, id) };
}

export function getCategories(db: Db, bookmarkId: number): string[] {
  return (db.prepare(`SELECT category FROM bookmark_categories WHERE bookmark_id = ? ORDER BY category`)
    .all(bookmarkId) as { category: string }[])
    .map(r => r.category);
}

export interface CategoryWithCount {
  category: string;
  count: number;
}

export function listAllCategories(db: Db): CategoryWithCount[] {
  return db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM bookmark_categories
    GROUP BY category
    ORDER BY count DESC, category ASC
  `).all() as CategoryWithCount[];
}

export interface InsertBookmarkInput {
  url: string;
  title: string;
  htmlPath: string;
}

export function insertBookmark(db: Db, { url, title, htmlPath }: InsertBookmarkInput): number {
  const stmt = db.prepare(`
    INSERT INTO bookmarks (url, title, html_path) VALUES (?, ?, ?)
  `);
  const info = stmt.run(url, title, htmlPath);
  return Number(info.lastInsertRowid);
}

export function findBookmarkByUrl(db: Db, url: string): BookmarkRow | null {
  return (db.prepare(`SELECT * FROM bookmarks WHERE url = ? ORDER BY id DESC LIMIT 1`)
    .get(url) as BookmarkRow | undefined) ?? null;
}

export interface SetSummaryInput {
  summary?: string | null;
  categories?: string[];
  status: string;
  error?: string | null;
}

export function setSummary(db: Db, id: number, { summary, categories, status, error }: SetSummaryInput): void {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE bookmarks
      SET summary = ?, status = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(summary ?? null, status, error ?? null, id);

    if (Array.isArray(categories)) {
      db.prepare(`DELETE FROM bookmark_categories WHERE bookmark_id = ?`).run(id);
      const ins = db.prepare(`INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category) VALUES (?, ?)`);
      for (const cat of categories) {
        const trimmed = String(cat).trim();
        if (trimmed) ins.run(id, trimmed);
      }
    }
  });
  tx();
}

export interface UpdateMemoAndCategoriesInput {
  memo?: string;
  categories?: string[];
}

export function updateMemoAndCategories(db: Db, id: number, { memo, categories }: UpdateMemoAndCategoriesInput): void {
  const tx = db.transaction(() => {
    if (typeof memo === 'string') {
      db.prepare(`UPDATE bookmarks SET memo = ?, updated_at = datetime('now') WHERE id = ?`).run(memo, id);
    }
    if (Array.isArray(categories)) {
      db.prepare(`DELETE FROM bookmark_categories WHERE bookmark_id = ?`).run(id);
      const ins = db.prepare(`INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category) VALUES (?, ?)`);
      for (const cat of categories) {
        const trimmed = String(cat).trim();
        if (trimmed) ins.run(id, trimmed);
      }
    }
  });
  tx();
}

export interface UpsertVisitInput {
  url: string;
  title?: string | null;
}

/** Upsert a visit row for any URL (whether bookmarked or not). */
export function upsertVisit(db: Db, { url, title }: UpsertVisitInput): void {
  db.prepare(`
    INSERT INTO page_visits (url, title)
    VALUES (?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = COALESCE(NULLIF(excluded.title, ''), page_visits.title),
      last_seen_at = datetime('now'),
      visit_count = page_visits.visit_count + 1
  `).run(url, title ?? null);
}

export interface ListUnsavedVisitsOptions {
  since?: string;
}

/**
 * URLs visited today (local time) that are NOT yet bookmarked.
 * `since` is an optional ISO string lower bound; default = start of local day.
 */
export function listUnsavedVisits(db: Db, { since }: ListUnsavedVisitsOptions = {}): PageVisitRow[] {
  const sinceClause = since
    ? `v.last_seen_at >= ?`
    : `date(v.last_seen_at, 'localtime') = date('now', 'localtime')`;
  const args = since ? [since] : [];
  return db.prepare(`
    SELECT v.url, v.title, v.first_seen_at, v.last_seen_at, v.visit_count
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE b.id IS NULL
      AND ${sinceClause}
    ORDER BY v.last_seen_at DESC
  `).all(...args) as PageVisitRow[];
}

export function deleteVisit(db: Db, url: string): void {
  db.prepare(`DELETE FROM page_visits WHERE url = ?`).run(url);
}

export interface SuggestedVisit extends PageVisitRow {
  domain: string | null;
  same_domain_bookmarks: number;
  same_path_prefix_bookmarks: 0 | 1;
  score: number;
}

/**
 * Unsaved visits enriched with domain stats and a "miss-bookmark likelihood" score.
 * The intent is to surface URLs that the user is probably reading but hasn't bookmarked
 * because the same domain (or path prefix) is already in their library.
 */
export function listSuggestedVisits(db: Db, { sinceDays = 30 }: { sinceDays?: number } = {}): SuggestedVisit[] {
  const visits = db.prepare(`
    SELECT v.url, v.title, v.first_seen_at, v.last_seen_at, v.visit_count
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE b.id IS NULL
      AND v.last_seen_at >= datetime('now', ?)
    ORDER BY v.last_seen_at DESC
  `).all(`-${Number(sinceDays) || 30} days`) as PageVisitRow[];

  const bookmarkUrls = (db.prepare(`SELECT url FROM bookmarks`).all() as { url: string }[]).map(r => r.url);
  const domainCounts = new Map<string, number>();
  const pathPrefixIndex = new Map<string, Set<string>>();
  for (const u of bookmarkUrls) {
    const d = extractDomain(u);
    if (!d) continue;
    domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
    const segs = firstPathSegment(u);
    if (segs) {
      if (!pathPrefixIndex.has(d)) pathPrefixIndex.set(d, new Set());
      pathPrefixIndex.get(d)!.add(segs);
    }
  }

  return visits.map(v => {
    const domain = extractDomain(v.url);
    const firstSeg = firstPathSegment(v.url);
    const sameDomain = domain ? (domainCounts.get(domain) || 0) : 0;
    const samePrefix: 0 | 1 = (domain && firstSeg && pathPrefixIndex.get(domain)?.has(firstSeg)) ? 1 : 0;
    const score = sameDomain * 10 + samePrefix * 8 + Math.min(v.visit_count || 1, 20) * 2;
    return {
      ...v,
      domain,
      same_domain_bookmarks: sameDomain,
      same_path_prefix_bookmarks: samePrefix,
      score,
    };
  }).sort((a, b) => b.score - a.score || (a.last_seen_at < b.last_seen_at ? 1 : -1));
}

// ── dig sessions ----------------------------------------------------------

export interface DigOriginReview {
  kind: 'review';
  repo: string;
  date: string;
  file: string;
}

export function insertDigSession(
  db: Db,
  query: string,
  theme: string | null = null,
  origin: DigOriginReview | null = null,
): number {
  const info = db
    .prepare(`INSERT INTO dig_sessions (query, theme, origin_kind, origin_repo, origin_date, origin_file)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      query,
      theme || null,
      origin?.kind ?? null,
      origin?.repo ?? null,
      origin?.date ?? null,
      origin?.file ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** 指定 repo×date×file から発生した dig session を新しい順で返す。
 *  レビュー画面の各ファイル末尾で 「過去のディグ履歴」 として再表示する用。 */
export function listDigsForReview(
  db: Db,
  { repo, date, file }: { repo: string; date: string; file: string },
): DigSessionRow[] {
  return db.prepare(
    `SELECT id, query, theme, status, error, result_json, preview_json, raw_results_json,
            created_at, origin_kind, origin_repo, origin_date, origin_file
       FROM dig_sessions
      WHERE origin_kind = 'review'
        AND origin_repo = ?
        AND origin_date = ?
        AND origin_file = ?
      ORDER BY created_at DESC`,
  ).all(repo, date, file) as DigSessionRow[];
}

export interface SetDigResultInput {
  status: string;
  result?: unknown;
  error?: string | null;
}

export function setDigResult(db: Db, id: number, { status, result, error }: SetDigResultInput): void {
  db.prepare(`
    UPDATE dig_sessions SET status = ?, result_json = ?, error = ?
    WHERE id = ?
  `).run(status, result ? JSON.stringify(result) : null, error ?? null, id);
}

export function setDigPreview(db: Db, id: number, preview: unknown): void {
  db.prepare(`UPDATE dig_sessions SET preview_json = ? WHERE id = ?`)
    .run(preview ? JSON.stringify(preview) : null, id);
}

/** Persist the no-AI SERP scrape (`runDigRawSerp` output). Called as soon
 * as the scrape lands so the FE can render Google-style results before any
 * Claude phase finishes. */
export function setDigRawResults(db: Db, id: number, raw: unknown): void {
  db.prepare(`UPDATE dig_sessions SET raw_results_json = ? WHERE id = ?`)
    .run(raw ? JSON.stringify(raw) : null, id);
}

/**
 * Drop a dig session. Used to clean up 誤 Dig (mis-typed query, junk results,
 * etc.). 関連レコード:
 *   - dictionary_links (source_kind='dig', source_id=id) — 残しても 「Dig
 *     ソース消失」 と表示されるだけなので壊れない
 *   - word_clouds (origin_dig_id=id) — 同上 (origin_dig_id が orphan になる
 *     だけ)
 * 走行中の queue ジョブが後から `setDigResult` を呼んでも、 行が無いので
 * UPDATE が何もしないだけで安全。
 */
export function deleteDigSession(db: Db, id: number): number {
  const info = db.prepare(`DELETE FROM dig_sessions WHERE id = ?`).run(id);
  return info.changes;
}

export interface DigSessionParsed extends DigSessionRow {
  result: unknown;
  preview: unknown;
  raw_results: unknown;
}

export function getDigSession(db: Db, id: number): DigSessionParsed | null {
  const row = db.prepare(`SELECT * FROM dig_sessions WHERE id = ?`).get(id) as DigSessionRow | undefined;
  if (!row) return null;
  return {
    ...row,
    result: row.result_json ? safeParse(row.result_json) : null,
    preview: row.preview_json ? safeParse(row.preview_json) : null,
    raw_results: row.raw_results_json ? safeParse(row.raw_results_json) : null,
  };
}

export interface DigSessionListItem {
  id: number;
  query: string;
  theme: string | null;
  status: string;
  created_at: string;
}

export function listDigSessions(db: Db, { theme, limit = 30 }: { theme?: string | null; limit?: number } = {}): DigSessionListItem[] {
  if (theme) {
    return db.prepare(`
      SELECT id, query, theme, status, created_at FROM dig_sessions
      WHERE theme = ?
      ORDER BY id DESC LIMIT ?
    `).all(theme, limit) as DigSessionListItem[];
  }
  return db.prepare(`
    SELECT id, query, theme, status, created_at FROM dig_sessions
    ORDER BY id DESC LIMIT ?
  `).all(limit) as DigSessionListItem[];
}

export interface DigThemeRow {
  theme: string;
  session_count: number;
  last_at: string;
  last_query: string | null;
}

/// テーマ一覧 (各テーマのセッション数 + 最新時刻 + 直近クエリ)。
/// theme = NULL のセッションは除外。
export function listDigThemes(db: Db, limit = 60): DigThemeRow[] {
  return db.prepare(`
    SELECT
      theme                      AS theme,
      COUNT(*)                   AS session_count,
      MAX(created_at)            AS last_at,
      (SELECT query FROM dig_sessions s2
        WHERE s2.theme = s.theme
        ORDER BY s2.created_at DESC LIMIT 1) AS last_query
    FROM dig_sessions s
    WHERE theme IS NOT NULL AND theme <> ''
    GROUP BY theme
    ORDER BY last_at DESC
    LIMIT ?
  `).all(limit) as DigThemeRow[];
}

export interface DigThemeContext {
  queries: string[];
  topics: { word: string; count: number }[];
  sources: { url: string; title: string }[];
}

interface DigThemeSessionRow {
  id: number;
  query: string;
  result_json: string | null;
}

/// あるテーマで過去に取得した topics / source 情報をまとめる。
/// LLM プロンプトに渡すコンテキスト用。
export function digThemeContext(db: Db, theme: string, { limit = 8 }: { limit?: number } = {}): DigThemeContext {
  const sessions = db.prepare(`
    SELECT id, query, result_json FROM dig_sessions
    WHERE theme = ? AND status = 'done' AND result_json IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(theme, limit) as DigThemeSessionRow[];
  const topics = new Map<string, number>(); // topic -> count
  const sources: { url: string; title: string }[] = []; // {url, title}
  const queries: string[] = [];
  for (const s of sessions) {
    queries.push(s.query);
    const parsed = safeParse(s.result_json) as { sources?: { url?: string; title?: string; topics?: unknown[] }[] } | null;
    if (!parsed) continue;
    for (const src of parsed.sources || []) {
      if (src.url && sources.length < 30) {
        sources.push({ url: src.url, title: src.title || '' });
      }
      for (const t of src.topics || []) {
        const k = String(t).trim().toLowerCase();
        if (!k) continue;
        topics.set(k, (topics.get(k) || 0) + 1);
      }
    }
  }
  const topTopics = [...topics.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }));
  return { queries, topics: topTopics, sources };
}

export interface DigSessionForDate extends DigSessionRow {
  result: unknown;
  preview: unknown;
}

/** Dig sessions whose created_at falls on the given local date. */
export function digSessionsForDate(db: Db, dateStr: string): DigSessionForDate[] {
  const rows = db.prepare(`
    SELECT * FROM dig_sessions
    WHERE date(created_at, 'localtime') = ?
    ORDER BY created_at ASC
  `).all(dateStr) as DigSessionRow[];
  return rows.map(r => ({
    ...r,
    result: r.result_json ? safeParse(r.result_json) : null,
    preview: r.preview_json ? safeParse(r.preview_json) : null,
  }));
}

// ── worklog browsing aggregations (per-date) ─────────────────────────────
//
// 「作業ログ」 タブの「ブラウジング」 サブビューが叩く集計群。 page_visits は
// last_seen_at しか持たないため、 同じ URL を別日に複数回開いた場合は最後の日付
// にしか紐付かない (visit_events は per-event で残るが、 そちらは Legatus / SNI
// 由来のものが混じるので、 ブクマ/履歴判定としては page_visits を主軸にする)。

export interface PageVisitForDate extends PageVisitRow {
  is_bookmarked: 0 | 1;
  bookmark_id: number | null;
  bookmark_title: string | null;
}

/** 当日 last_seen_at の page_visits、 ブックマーク済みかどうかも返す */
export function pageVisitsForDate(db: Db, dateStr: string, { limit = 200 }: { limit?: number } = {}): PageVisitForDate[] {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 200));
  return db.prepare(`
    SELECT v.url, v.title, v.first_seen_at, v.last_seen_at, v.visit_count,
           CASE WHEN b.id IS NULL THEN 0 ELSE 1 END AS is_bookmarked,
           b.id AS bookmark_id, b.title AS bookmark_title
    FROM page_visits v
    LEFT JOIN bookmarks b ON b.url = v.url
    WHERE date(v.last_seen_at, 'localtime') = ?
    ORDER BY v.last_seen_at DESC
    LIMIT ?
  `).all(dateStr, safeLimit) as PageVisitForDate[];
}

export interface RevisitedBookmarkRow {
  id: number;
  url: string;
  title: string;
  summary: string | null;
  visit_count: number;
  last_seen_at: string;
  first_seen_at: string;
}

/** 当日に再訪が記録されたブックマーク (page_visits とブクマ url を JOIN) */
export function revisitedBookmarksForDate(db: Db, dateStr: string, { limit = 100 }: { limit?: number } = {}): RevisitedBookmarkRow[] {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare(`
    SELECT b.id, b.url, b.title, b.summary, v.visit_count, v.last_seen_at, v.first_seen_at
    FROM bookmarks b
    INNER JOIN page_visits v ON v.url = b.url
    WHERE date(v.last_seen_at, 'localtime') = ?
    ORDER BY v.visit_count DESC, v.last_seen_at DESC
    LIMIT ?
  `).all(dateStr, safeLimit) as RevisitedBookmarkRow[];
}

export interface BrowsingDomainStats {
  top_domains: { domain: string; pages: number; visits: number }[];
  total_pages: number;
  total_visits: number;
}

/** 当日のドメイン別 visit_count 合計 + ページ閲覧総数 */
export function browsingDomainStatsForDate(db: Db, dateStr: string, { limit = 30 }: { limit?: number } = {}): BrowsingDomainStats {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
  const rows = db.prepare(`
    SELECT LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                        CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                             THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                             ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                       )) AS domain,
           COUNT(*) AS pages,
           SUM(visit_count) AS visits
      FROM page_visits
     WHERE date(last_seen_at, 'localtime') = ?
       AND domain != ''
     GROUP BY domain
     ORDER BY visits DESC, pages DESC
     LIMIT ?
  `).all(dateStr, safeLimit) as { domain: string; pages: number; visits: number }[];
  const totals = db.prepare(`
    SELECT COUNT(*) AS pages, COALESCE(SUM(visit_count), 0) AS visits
      FROM page_visits
     WHERE date(last_seen_at, 'localtime') = ?
  `).get(dateStr) as { pages: number; visits: number };
  return {
    top_domains: rows,
    total_pages: totals.pages,
    total_visits: totals.visits,
  };
}

// ── share metadata --------------------------------------------------------
//
// Mark a local row as having been forwarded to a multi server. owner_user_id
// stays NULL on the local side (NULL = "this is mine") — the multi-side row
// is the one that carries the Cernere user id. shared_origin records the
// remote we forwarded to so re-shares can be detected later.
//
// Downloaded rows go the other way: they came from a multi server, so we set
// owner_user_id / owner_user_name to the remote owner so the UI can render
// "by <user>" without confusing them with rows the user authored locally.
export interface OwnerInput {
  ownerUserId: string | null;
  ownerUserName: string | null;
  sharedAt: string | null;
  sharedOrigin: string | null;
}

export function setBookmarkOwner(db: Db, id: number, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }: OwnerInput): void {
  db.prepare(`UPDATE bookmarks SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export function setDigOwner(db: Db, id: number, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }: OwnerInput): void {
  db.prepare(`UPDATE dig_sessions SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export function setDictionaryOwner(db: Db, id: number, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }: OwnerInput): void {
  db.prepare(`UPDATE dictionary_entries SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(ownerUserId, ownerUserName, sharedAt, sharedOrigin, id);
}

export interface SharedInput {
  sharedAt: string | null;
  sharedOrigin: string | null;
}

export function markBookmarkShared(db: Db, id: number, { sharedAt, sharedOrigin }: SharedInput): void {
  db.prepare(`UPDATE bookmarks SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}

export function markDigShared(db: Db, id: number, { sharedAt, sharedOrigin }: SharedInput): void {
  db.prepare(`UPDATE dig_sessions SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}

export function markDictionaryShared(db: Db, id: number, { sharedAt, sharedOrigin }: SharedInput): void {
  db.prepare(`UPDATE dictionary_entries SET shared_at = ?, shared_origin = ? WHERE id = ?`)
    .run(sharedAt, sharedOrigin, id);
}

// ── app settings (key/value) ----------------------------------------------

export function getAppSettings(db: Db): Record<string, string | null> {
  const rows = db.prepare(`SELECT key, value FROM app_settings`).all() as { key: string; value: string | null }[];
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Keys whose stored row should be DELETED when the user clears them
// (credentials / one-shot session info — empty string == cleared and we
// don't want stale rows lying around). Everything else preserves an
// empty string as an empty string so plain text fields like
// `diary.global_memo` don't get auto-wiped when the user happens to
// save the panel with the textarea empty for a moment.
const DELETE_ON_EMPTY_KEYS = new Set<string>([
  'multi_jwt', 'multi_user_id', 'multi_user_name', 'multi_role',
  'multi_connected_at', 'multi_url',
  'llm.openai.api_key',
  'github_token',
]);

export function setAppSettings(db: Db, patch: Record<string, unknown>): void {
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || (v === '' && DELETE_ON_EMPTY_KEYS.has(k))) {
        db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(k);
      } else {
        db.prepare(`
          INSERT INTO app_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(k, String(v));
      }
    }
  });
  tx();
}

// ── word clouds ------------------------------------------------------------

export interface InsertWordCloudInput {
  origin: string;
  originDigId?: number | null;
  parentCloudId?: number | null;
  parentWord?: string | null;
  label: string;
}

export function insertWordCloud(db: Db, { origin, originDigId, parentCloudId, parentWord, label }: InsertWordCloudInput): number {
  const info = db.prepare(`
    INSERT INTO word_clouds (origin, origin_dig_id, parent_cloud_id, parent_word, label)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    origin,
    originDigId ?? null,
    parentCloudId ?? null,
    parentWord ?? null,
    label,
  );
  return Number(info.lastInsertRowid);
}

export interface SetWordCloudResultInput {
  status: string;
  result?: unknown;
  error?: string | null;
}

export function setWordCloudResult(db: Db, id: number, { status, result, error }: SetWordCloudResultInput): void {
  db.prepare(`
    UPDATE word_clouds SET status = ?, result_json = ?, error = ?
    WHERE id = ?
  `).run(status, result ? JSON.stringify(result) : null, error ?? null, id);
}

export interface WordCloudParsed extends WordCloudRow {
  result: unknown;
}

export function getWordCloud(db: Db, id: number): WordCloudParsed | null {
  const row = db.prepare(`SELECT * FROM word_clouds WHERE id = ?`).get(id) as WordCloudRow | undefined;
  if (!row) return null;
  return {
    ...row,
    result: row.result_json ? safeParse(row.result_json) : null,
  };
}

export interface WordCloudListItem {
  id: number;
  origin: string;
  origin_dig_id: number | null;
  origin_bookmark_id: number | null;
  parent_cloud_id: number | null;
  parent_word: string | null;
  label: string;
  status: string;
  created_at: string;
}

export function listWordClouds(db: Db, limit = 30): WordCloudListItem[] {
  return db.prepare(`
    SELECT id, origin, origin_dig_id, origin_bookmark_id, parent_cloud_id, parent_word,
           label, status, created_at
    FROM word_clouds ORDER BY id DESC LIMIT ?
  `).all(limit) as WordCloudListItem[];
}

/** Latest 'done' word cloud for a single bookmark, or null. */
export function getBookmarkWordCloud(db: Db, bookmarkId: number): WordCloudParsed | null {
  const row = db.prepare(`
    SELECT * FROM word_clouds
    WHERE origin = 'bookmark' AND origin_bookmark_id = ? AND status = 'done'
    ORDER BY id DESC LIMIT 1
  `).get(bookmarkId) as WordCloudRow | undefined;
  if (!row) return null;
  return { ...row, result: row.result_json ? safeParse(row.result_json) : null };
}

export interface RecentBookmarkWordCloudItem {
  bookmark_id: number | null;
  label: string;
  result: unknown;
}

/** Most recent 'done' bookmark clouds (for recommendation weighting). */
export function recentBookmarkWordClouds(db: Db, { limit = 50 }: { limit?: number } = {}): RecentBookmarkWordCloudItem[] {
  const rows = db.prepare(`
    SELECT wc.* FROM word_clouds wc
    JOIN bookmarks b ON b.id = wc.origin_bookmark_id
    WHERE wc.origin = 'bookmark' AND wc.status = 'done'
    ORDER BY b.created_at DESC LIMIT ?
  `).all(Number(limit) || 50) as WordCloudRow[];
  return rows.map(r => ({
    bookmark_id: r.origin_bookmark_id,
    label: r.label,
    result: r.result_json ? safeParse(r.result_json) : null,
  }));
}

// ── dictionary -------------------------------------------------------------

export interface DictionaryEntryWithCount extends DictionaryEntryRow {
  link_count: number;
}

export function listDictionaryEntries(db: Db, { search }: { search?: string } = {}): DictionaryEntryWithCount[] {
  const args: unknown[] = [];
  let where = '';
  if (search) {
    where = `WHERE e.term LIKE ? OR e.definition LIKE ? OR e.notes LIKE ?`;
    const pat = `%${search}%`;
    args.push(pat, pat, pat);
  }
  const rows = db.prepare(`
    SELECT e.*, COALESCE(l.link_count, 0) AS link_count
    FROM dictionary_entries e
    LEFT JOIN (
      SELECT entry_id, COUNT(*) AS link_count
      FROM dictionary_links GROUP BY entry_id
    ) l ON l.entry_id = e.id
    ${where}
    ORDER BY e.updated_at DESC
  `).all(...args) as DictionaryEntryWithCount[];
  return rows;
}

export interface DictionaryEntryWithLinks extends DictionaryEntryRow {
  links: Pick<DictionaryLinkRow, 'source_kind' | 'source_id' | 'added_at'>[];
}

export function getDictionaryEntry(db: Db, id: number): DictionaryEntryWithLinks | null {
  const row = db.prepare(`SELECT * FROM dictionary_entries WHERE id = ?`).get(id) as DictionaryEntryRow | undefined;
  if (!row) return null;
  const links = db.prepare(`
    SELECT source_kind, source_id, added_at
    FROM dictionary_links WHERE entry_id = ?
    ORDER BY added_at DESC
  `).all(id) as Pick<DictionaryLinkRow, 'source_kind' | 'source_id' | 'added_at'>[];
  return { ...row, links };
}

export function findDictionaryEntryByTerm(db: Db, term: string): DictionaryEntryRow | null {
  return (db.prepare(`SELECT * FROM dictionary_entries WHERE term = ?`).get(term) as DictionaryEntryRow | undefined) ?? null;
}

export interface InsertDictionaryEntryInput {
  term: string;
  definition?: string | null;
  notes?: string | null;
}

export function insertDictionaryEntry(db: Db, { term, definition, notes }: InsertDictionaryEntryInput): number {
  const info = db.prepare(`
    INSERT INTO dictionary_entries (term, definition, notes)
    VALUES (?, ?, ?)
  `).run(String(term).trim(), definition ?? null, notes ?? null);
  return Number(info.lastInsertRowid);
}

export interface UpdateDictionaryEntryPatch {
  term?: string;
  definition?: string | null;
  notes?: string | null;
}

export function updateDictionaryEntry(db: Db, id: number, patch: UpdateDictionaryEntryPatch): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.term === 'string') { fields.push('term = ?'); args.push(patch.term.trim()); }
  if (typeof patch.definition === 'string' || patch.definition === null) {
    fields.push('definition = ?'); args.push(patch.definition);
  }
  if (typeof patch.notes === 'string' || patch.notes === null) {
    fields.push('notes = ?'); args.push(patch.notes);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE dictionary_entries SET ${fields.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteDictionaryEntry(db: Db, id: number): void {
  db.prepare(`DELETE FROM dictionary_entries WHERE id = ?`).run(id);
}

export interface DictionaryLinkInput {
  entryId: number;
  sourceKind: string;
  sourceId: number;
}

export function addDictionaryLink(db: Db, { entryId, sourceKind, sourceId }: DictionaryLinkInput): void {
  db.prepare(`
    INSERT OR IGNORE INTO dictionary_links (entry_id, source_kind, source_id)
    VALUES (?, ?, ?)
  `).run(entryId, sourceKind, sourceId);
}

export function removeDictionaryLink(db: Db, { entryId, sourceKind, sourceId }: DictionaryLinkInput): void {
  db.prepare(`
    DELETE FROM dictionary_links
    WHERE entry_id = ? AND source_kind = ? AND source_id = ?
  `).run(entryId, sourceKind, sourceId);
}

// ── page metadata (per-URL) -----------------------------------------------

export function getPageMetadata(db: Db, url: string): PageMetadataRow | null {
  return (db.prepare(`SELECT * FROM page_metadata WHERE url = ?`).get(url) as PageMetadataRow | undefined) ?? null;
}

export function getPageMetadataMap(db: Db, urls: string[]): Map<string, PageMetadataRow> {
  if (!urls.length) return new Map();
  const placeholders = urls.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM page_metadata WHERE url IN (${placeholders})`).all(...urls) as PageMetadataRow[];
  return new Map(rows.map(r => [r.url, r]));
}

export function insertPageMetadataPending(db: Db, url: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO page_metadata (url, status) VALUES (?, 'pending')
  `).run(url);
}

export interface PageMetadataPatch {
  title?: string | null;
  meta_description?: string | null;
  og_title?: string | null;
  og_description?: string | null;
  og_image?: string | null;
  og_type?: string | null;
  content_type?: string | null;
  http_status?: number | null;
  summary?: string | null;
  kind?: string | null;
  status?: string | null;
  error?: string | null;
}

export function setPageMetadata(db: Db, url: string, patch: PageMetadataPatch): void {
  db.prepare(`
    UPDATE page_metadata
       SET title = COALESCE(?, title),
           meta_description = COALESCE(?, meta_description),
           og_title = COALESCE(?, og_title),
           og_description = COALESCE(?, og_description),
           og_image = COALESCE(?, og_image),
           og_type = COALESCE(?, og_type),
           content_type = COALESCE(?, content_type),
           http_status = COALESCE(?, http_status),
           summary = COALESCE(?, summary),
           kind = COALESCE(?, kind),
           status = COALESCE(?, status),
           error = ?,
           fetched_at = datetime('now')
     WHERE url = ?
  `).run(
    patch.title ?? null,
    patch.meta_description ?? null,
    patch.og_title ?? null,
    patch.og_description ?? null,
    patch.og_image ?? null,
    patch.og_type ?? null,
    patch.content_type ?? null,
    patch.http_status ?? null,
    patch.summary ?? null,
    patch.kind ?? null,
    patch.status ?? null,
    patch.error ?? null,
    url,
  );
}

export function deletePageMetadata(db: Db, url: string): void {
  db.prepare(`DELETE FROM page_metadata WHERE url = ?`).run(url);
}

// ── domain catalog ---------------------------------------------------------

export function getDomainCatalog(db: Db, domain: string): DomainCatalogRow | null {
  return (db.prepare(`SELECT * FROM domain_catalog WHERE domain = ?`).get(domain) as DomainCatalogRow | undefined) ?? null;
}

export function listDomainCatalog(db: Db, { limit = 200 }: { limit?: number } = {}): DomainCatalogRow[] {
  return db.prepare(`
    SELECT * FROM domain_catalog
    ORDER BY (status = 'done') DESC, fetched_at DESC
    LIMIT ?
  `).all(limit) as DomainCatalogRow[];
}

/** Bulk fetch by domain set; returns { domain → row }. */
export function getDomainCatalogMap(db: Db, domains: string[]): Map<string, DomainCatalogRow> {
  if (!domains.length) return new Map();
  const placeholders = domains.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM domain_catalog WHERE domain IN (${placeholders})`).all(...domains) as DomainCatalogRow[];
  return new Map(rows.map(r => [r.domain, r]));
}

export function insertDomainPending(db: Db, domain: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO domain_catalog (domain, status) VALUES (?, 'pending')
  `).run(domain);
}

export interface DomainCatalogPatch {
  title?: string | null;
  site_name?: string | null;
  description?: string | null;
  can_do?: string | null;
  kind?: string | null;
  status?: string | null;
  error?: string | null;
}

export function setDomainCatalog(db: Db, domain: string, patch: DomainCatalogPatch): void {
  // Don't clobber user-edited columns. Caller should pass only the fields
  // it produced; we COALESCE so untouched columns keep their value.
  db.prepare(`
    UPDATE domain_catalog
       SET title = COALESCE(?, title),
           site_name = CASE WHEN user_edited = 1 THEN site_name ELSE COALESCE(?, site_name) END,
           description = CASE WHEN user_edited = 1 THEN description ELSE COALESCE(?, description) END,
           can_do = CASE WHEN user_edited = 1 THEN can_do ELSE COALESCE(?, can_do) END,
           kind = CASE WHEN user_edited = 1 THEN kind ELSE COALESCE(?, kind) END,
           status = COALESCE(?, status),
           error = ?,
           fetched_at = datetime('now')
     WHERE domain = ?
  `).run(
    patch.title ?? null,
    patch.site_name ?? null,
    patch.description ?? null,
    patch.can_do ?? null,
    patch.kind ?? null,
    patch.status ?? null,
    patch.error ?? null,
    domain,
  );
}

export interface DomainCatalogUserPatch {
  site_name?: string | null;
  description?: string | null;
  can_do?: string | null;
  kind?: string | null;
  notes?: string | null;
  domain_private?: boolean | 0 | 1;
}

export function updateDomainCatalogUser(db: Db, domain: string, patch: DomainCatalogUserPatch): void {
  // User edit. Mark user_edited=1 so the auto-classifier won't overwrite.
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const k of ['site_name', 'description', 'can_do', 'kind', 'notes'] as const) {
    const v = patch[k];
    if (typeof v === 'string' || v === null) {
      fields.push(`${k} = ?`);
      args.push(v ?? null);
    }
  }
  if (typeof patch.domain_private === 'boolean' || patch.domain_private === 0 || patch.domain_private === 1) {
    fields.push(`domain_private = ?`);
    args.push(patch.domain_private ? 1 : 0);
  }
  if (fields.length === 0) return;
  fields.push(`user_edited = 1`);
  args.push(domain);
  db.prepare(`UPDATE domain_catalog SET ${fields.join(', ')} WHERE domain = ?`).run(...args);
}

export interface DomainCatalogWithCounts extends DomainCatalogRow {
  visits_today: number;
  visits_week: number;
  visits_total: number;
}

export function listDomainCatalogWithCounts(db: Db, { limit = 500, search }: { limit?: number; search?: string } = {}): DomainCatalogWithCounts[] {
  const args: unknown[] = [];
  let where = '';
  if (search) {
    where = `WHERE c.domain LIKE ? OR c.site_name LIKE ? OR c.description LIKE ? OR c.can_do LIKE ?`;
    const pat = `%${search}%`;
    args.push(pat, pat, pat, pat);
  }
  const rows = db.prepare(`
    SELECT c.*,
           COALESCE(d.daily_visits, 0)    AS visits_today,
           COALESCE(w.weekly_visits, 0)   AS visits_week,
           COALESCE(t.total_visits, 0)    AS visits_total
      FROM domain_catalog c
      LEFT JOIN (
        SELECT instr(SUBSTR(url, INSTR(url, '://') + 3), '/') AS slash,
               LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS daily_visits
          FROM page_visits
         WHERE date(last_seen_at, 'localtime') = date('now', 'localtime')
         GROUP BY dom
      ) d ON d.dom = c.domain
      LEFT JOIN (
        SELECT LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS weekly_visits
          FROM page_visits
         WHERE last_seen_at >= datetime('now', '-7 days')
         GROUP BY dom
      ) w ON w.dom = c.domain
      LEFT JOIN (
        SELECT LOWER(SUBSTR(SUBSTR(url, INSTR(url, '://') + 3), 1,
                            CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                                 THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
                                 ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3)) END
                           )) AS dom,
               SUM(visit_count) AS total_visits
          FROM page_visits
         GROUP BY dom
      ) t ON t.dom = c.domain
     ${where}
     ORDER BY visits_today DESC, visits_week DESC, c.domain ASC
     LIMIT ?
  `).all(...args, Number(limit) || 500) as DomainCatalogWithCounts[];
  return rows;
}

export function deleteDomainCatalog(db: Db, domain: string): void {
  db.prepare(`DELETE FROM domain_catalog WHERE domain = ?`).run(domain);
}

// ── applications (exe classification) ------------------------------------

export function getApplication(db: Db, processName: string): ApplicationRow | null {
  return (db.prepare(`SELECT * FROM applications WHERE process_name = ?`).get(processName) as ApplicationRow | undefined) ?? null;
}

export function listApplications(db: Db, { limit = 500 }: { limit?: number } = {}): ApplicationRow[] {
  return db.prepare(`
    SELECT * FROM applications
    ORDER BY (status = 'done') DESC, classified_at DESC, process_name ASC
    LIMIT ?
  `).all(limit) as ApplicationRow[];
}

export function listApplicationsByKind(db: Db, kind: string): ApplicationRow[] {
  return db.prepare(`
    SELECT * FROM applications WHERE kind = ? AND status = 'done'
  `).all(kind) as ApplicationRow[];
}

/** bulk fetch — process_name 集合 → row map */
export function getApplicationsMap(db: Db, processNames: string[]): Map<string, ApplicationRow> {
  if (!processNames.length) return new Map();
  const placeholders = processNames.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM applications WHERE process_name IN (${placeholders})`).all(...processNames) as ApplicationRow[];
  return new Map(rows.map(r => [r.process_name, r]));
}

export function insertApplicationPending(db: Db, processName: string): void {
  db.prepare(`INSERT OR IGNORE INTO applications (process_name, status) VALUES (?, 'pending')`).run(processName);
}

export interface ApplicationPatch {
  name?: string | null;
  kind?: string | null;
  description?: string | null;
  icon_url?: string | null;
  status?: string | null;
  error?: string | null;
}

export function setApplication(db: Db, processName: string, patch: ApplicationPatch): void {
  // user_edited=1 のとき AI 分類は値を上書きしない (domain_catalog と同じ)。
  db.prepare(`
    UPDATE applications
       SET name = CASE WHEN user_edited = 1 THEN name ELSE COALESCE(?, name) END,
           kind = CASE WHEN user_edited = 1 THEN kind ELSE COALESCE(?, kind) END,
           description = CASE WHEN user_edited = 1 THEN description ELSE COALESCE(?, description) END,
           icon_url = COALESCE(?, icon_url),
           status = COALESCE(?, status),
           error = ?,
           classified_at = datetime('now')
     WHERE process_name = ?
  `).run(
    patch.name ?? null,
    patch.kind ?? null,
    patch.description ?? null,
    patch.icon_url ?? null,
    patch.status ?? null,
    patch.error ?? null,
    processName,
  );
}

export interface ApplicationUserPatch {
  name?: string | null;
  kind?: string | null;
  description?: string | null;
}

export function updateApplicationUser(db: Db, processName: string, patch: ApplicationUserPatch): void {
  db.prepare(`
    UPDATE applications
       SET name = COALESCE(?, name),
           kind = COALESCE(?, kind),
           description = COALESCE(?, description),
           user_edited = 1,
           status = 'done',
           classified_at = datetime('now')
     WHERE process_name = ?
  `).run(patch.name ?? null, patch.kind ?? null, patch.description ?? null, processName);
}

export function deleteApplication(db: Db, processName: string): void {
  db.prepare(`DELETE FROM applications WHERE process_name = ?`).run(processName);
}

// ── steam_apps_cache (Store API resolved appid → name) -------------------

export interface SteamAppCacheRow {
  appid: number;
  name: string | null;
  header_image: string | null;
  type: string | null;
  short_desc: string | null;
  fetched_at: string;
  not_found: number;
}

export function getSteamAppCache(db: Db, appid: number): SteamAppCacheRow | null {
  return (db.prepare(`SELECT * FROM steam_apps_cache WHERE appid = ?`).get(appid) as SteamAppCacheRow | undefined) ?? null;
}

export function getSteamAppsCacheMap(db: Db, appids: number[]): Map<number, SteamAppCacheRow> {
  if (!appids.length) return new Map();
  const placeholders = appids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM steam_apps_cache WHERE appid IN (${placeholders})`).all(...appids) as SteamAppCacheRow[];
  return new Map(rows.map(r => [r.appid, r]));
}

export interface SteamAppCachePatch {
  name?: string | null;
  header_image?: string | null;
  type?: string | null;
  short_desc?: string | null;
  not_found?: boolean;
}

export function upsertSteamAppCache(db: Db, appid: number, patch: SteamAppCachePatch): void {
  db.prepare(`
    INSERT INTO steam_apps_cache (appid, name, header_image, type, short_desc, fetched_at, not_found)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(appid) DO UPDATE SET
      name = excluded.name,
      header_image = excluded.header_image,
      type = excluded.type,
      short_desc = excluded.short_desc,
      fetched_at = excluded.fetched_at,
      not_found = excluded.not_found
  `).run(
    appid,
    patch.name ?? null,
    patch.header_image ?? null,
    patch.type ?? null,
    patch.short_desc ?? null,
    patch.not_found ? 1 : 0,
  );
}

/** キャッシュ未解決の appid を steam_activity から拾う。
 *  - キャッシュ row 自体が無い appid
 *  - 過去 not_found=1 で記録されたが name が後で復活する可能性があるので、 7 日経った
 *    not_found のみ再試行 (= 完全に永続化、 ただし delisted 復帰は拾う)
 *  解決済 (name あり) はもう再取得しない (= ゲーム名は永続化)。 */
export function listStaleAppidsFromActivity(db: Db, limit = 100): number[] {
  const rows = db.prepare(`
    SELECT DISTINCT sa.appid
    FROM steam_activity sa
    LEFT JOIN steam_apps_cache c ON c.appid = sa.appid
    WHERE
      c.appid IS NULL
      OR (c.not_found = 1 AND julianday('now') - julianday(c.fetched_at) > 7)
    ORDER BY sa.id DESC
    LIMIT ?
  `).all(limit) as Array<{ appid: number }>;
  return rows.map(r => r.appid);
}

// ── server events (uptime / downtime / lifecycle) -------------------------

export interface InsertServerEventInput {
  type: string;
  occurredAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  details?: unknown;
}

export function insertServerEvent(db: Db, { type, occurredAt, endedAt, durationMs, details }: InsertServerEventInput): number {
  const info = db.prepare(`
    INSERT INTO server_events (type, occurred_at, ended_at, duration_ms, details_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    type,
    occurredAt,
    endedAt ?? null,
    durationMs ?? null,
    details ? JSON.stringify(details) : null,
  );
  return Number(info.lastInsertRowid);
}

export interface ServerEventParsed extends ServerEventRow {
  details: unknown;
}

export function listServerEvents(db: Db, { limit = 200 }: { limit?: number } = {}): ServerEventParsed[] {
  const rows = db.prepare(`
    SELECT * FROM server_events
    ORDER BY id DESC LIMIT ?
  `).all(Number(limit) || 200) as ServerEventRow[];
  return rows.map(r => ({
    ...r,
    details: r.details_json ? safeParse(r.details_json) : null,
  }));
}

export function listServerEventsForDate(db: Db, dateStr: string): ServerEventParsed[] {
  // Any event that overlaps the local date window.
  const rows = db.prepare(`
    SELECT * FROM server_events
    WHERE date(occurred_at, 'localtime') = ?
       OR date(COALESCE(ended_at, occurred_at), 'localtime') = ?
    ORDER BY occurred_at ASC
  `).all(dateStr, dateStr) as ServerEventRow[];
  return rows.map(r => ({
    ...r, details: r.details_json ? safeParse(r.details_json) : null,
  }));
}

// ── activity events (git commit / claude code prompt 等) ─────────────────

const ACTIVITY_KINDS = new Set<ActivityKind>([
  'git_commit',
  'claude_code_prompt',
  'gemini_prompt',
  'codex_prompt',
  'task_created',
  'task_done',
  'task_updated',
  'goal_created',
  'goal_done',
  'goal_updated',
  'discord_message',
  'discord_presence',
  'discord_voice',
  'discord_reaction',
]);

export interface RecordActivityEventInput {
  kind: ActivityKind;
  occurred_at?: string;
  source?: string | null;
  ref_id?: string | null;
  content?: string | null;
  metadata?: unknown;
}

/**
 * 活動イベントを 1 件記録する。
 * kind+ref_id の重複は INSERT OR IGNORE で吸収 (同じ commit sha / prompt id が
 * 二度送られても重複しない)。 戻り値は inserted=true|false + id。
 */
export function recordActivityEvent(
  db: Db,
  { kind, occurred_at, source, ref_id, content, metadata }: RecordActivityEventInput,
): { inserted: boolean; id: number } {
  if (!ACTIVITY_KINDS.has(kind)) {
    throw new Error(`unknown activity kind: ${kind}`);
  }
  const ts = occurred_at || new Date().toISOString();
  const info = db.prepare(`
    INSERT OR IGNORE INTO activity_events
      (kind, occurred_at, source, ref_id, content, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    kind,
    ts,
    source ?? null,
    ref_id ?? null,
    content ?? null,
    metadata ? JSON.stringify(metadata) : null,
  );
  return { inserted: info.changes > 0, id: Number(info.lastInsertRowid) };
}

// ── attendance events (Aedilis 出席チェックイン、 CONTRACTS.md §5) ─────────

export interface RecordAttendanceEventInput {
  userId: string;
  facilityId: string;
  checkedInAt: number;             // epoch ms
  reservationId?: string | null;   // walk-in は null
  source?: string | null;          // 既定 'aedilis'
}

/**
 * 出席チェックインを 1 件記録する。 webhook の再送に備え、
 * (user_id, facility_id, checked_in_at) の UNIQUE で冪等化する
 * (重複は INSERT OR IGNORE で deduped=true)。
 */
export function recordAttendanceEvent(
  db: Db,
  { userId, facilityId, checkedInAt, reservationId, source }: RecordAttendanceEventInput,
): { inserted: boolean; id: number } {
  const info = db.prepare(`
    INSERT OR IGNORE INTO attendance_events
      (user_id, facility_id, checked_in_at, reservation_id, source, event_type)
    VALUES (?, ?, ?, ?, ?, 'attendance.checked_in')
  `).run(
    userId,
    facilityId,
    checkedInAt,
    reservationId ?? null,
    source ?? 'aedilis',
  );
  return { inserted: info.changes > 0, id: Number(info.lastInsertRowid) };
}

/** 出席イベントを新しい順に返す (UI / デバッグ用)。 facility で絞り込み可。 */
export function listAttendanceEvents(
  db: Db,
  { limit = 50, facilityId = null }: { limit?: number; facilityId?: string | null } = {},
): AttendanceEventRow[] {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const where = facilityId ? 'WHERE facility_id = ?' : '';
  const args: unknown[] = facilityId ? [facilityId, safeLimit] : [safeLimit];
  return db.prepare(`
    SELECT id, user_id, facility_id, checked_in_at, reservation_id, source, event_type, ingested_at
    FROM attendance_events
    ${where}
    ORDER BY checked_in_at DESC
    LIMIT ?
  `).all(...args) as AttendanceEventRow[];
}

export interface ActivityEventParsed extends Omit<ActivityEventRow, 'ingested_at'> {
  ingested_at?: string;
  metadata: unknown;
}

/**
 * 当日 (local) の活動イベントを時刻昇順で全件返す。
 * 内部集計 (hourly bucket / kind 別件数) で全部欲しい時用。
 * UI のリスト表示には activityEventsPage を使うこと。
 */
/** 当日 (local) のフォアグラウンドアプリ使用時間を process_name 単位で集計する。
 *  applications カタログ (AI 分類済) に LEFT JOIN して name / kind / icon_url を返す。
 *  total_sec = 全 sample 区間の合計、 active_sec = input_active=1 のみの合計。
 *  上位 50 件 (total_sec 降順) で打ち切る。 */
export interface AppUsageRow {
  process_name: string;
  name: string | null;
  kind: string | null;
  icon_url: string | null;
  total_sec: number;
  active_sec: number;
  samples: number;
}
export function appUsageForDate(db: Db, dateStr: string, limit = 50): AppUsageRow[] {
  return db.prepare(`
    SELECT
      s.process_name,
      app.name        AS name,
      app.kind        AS kind,
      app.icon_url    AS icon_url,
      CAST(COALESCE(SUM(s.sample_interval_sec), 0) AS INTEGER) AS total_sec,
      CAST(COALESCE(SUM(CASE WHEN s.input_active = 1 THEN s.sample_interval_sec ELSE 0 END), 0) AS INTEGER) AS active_sec,
      COUNT(*) AS samples
    FROM app_samples s
    LEFT JOIN applications app ON app.process_name = s.process_name
    WHERE date(s.sampled_at, 'localtime') = ?
    GROUP BY s.process_name, app.name, app.kind, app.icon_url
    ORDER BY total_sec DESC
    LIMIT ?
  `).all(dateStr, limit) as AppUsageRow[];
}

/** 当日 (local) の Steam ゲームプレイ時間を appid 別に集計する。
 *  playtime_forever_min の MAX - MIN を「その日にプレイした分」 とみなす
 *  (= Steam が回した間の delta が露出されるカラム)。 Steam がその日まったく
 *  起動しなかった appid は 0 件で含まれない。 1 分以上プレイした行のみ。 */
export interface GameUsageRow {
  appid: number;
  name: string | null;
  minutes_played: number;
  first_at: string;
  last_at: string;
}
export function gameUsageForDate(db: Db, dateStr: string, limit = 20): GameUsageRow[] {
  return db.prepare(`
    SELECT
      appid,
      MAX(name) AS name,
      CAST(MAX(playtime_forever_min) - MIN(playtime_forever_min) AS INTEGER) AS minutes_played,
      MIN(sampled_at) AS first_at,
      MAX(sampled_at) AS last_at
    FROM steam_activity
    WHERE date(sampled_at, 'localtime') = ?
    GROUP BY appid
    HAVING MAX(playtime_forever_min) - MIN(playtime_forever_min) > 0
    ORDER BY minutes_played DESC
    LIMIT ?
  `).all(dateStr, limit) as GameUsageRow[];
}

// ─── review_targets ──────────────────────────────────────────────────────────
export interface ReviewTargetRow {
  id: number;
  name: string;
  local_path: string;
  format_key: string;
  enabled: number;          // 1 or 0
  created_at: string;
}

export function listReviewTargets(db: Db, { enabledOnly = false }: { enabledOnly?: boolean } = {}): ReviewTargetRow[] {
  const where = enabledOnly ? 'WHERE enabled = 1' : '';
  return db.prepare(`
    SELECT id, name, local_path, format_key, enabled, created_at
    FROM review_targets
    ${where}
    ORDER BY name ASC
  `).all() as ReviewTargetRow[];
}

export function getReviewTargetByName(db: Db, name: string): ReviewTargetRow | undefined {
  return db.prepare(
    `SELECT id, name, local_path, format_key, enabled, created_at
     FROM review_targets WHERE name = ?`,
  ).get(name) as ReviewTargetRow | undefined;
}

export function insertReviewTarget(
  db: Db,
  { name, local_path, format_key = 'aiformat' }: { name: string; local_path: string; format_key?: string },
): number {
  const r = db.prepare(
    `INSERT INTO review_targets (name, local_path, format_key) VALUES (?, ?, ?)`,
  ).run(name, local_path, format_key);
  return Number(r.lastInsertRowid);
}

/** 既存があれば何もしない (= INSERT OR IGNORE)。 戻り値: 新規に挿入したら true */
export function insertReviewTargetIfMissing(
  db: Db,
  { name, local_path, format_key = 'aiformat' }: { name: string; local_path: string; format_key?: string },
): boolean {
  const r = db.prepare(
    `INSERT OR IGNORE INTO review_targets (name, local_path, format_key) VALUES (?, ?, ?)`,
  ).run(name, local_path, format_key);
  return r.changes > 0;
}

export function updateReviewTarget(
  db: Db,
  id: number,
  patch: { name?: string; local_path?: string; format_key?: string; enabled?: 0 | 1 },
): void {
  const set: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.name === 'string') { set.push('name = ?'); args.push(patch.name); }
  if (typeof patch.local_path === 'string') { set.push('local_path = ?'); args.push(patch.local_path); }
  if (typeof patch.format_key === 'string') { set.push('format_key = ?'); args.push(patch.format_key); }
  if (patch.enabled === 0 || patch.enabled === 1) { set.push('enabled = ?'); args.push(patch.enabled); }
  if (set.length === 0) return;
  args.push(id);
  db.prepare(`UPDATE review_targets SET ${set.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteReviewTarget(db: Db, id: number): boolean {
  const r = db.prepare(`DELETE FROM review_targets WHERE id = ?`).run(id);
  return r.changes > 0;
}

// ─── repo_watch (ソース管理リポジトリのウォッチ一覧) ──────────────────────────
export interface RepoWatchRow {
  id: number;
  provider: string;
  owner: string;
  name: string;
  html_url: string;
  default_branch: string | null;
  open_pr_count: number | null;
  open_issue_count: number | null;
  last_commit_sha: string | null;
  last_commit_message: string | null;
  last_commit_url: string | null;
  last_commit_at: string | null;
  ci_status: string | null;
  ci_conclusion: string | null;
  ci_url: string | null;
  ci_workflow_name: string | null;
  ci_run_at: string | null;
  fetched_at: string | null;
  fetch_error: string | null;
  sort_order: number;
  created_at: string;
}

const REPO_WATCH_COLS = `
  id, provider, owner, name, html_url, default_branch,
  open_pr_count, open_issue_count,
  last_commit_sha, last_commit_message, last_commit_url, last_commit_at,
  ci_status, ci_conclusion, ci_url, ci_workflow_name, ci_run_at,
  fetched_at, fetch_error, sort_order, created_at
`;

export function listRepoWatch(db: Db): RepoWatchRow[] {
  return db.prepare(
    `SELECT ${REPO_WATCH_COLS} FROM repo_watch ORDER BY sort_order ASC, id ASC`,
  ).all() as RepoWatchRow[];
}

export function getRepoWatch(db: Db, id: number): RepoWatchRow | undefined {
  return db.prepare(
    `SELECT ${REPO_WATCH_COLS} FROM repo_watch WHERE id = ?`,
  ).get(id) as RepoWatchRow | undefined;
}

/** 新規登録。 (provider, owner, name) が重複する場合は UNIQUE 制約で throw。 */
export function insertRepoWatch(
  db: Db,
  { provider = 'github', owner, name, html_url, default_branch = null }:
    { provider?: string; owner: string; name: string; html_url: string; default_branch?: string | null },
): number {
  const max = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM repo_watch`).get() as { m: number };
  const r = db.prepare(
    `INSERT INTO repo_watch (provider, owner, name, html_url, default_branch, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(provider, owner, name, html_url, default_branch, max.m + 1);
  return Number(r.lastInsertRowid);
}

export function deleteRepoWatch(db: Db, id: number): boolean {
  const r = db.prepare(`DELETE FROM repo_watch WHERE id = ?`).run(id);
  return r.changes > 0;
}

/** 直近フェッチのキャッシュ列を更新する。 fetch 成否どちらでも呼ぶ。 */
export function updateRepoWatchStats(
  db: Db,
  id: number,
  stats: {
    default_branch?: string | null;
    open_pr_count?: number | null;
    open_issue_count?: number | null;
    last_commit_sha?: string | null;
    last_commit_message?: string | null;
    last_commit_url?: string | null;
    last_commit_at?: string | null;
    ci_status?: string | null;
    ci_conclusion?: string | null;
    ci_url?: string | null;
    ci_workflow_name?: string | null;
    ci_run_at?: string | null;
    fetch_error?: string | null;
  },
): void {
  db.prepare(
    `UPDATE repo_watch SET
       default_branch      = ?,
       open_pr_count       = ?,
       open_issue_count    = ?,
       last_commit_sha     = ?,
       last_commit_message = ?,
       last_commit_url     = ?,
       last_commit_at      = ?,
       ci_status           = ?,
       ci_conclusion       = ?,
       ci_url              = ?,
       ci_workflow_name    = ?,
       ci_run_at           = ?,
       fetched_at          = datetime('now'),
       fetch_error         = ?
     WHERE id = ?`,
  ).run(
    stats.default_branch ?? null,
    stats.open_pr_count ?? null,
    stats.open_issue_count ?? null,
    stats.last_commit_sha ?? null,
    stats.last_commit_message ?? null,
    stats.last_commit_url ?? null,
    stats.last_commit_at ?? null,
    stats.ci_status ?? null,
    stats.ci_conclusion ?? null,
    stats.ci_url ?? null,
    stats.ci_workflow_name ?? null,
    stats.ci_run_at ?? null,
    stats.fetch_error ?? null,
    id,
  );
}

// ─── repo_watch_items (各リポの open PR / Issue キャッシュ) ────────────────
export interface RepoWatchItemRow {
  id: number;
  repo_id: number;
  kind: string;       // 'pr' | 'issue'
  number: number;
  title: string;
  html_url: string;
  state: string | null;
  author: string | null;
  updated_at: string | null;
  fetched_at: string;
}

export function listRepoWatchItems(db: Db, repoId: number, limit = 50): RepoWatchItemRow[] {
  return db.prepare(
    `SELECT id, repo_id, kind, number, title, html_url, state, author, updated_at, fetched_at
     FROM repo_watch_items
     WHERE repo_id = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  ).all(repoId, limit) as RepoWatchItemRow[];
}

/** ある repo の items を丸ごと差し替える (取得結果を毎回上書きする想定)。 */
export function replaceRepoWatchItems(
  db: Db,
  repoId: number,
  items: ReadonlyArray<{
    kind: string;
    number: number;
    title: string;
    html_url: string;
    state?: string | null;
    author?: string | null;
    updated_at?: string | null;
  }>,
): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM repo_watch_items WHERE repo_id = ?`).run(repoId);
    if (items.length === 0) return;
    const ins = db.prepare(
      `INSERT INTO repo_watch_items (repo_id, kind, number, title, html_url, state, author, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const it of items) {
      ins.run(repoId, it.kind, it.number, it.title, it.html_url,
        it.state ?? null, it.author ?? null, it.updated_at ?? null);
    }
  });
  tx();
}

export function activityEventsForDate(db: Db, dateStr: string): ActivityEventParsed[] {
  const rows = db.prepare(`
    SELECT id, kind, occurred_at, source, ref_id, content, metadata_json
    FROM activity_events
    WHERE date(occurred_at, 'localtime') = ?
    ORDER BY occurred_at ASC
  `).all(dateStr) as Omit<ActivityEventRow, 'ingested_at'>[];
  return rows.map((r) => ({
    ...r,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : null,
  }));
}

export interface ActivityEventsPage {
  items: ActivityEventParsed[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * 当日 (local) の活動イベントを **時刻降順で** ページング取得する。
 * UI のリスト表示 + 「more ▽」 用。 limit は 1-1000、 offset は >= 0。
 * 戻り値: { items, total, limit, offset }
 *   items   — 取得した行 (DESC、 最新が先頭)
 *   total   — 当日の全件数 (offset/limit 無関係)
 */
export function activityEventsPage(
  db: Db,
  dateStr: string,
  { limit = 100, offset = 0, kind = null }: { limit?: number; offset?: number; kind?: ActivityKind | null } = {},
): ActivityEventsPage {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const kindClause = kind && ACTIVITY_KINDS.has(kind) ? 'AND kind = ?' : '';
  const kindArgs: unknown[] = kindClause ? [kind] : [];
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS n FROM activity_events
    WHERE date(occurred_at, 'localtime') = ? ${kindClause}
  `).get(dateStr, ...kindArgs) as { n: number };
  const rows = db.prepare(`
    SELECT id, kind, occurred_at, source, ref_id, content, metadata_json
    FROM activity_events
    WHERE date(occurred_at, 'localtime') = ? ${kindClause}
    ORDER BY occurred_at DESC
    LIMIT ? OFFSET ?
  `).all(dateStr, ...kindArgs, safeLimit, safeOffset) as Omit<ActivityEventRow, 'ingested_at'>[];
  const items = rows.map((r) => ({
    ...r,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : null,
  }));
  return { items, total: totalRow.n, limit: safeLimit, offset: safeOffset };
}

/** 直近 limit 件 (新しい順)。 全期間 / 任意 kind フィルタつき。 */
export function listActivityEvents(
  db: Db,
  { limit = 200, kind = null }: { limit?: number; kind?: ActivityKind | null } = {},
): ActivityEventParsed[] {
  const args: unknown[] = [];
  let where = '';
  if (kind && ACTIVITY_KINDS.has(kind)) {
    where = 'WHERE kind = ?';
    args.push(kind);
  }
  args.push(Number(limit) || 200);
  const rows = db.prepare(`
    SELECT id, kind, occurred_at, source, ref_id, content, metadata_json, ingested_at
    FROM activity_events
    ${where}
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(...args) as ActivityEventRow[];
  return rows.map((r) => ({
    ...r,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : null,
  }));
}

// ── visit events / diary ---------------------------------------------------

export interface InsertVisitEventInput {
  url: string;
  title?: string | null;
}

export function insertVisitEvent(db: Db, { url, title }: InsertVisitEventInput): void {
  const domain = extractDomain(url);
  db.prepare(`
    INSERT INTO visit_events (url, domain, title, source) VALUES (?, ?, ?, 'browser')
  `).run(url, domain, title ?? null);
}

export interface InsertExternalVisitEventInput {
  domain: string;
  visitedAt?: string | null;
  source: 'dns' | 'sni';
  deviceLabel?: string | null;
  deviceOs?: string | null;
}

/**
 * Insert a visit event sourced from outside the browser (e.g. Legatus DNS
 * tap on the user's home PC). `domain` は LFQDN (already lower-cased) を
 * 受ける前提。 url は擬似形式 (`dns://<domain>` or `sni://<domain>`) で
 * 保存し、 既存の page_visits / bookmark テーブルとは衝突させない。
 */
export function insertExternalVisitEvent(db: Db, {
  domain,
  visitedAt,
  source,
  deviceLabel,
  deviceOs,
}: InsertExternalVisitEventInput): void {
  const url = `${source}://${domain}`;
  db.prepare(`
    INSERT INTO visit_events (url, domain, title, visited_at, device_label, device_os, source)
    VALUES (?, ?, NULL, COALESCE(?, datetime('now')), ?, ?, ?)
  `).run(url, domain, visitedAt ?? null, deviceLabel ?? null, deviceOs ?? null, source);
}

/** Visit events for a single local date (YYYY-MM-DD). */
export function visitEventsForDate(db: Db, dateStr: string): Pick<VisitEventRow, 'id' | 'url' | 'domain' | 'title' | 'visited_at'>[] {
  return db.prepare(`
    SELECT id, url, domain, title, visited_at
    FROM visit_events
    WHERE date(visited_at, 'localtime') = ?
    ORDER BY visited_at ASC
  `).all(dateStr) as Pick<VisitEventRow, 'id' | 'url' | 'domain' | 'title' | 'visited_at'>[];
}

// ── Diary sidecar (太い JSON 列をファイル外出し) ────────────────────────
//
// `metrics_json` と `github_commits_json` は 1 行 80KB に膨らむ太さなので、
// `<dataDir>/diary/<date>.json` に逃がして DB はサマリだけ保持する。
// データフロー:
//   write: upsertDiary が metrics / githubCommits を受け取ったら sidecar に
//          書き出し、 DB の `*_json` 列は NULL のままにする。
//   read:  getDiary は DB 行を取り、 sidecar があればそこから metrics /
//          github_commits を埋める。 sidecar が無ければ DB 列を fallback。
//   delete: deleteDiary が sidecar も unlink する。
// マイグレーション (migrateDiariesToSidecar) は起動時 1 回で旧データを
// sidecar に移し、 DB 列を NULL 化する。
//
// dataDir は index.js から setDiaryDataDir で注入する (db.js を fs から
// 切り離さないために、 dir 未設定時は sidecar を no-op にして DB 列のみで動く)。

let DIARY_DATA_DIR: string | null = null;

export function setDiaryDataDir(dir: string | null): void {
  DIARY_DATA_DIR = dir || null;
}

function diarySidecarPath(dateStr: string): string | null {
  if (!DIARY_DATA_DIR) return null;
  return join(DIARY_DATA_DIR, 'diary', `${dateStr}.json`);
}

interface DiarySidecar {
  metrics?: unknown;
  github_commits?: unknown;
}

function readDiarySidecar(dateStr: string): DiarySidecar | null {
  const file = diarySidecarPath(dateStr);
  if (!file) return null;
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as DiarySidecar;
  } catch { return null; }
}

function writeDiarySidecar(dateStr: string, partial: DiarySidecar): boolean {
  const file = diarySidecarPath(dateStr);
  if (!file) return false;
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  // Merge with any existing sidecar so partial writes don't drop other keys.
  let cur: DiarySidecar = {};
  if (existsSync(file)) {
    try { cur = (JSON.parse(readFileSync(file, 'utf8')) as DiarySidecar) || {}; } catch { /* ignore */ }
  }
  const next: DiarySidecar = { ...cur };
  if ('metrics' in partial) next.metrics = partial.metrics;
  if ('github_commits' in partial) next.github_commits = partial.github_commits;
  // Atomic-ish write: tmp + rename.
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, file);
  return true;
}

function deleteDiarySidecar(dateStr: string): void {
  const file = diarySidecarPath(dateStr);
  if (!file) return;
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch { /* ignore */ }
}

export interface DiaryEntryParsed extends DiaryEntryRow {
  metrics: unknown;
  github_commits: unknown;
}

export function getDiary(db: Db, dateStr: string): DiaryEntryParsed | null {
  const row = db.prepare(`SELECT * FROM diary_entries WHERE date = ?`).get(dateStr) as DiaryEntryRow | undefined;
  if (!row) return null;
  const side = readDiarySidecar(dateStr);
  // Sidecar wins; DB columns are kept as fallback for un-migrated rows.
  const metrics = side && 'metrics' in side
    ? side.metrics
    : (row.metrics_json ? safeParse(row.metrics_json) : null);
  const githubCommits = side && 'github_commits' in side
    ? side.github_commits
    : (row.github_commits_json ? safeParse(row.github_commits_json) : null);
  return {
    ...row,
    metrics_json: null,         // hide raw blob from API consumers
    github_commits_json: null,
    metrics,
    github_commits: githubCommits,
  };
}

export function listDiariesInRange(db: Db, { start, end }: { start: string; end: string }): Pick<DiaryEntryRow, 'date' | 'status' | 'summary' | 'notes' | 'work_content' | 'work_minutes' | 'updated_at'>[] {
  return db.prepare(`
    SELECT date, status, summary, notes, work_content, work_minutes, updated_at
    FROM diary_entries
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(start, end) as Pick<DiaryEntryRow, 'date' | 'status' | 'summary' | 'notes' | 'work_content' | 'work_minutes' | 'updated_at'>[];
}

// ── 週次レポート用 集計 helpers ─────────────────────────────────────────────
//
// 各テーブルの timestamp 列はすべて UTC ISO で格納されているので、
// `date(<col>, 'localtime')` でローカル日付に丸めてから期間 (YYYY-MM-DD)
// と突合する。 diary.date は元々ローカル日付なので変換不要。

export interface DateRange { start: string; end: string }

export function countBookmarksInRange(db: Db, { start, end }: DateRange): number {
  return ((db.prepare(`
    SELECT COUNT(*) AS c FROM bookmarks
    WHERE date(created_at, 'localtime') BETWEEN ? AND ?
  `).get(start, end) as { c: number } | undefined)?.c) ?? 0;
}

export function countVisitEventsInRange(db: Db, { start, end }: DateRange): number {
  return ((db.prepare(`
    SELECT COUNT(*) AS c FROM visit_events
    WHERE date(visited_at, 'localtime') BETWEEN ? AND ?
  `).get(start, end) as { c: number } | undefined)?.c) ?? 0;
}

export function countActivityEventsInRange(db: Db, kind: string, { start, end }: DateRange): number {
  return ((db.prepare(`
    SELECT COUNT(*) AS c FROM activity_events
    WHERE kind = ? AND date(occurred_at, 'localtime') BETWEEN ? AND ?
  `).get(kind, start, end) as { c: number } | undefined)?.c) ?? 0;
}

export interface WeeklyTotals {
  work_minutes: number;
  bookmarks: number;
  visit_events: number;
  github_commits: number;          // caller fills (githubByRepo.total)
  claude_code_prompts: number;
  git_commits_local: number;       // activity_events kind='git_commit' (= ローカル post-commit hook)
}

export interface UpsertDiaryInput {
  date: string;
  summary?: string | null;
  workContent?: string | null;
  workMinutes?: number | null;
  highlights?: string | null;
  notes?: string | null;
  metrics?: unknown;
  githubCommits?: unknown;
  status?: string | null;
  error?: string | null;
}

export function upsertDiary(db: Db, { date, summary, workContent, workMinutes, highlights, notes, metrics, githubCommits, status, error }: UpsertDiaryInput): void {
  // Persist heavy JSON to sidecar; DB columns are kept NULL going forward.
  // (Existing rows that still have *_json values continue to be served via
  // the fallback path in getDiary until migrateDiariesToSidecar runs.)
  const sidecarPatch: DiarySidecar = {};
  if (metrics !== undefined) sidecarPatch.metrics = metrics ?? null;
  if (githubCommits !== undefined) sidecarPatch.github_commits = githubCommits ?? null;
  if (Object.keys(sidecarPatch).length > 0) {
    writeDiarySidecar(date, sidecarPatch);
  }

  const tx = db.transaction(() => {
    const exists = db.prepare(`SELECT date FROM diary_entries WHERE date = ?`).get(date) as { date: string } | undefined;
    if (exists) {
      db.prepare(`
        UPDATE diary_entries
           SET summary = COALESCE(?, summary),
               work_content = COALESCE(?, work_content),
               work_minutes = COALESCE(?, work_minutes),
               highlights = COALESCE(?, highlights),
               notes = COALESCE(?, notes),
               status = COALESCE(?, status),
               error = ?,
               updated_at = datetime('now')
         WHERE date = ?
      `).run(
        summary ?? null,
        workContent ?? null,
        Number.isFinite(workMinutes) ? Math.round(workMinutes as number) : null,
        highlights ?? null,
        notes ?? null,
        status ?? null,
        error ?? null,
        date,
      );
    } else {
      db.prepare(`
        INSERT INTO diary_entries
          (date, summary, work_content, work_minutes, highlights, notes, status, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        date,
        summary ?? null,
        workContent ?? null,
        Number.isFinite(workMinutes) ? Math.round(workMinutes as number) : null,
        highlights ?? null,
        notes ?? null,
        status ?? 'pending',
        error ?? null,
      );
    }
  });
  tx();
}

// ── weekly reports ---------------------------------------------------------

export interface WeeklyReportParsed extends WeeklyReportRow {
  github_summary: unknown;
}

export function getWeekly(db: Db, weekStart: string): WeeklyReportParsed | null {
  const row = db.prepare(`SELECT * FROM weekly_reports WHERE week_start = ?`).get(weekStart) as WeeklyReportRow | undefined;
  if (!row) return null;
  return { ...row, github_summary: row.github_summary_json ? safeParse(row.github_summary_json) : null };
}

export function listWeeklyForMonth(db: Db, monthStr: string): Pick<WeeklyReportRow, 'week_start' | 'week_end' | 'week_in_month' | 'status' | 'summary' | 'updated_at'>[] {
  return db.prepare(`
    SELECT week_start, week_end, week_in_month, status, summary, updated_at
    FROM weekly_reports
    WHERE month = ?
    ORDER BY week_start ASC
  `).all(monthStr) as Pick<WeeklyReportRow, 'week_start' | 'week_end' | 'week_in_month' | 'status' | 'summary' | 'updated_at'>[];
}

export interface UpsertWeeklyInput {
  weekStart: string;
  weekEnd?: string | null;
  month?: string | null;
  weekInMonth?: number | null;
  summary?: string | null;
  githubSummary?: unknown;
  status?: string | null;
  error?: string | null;
}

export function upsertWeekly(db: Db, { weekStart, weekEnd, month, weekInMonth, summary, githubSummary, status, error }: UpsertWeeklyInput): void {
  const exists = db.prepare(`SELECT week_start FROM weekly_reports WHERE week_start = ?`).get(weekStart) as { week_start: string } | undefined;
  if (exists) {
    db.prepare(`
      UPDATE weekly_reports
         SET week_end = COALESCE(?, week_end),
             month = COALESCE(?, month),
             week_in_month = COALESCE(?, week_in_month),
             summary = COALESCE(?, summary),
             github_summary_json = COALESCE(?, github_summary_json),
             status = COALESCE(?, status),
             error = ?,
             updated_at = datetime('now')
       WHERE week_start = ?
    `).run(
      weekEnd ?? null,
      month ?? null,
      weekInMonth ?? null,
      summary ?? null,
      githubSummary ? JSON.stringify(githubSummary) : null,
      status ?? null,
      error ?? null,
      weekStart,
    );
  } else {
    db.prepare(`
      INSERT INTO weekly_reports
        (week_start, week_end, month, week_in_month, summary, github_summary_json, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      weekStart,
      weekEnd,
      month,
      weekInMonth,
      summary ?? null,
      githubSummary ? JSON.stringify(githubSummary) : null,
      status ?? 'pending',
      error ?? null,
    );
  }
}

export function deleteWeekly(db: Db, weekStart: string): void {
  db.prepare(`DELETE FROM weekly_reports WHERE week_start = ?`).run(weekStart);
}

export function updateDiaryNotes(db: Db, dateStr: string, notes: string | null): void {
  db.prepare(`
    UPDATE diary_entries SET notes = ?, updated_at = datetime('now')
    WHERE date = ?
  `).run(notes ?? '', dateStr);
}

export function deleteDiary(db: Db, dateStr: string): void {
  db.prepare(`DELETE FROM diary_entries WHERE date = ?`).run(dateStr);
  deleteDiarySidecar(dateStr);
}

/**
 * 起動時に 1 回呼ぶマイグレーション。 旧スキーマで `metrics_json` /
 * `github_commits_json` に値があった行を sidecar ファイルに移し、 DB の
 * 列を NULL 化する。 idempotent。
 */
export function migrateDiariesToSidecar(db: Db): { moved: number; reason?: string } {
  if (!DIARY_DATA_DIR) return { moved: 0, reason: 'no data dir' };
  const rows = db.prepare(`
    SELECT date, metrics_json, github_commits_json
    FROM diary_entries
    WHERE metrics_json IS NOT NULL OR github_commits_json IS NOT NULL
  `).all() as Pick<DiaryEntryRow, 'date' | 'metrics_json' | 'github_commits_json'>[];
  if (!rows.length) return { moved: 0 };
  const tx = db.transaction(() => {
    for (const r of rows) {
      const patch: DiarySidecar = {};
      if (r.metrics_json) patch.metrics = safeParse(r.metrics_json);
      if (r.github_commits_json) patch.github_commits = safeParse(r.github_commits_json);
      writeDiarySidecar(r.date, patch);
      db.prepare(`
        UPDATE diary_entries
           SET metrics_json = NULL, github_commits_json = NULL
         WHERE date = ?
      `).run(r.date);
    }
  });
  tx();
  return { moved: rows.length };
}

export function getDiarySettings(db: Db): Record<string, string | null> {
  const rows = db.prepare(`SELECT key, value FROM diary_settings`).all() as { key: string; value: string | null }[];
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * 日記の commit 集計対象リポを返す (`owner/name` slug 配列)。
 *
 * 出典は `📋 作業一覧` の `repo_watch` テーブル (provider='github')。
 * 旧: `diary_settings.github_repos` のカンマ区切り手動入力 → 廃止。
 * ユーザは worklist で登録するだけで日記にも反映される。
 * worklist が空なら空配列を返し、 呼び出し側は GitHub 全体 search に fallback する。
 */
export function diaryRepos(db: Db): string[] {
  return listRepoWatch(db)
    .filter((r) => r.provider === 'github')
    .map((r) => `${r.owner}/${r.name}`);
}

export function setDiarySettings(db: Db, patch: Record<string, unknown>): void {
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') {
        db.prepare(`DELETE FROM diary_settings WHERE key = ?`).run(k);
      } else {
        db.prepare(`
          INSERT INTO diary_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(k, String(v));
      }
    }
  });
  tx();
}

export interface VisitDomainTally {
  domain: string;
  visits: number;
  urls: number;
  last_seen_at: string;
}

/**
 * Top domains across the page_visits log (URL-only history),
 * regardless of whether the URL is bookmarked.
 */
export function trendsVisitDomains(db: Db, { sinceDays = 30, limit = 12 }: { sinceDays?: number; limit?: number } = {}): VisitDomainTally[] {
  const rows = db.prepare(`
    SELECT v.url, v.visit_count, v.last_seen_at
    FROM page_visits v
    WHERE v.last_seen_at >= datetime('now', ?)
  `).all(`-${Number(sinceDays) || 30} days`) as { url: string; visit_count: number; last_seen_at: string }[];
  const tally = new Map<string, VisitDomainTally>();
  for (const r of rows) {
    const d = extractDomain(r.url);
    if (!d) continue;
    const cur = tally.get(d) || { domain: d, visits: 0, urls: 0, last_seen_at: '' };
    cur.visits += r.visit_count || 1;
    cur.urls += 1;
    if (!cur.last_seen_at || r.last_seen_at > cur.last_seen_at) cur.last_seen_at = r.last_seen_at;
    tally.set(d, cur);
  }
  return [...tally.values()]
    .sort((a, b) => b.visits - a.visits || b.urls - a.urls)
    .slice(0, Number(limit) || 12);
}

// ── trends -----------------------------------------------------------------

/** Top categories by save count within `sinceDays`. */
export function trendsCategories(db: Db, { sinceDays = 30, limit = 12 }: { sinceDays?: number; limit?: number } = {}): { category: string; count: number }[] {
  return db.prepare(`
    SELECT bc.category, COUNT(*) AS count
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at >= datetime('now', ?)
    GROUP BY bc.category
    ORDER BY count DESC
    LIMIT ?
  `).all(`-${Number(sinceDays) || 30} days`, Number(limit) || 12) as { category: string; count: number }[];
}

export interface CategoryDiffRow {
  category: string;
  current: number;
  previous: number;
  delta: number;
}

/**
 * Compare category counts in the current window with the previous window of
 * the same length. Returns categories with the largest absolute delta.
 */
export function trendsCategoryDiff(db: Db, { sinceDays = 7, limit = 8 }: { sinceDays?: number; limit?: number } = {}): CategoryDiffRow[] {
  const days = Number(sinceDays) || 7;
  const cur = db.prepare(`
    SELECT bc.category, COUNT(*) AS n
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at >= datetime('now', ?)
    GROUP BY bc.category
  `).all(`-${days} days`) as { category: string; n: number }[];
  const prev = db.prepare(`
    SELECT bc.category, COUNT(*) AS n
    FROM bookmark_categories bc
    JOIN bookmarks b ON b.id = bc.bookmark_id
    WHERE b.created_at < datetime('now', ?)
      AND b.created_at >= datetime('now', ?)
    GROUP BY bc.category
  `).all(`-${days} days`, `-${days * 2} days`) as { category: string; n: number }[];
  const map = new Map<string, { current: number; previous: number }>();
  for (const r of cur) map.set(r.category, { current: r.n, previous: 0 });
  for (const r of prev) {
    const c = map.get(r.category) || { current: 0, previous: 0 };
    c.previous = r.n;
    map.set(r.category, c);
  }
  const rows: CategoryDiffRow[] = [...map.entries()].map(([category, v]) => ({
    category,
    current: v.current,
    previous: v.previous,
    delta: v.current - v.previous,
  }));
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.current - a.current);
  return rows.slice(0, Number(limit) || 8);
}

export interface TimelineRow {
  date: string;
  saves: number;
  accesses: number;
}

/** Daily save and access counts (per day, local time) in the window. */
export function trendsTimeline(db: Db, { sinceDays = 30 }: { sinceDays?: number } = {}): TimelineRow[] {
  const days = Number(sinceDays) || 30;
  const saves = db.prepare(`
    SELECT date(created_at, 'localtime') AS d, COUNT(*) AS n
    FROM bookmarks
    WHERE created_at >= datetime('now', ?)
    GROUP BY d ORDER BY d ASC
  `).all(`-${days} days`) as { d: string; n: number }[];
  const accesses = db.prepare(`
    SELECT date(accessed_at, 'localtime') AS d, COUNT(*) AS n
    FROM accesses
    WHERE accessed_at >= datetime('now', ?)
    GROUP BY d ORDER BY d ASC
  `).all(`-${days} days`) as { d: string; n: number }[];
  // Build per-day series including zero-fill.
  const out: TimelineRow[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({
      date: local,
      saves: saves.find(r => r.d === local)?.n ?? 0,
      accesses: accesses.find(r => r.d === local)?.n ?? 0,
    });
  }
  return out;
}

/** Top accessed domains in window. Joins accesses with bookmarks to get URLs. */
export function trendsDomains(db: Db, { sinceDays = 30, limit = 12 }: { sinceDays?: number; limit?: number } = {}): { domain: string; hits: number }[] {
  const rows = db.prepare(`
    SELECT b.url, COUNT(a.id) AS hits
    FROM accesses a
    JOIN bookmarks b ON b.id = a.bookmark_id
    WHERE a.accessed_at >= datetime('now', ?)
    GROUP BY b.id
  `).all(`-${Number(sinceDays) || 30} days`) as { url: string; hits: number }[];
  const tally = new Map<string, number>();
  for (const r of rows) {
    const d = extractDomain(r.url);
    if (!d) continue;
    tally.set(d, (tally.get(d) ?? 0) + r.hits);
  }
  return [...tally.entries()]
    .map(([domain, hits]) => ({ domain, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, Number(limit) || 12);
}

export interface WorkHoursRow {
  date: string;
  minutes: number | null;
}

/**
 * Per-day estimated work minutes — sourced from `diary_entries.work_minutes`,
 * which is filled by Sonnet (`diary_work` task) when reading the day's URL
 * timeline. The previous algorithm derived sessions from visit_events alone
 * and over-counted days with long idle browser tabs (one open tab refreshing
 * itself for hours could push a single day past 24h).
 *
 * Days without a generated diary (or where Sonnet declined to estimate)
 * report `null` minutes — the chart skips them rather than misleading with 0.
 */
export function trendsWorkHours(db: Db, { sinceDays = 30 }: { sinceDays?: number } = {}): WorkHoursRow[] {
  const days = Number(sinceDays) || 30;
  function dateKeyLocal(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const rows = db.prepare(`
    SELECT date, work_minutes FROM diary_entries
    WHERE date >= ? AND work_minutes IS NOT NULL
  `).all(dateKeyLocal(new Date(Date.now() - (days - 1) * 86400_000))) as { date: string; work_minutes: number }[];
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.date, r.work_minutes);

  const out: WorkHoursRow[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = dateKeyLocal(dt);
    out.push({
      date: k,
      minutes: perDay.has(k) ? (perDay.get(k) as number) : null,
    });
  }
  return out;
}

export interface GpsWalkingRow {
  date: string;
  distance_km: number;
  /** 徒歩速度帯のみで積算した距離 (カロリー計算用) */
  walking_distance_km: number;
  walking_minutes: number;
  travel_minutes: number;
  // ── 「自宅以外にいた時間」 の内訳 (面積棒グラフ用) ──────────────
  // 1 日 = 自宅 + 移動 + 場所滞在 + 不明 (どこにも match しない停止)。
  // 「自宅以外」 = travel + 場所滞在 + 不明 の合計分数。 場所滞在は
  // work_locations (is_home=0) の name でキー化。
  /** 自宅 (work_locations.is_home=1) に居た分数 */
  home_minutes: number;
  /** 自宅以外の連続点をベースに集計した「外にいた」 合計分数 */
  away_minutes: number;
  /** 自宅以外 のうち、 0.5 m/s 以上で動いていた区間 */
  away_moving_minutes: number;
  /** 自宅以外 のうち、 登録 work_locations にいた時間。 場所 name でキー化。 */
  away_places: { name: string; minutes: number }[];
  /** 自宅以外 のうち、 場所未登録 + 停止 (= 不明な滞在) */
  away_unknown_minutes: number;
}

/**
 * Per-day walking summary derived from `gps_locations` (OwnTracks 由来):
 *   - distance_km: 連続点の haversine 合計 (accuracy < 200m / Δt < 10min で
 *     ノイズフィルタ)
 *   - walking_minutes: 0.5〜3.5 m/s の区間 Δt 合計 (徒歩速度帯)
 *   - travel_minutes: 0.5 m/s 以上で動いていた区間 Δt 合計 (移動全体、
 *     乗り物含む)
 *   - home_minutes / away_* : 各 GPS 点を work_locations の radius_m で
 *     home / 場所 / 不明 に分類 (priority: is_home=1 > is_home=0 > 不明)。
 *     セグメント Δt をその分類に振り分けて積算する。
 *
 * 静止判定は速度ベース。停車中の jitter は accuracy で弾く。
 */
export function trendsGpsWalking(db: Db, { sinceDays = 30, userId = 'me' }: { sinceDays?: number; userId?: string } = {}): GpsWalkingRow[] {
  const days = Number(sinceDays) || 30;
  function dateKeyLocal(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseUtc(s: string): Date {
    // recorded_at は 2 形式が混在する:
    //   - "2026-05-16T02:36:06.000Z"  (OwnTracks 直接挿入: ISO + Z)
    //   - "2026-05-16 02:36:06"       (Legatus/diary 経由: SQLite datetime)
    // 後者は UTC として 'Z' を付ける必要があるが、 既に Z が付いている前者に
    // 二度 Z を足すと Invalid Date になる (= 全 row 弾かれて全日 0 になる)。
    const raw = String(s).replace(' ', 'T');
    return new Date(/[zZ]$/.test(raw) ? raw : raw + 'Z');
  }
  function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const R = 6_371_008;
    const toRad = (deg: number): number => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const sa = Math.sin(dLat / 2);
    const so = Math.sin(dLon / 2);
    const h = sa * sa + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * so * so;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // GPS は 「移動した時だけ点を打つ」 ので、 連続する 2 点 (p1, p2) の間は
  // 「p1 の場所に居続けて、 p2 で観測される直前に移動した」 と仮定する。
  //   → gap 全体を p1 の class に倒す (同一クラスでも遷移でも同じ扱い)
  //   → cap は 12 時間 (これより長い gap はデータ欠落とみなして無視)
  // 移動メトリクス (距離 / walking / travel) は速度ノイズ防止のため 10 分超
  // で切る (= 別ロジック)。
  const SEG_DT_MAX_MS_MOVEMENT = 10 * 60_000;            // 10 分 (移動メトリクス用)
  const SEG_DT_MAX_MS_DWELL    = 12 * 60 * 60_000;       // 12 時間 (滞在仮定の上限)
  const ACC_MAX_M = 200;                   // accuracy 200m 超は jitter とみなす
  const WALK_MIN_MPS = 0.5;                // 1.8 km/h
  const WALK_MAX_MPS = 3.5;                // 12.6 km/h (上限 = ジョギング以下)
  const TRAVEL_MIN_MPS = 0.5;              // 動いている扱いの下限
  const DEFAULT_RADIUS_M = 100;            // work_locations.radius_m が NULL の時の既定

  // work_locations を読み、 home + その他の場所に分けて in-memory 配列にする。
  const places = db.prepare(`
    SELECT id, name, latitude, longitude, radius_m, is_home
    FROM work_locations
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `).all() as Array<{ id: number; name: string; latitude: number; longitude: number; radius_m: number | null; is_home: 0 | 1 }>;
  const homePlace = places.find(p => p.is_home === 1) || null;
  const otherPlaces = places.filter(p => p.is_home === 0);

  function classifyPoint(lat: number, lon: number): { kind: 'home' | 'place' | 'unknown'; placeName?: string } {
    // priority: home > その他 > 不明。 同 priority 内は最も近い場所を選ぶ。
    if (homePlace) {
      const r = homePlace.radius_m ?? DEFAULT_RADIUS_M;
      const d = haversineMeters({ lat, lon }, { lat: homePlace.latitude, lon: homePlace.longitude });
      if (d <= r) return { kind: 'home' };
    }
    let best: { p: typeof otherPlaces[number]; d: number } | null = null;
    for (const p of otherPlaces) {
      const r = p.radius_m ?? DEFAULT_RADIUS_M;
      const d = haversineMeters({ lat, lon }, { lat: p.latitude, lon: p.longitude });
      if (d <= r && (!best || d < best.d)) best = { p, d };
    }
    if (best) return { kind: 'place', placeName: best.p.name };
    return { kind: 'unknown' };
  }

  const startDate = new Date(Date.now() - (days - 1) * 86400_000);
  const startKey = dateKeyLocal(startDate);
  const rows = db.prepare(`
    SELECT recorded_at, lat, lon, accuracy_m
    FROM gps_locations
    WHERE user_id = ? AND date(recorded_at, 'localtime') >= ?
    ORDER BY recorded_at ASC
  `).all(userId, startKey) as { recorded_at: string; lat: number; lon: number; accuracy_m: number | null }[];

  interface DayBucket {
    distance_m: number;        // 移動距離 (vehicle 含む)
    walking_distance_m: number; // 徒歩速度帯のみで積算 (= カロリー計算の根拠)
    walking_ms: number;
    travel_ms: number;
    home_ms: number;
    away_moving_ms: number;
    away_places_ms: Map<string, number>;
    away_unknown_ms: number;
  }
  const perDay = new Map<string, DayBucket>();
  function bucket(key: string): DayBucket {
    let b = perDay.get(key);
    if (!b) {
      b = {
        distance_m: 0, walking_distance_m: 0, walking_ms: 0, travel_ms: 0,
        home_ms: 0, away_moving_ms: 0, away_places_ms: new Map(), away_unknown_ms: 0,
      };
      perDay.set(key, b);
    }
    return b;
  }
  function attributeDwell(b: DayBucket, dwellMs: number, cls: ReturnType<typeof classifyPoint>): void {
    if (dwellMs <= 0) return;
    if (cls.kind === 'home') b.home_ms += dwellMs;
    else if (cls.kind === 'place' && cls.placeName) {
      b.away_places_ms.set(cls.placeName, (b.away_places_ms.get(cls.placeName) || 0) + dwellMs);
    } else b.away_unknown_ms += dwellMs;
  }
  type PrevPoint = { ts: number; key: string; lat: number; lon: number; accOk: boolean; cls: ReturnType<typeof classifyPoint> };
  let prev: PrevPoint | null = null;
  for (const r of rows) {
    const d = parseUtc(r.recorded_at);
    const ts = d.getTime();
    if (!Number.isFinite(ts)) { prev = null; continue; }
    const key = dateKeyLocal(d);
    const accOk = !r.accuracy_m || r.accuracy_m < ACC_MAX_M;
    const cls = classifyPoint(r.lat, r.lon);
    if (prev && prev.key === key && accOk && prev.accOk) {
      const dt = ts - prev.ts;
      if (dt > 0 && dt <= SEG_DT_MAX_MS_DWELL) {
        const dist = haversineMeters(prev, { lat: r.lat, lon: r.lon });
        const speed = dist / (dt / 1000); // m/s
        const b = bucket(key);
        const moving = (dt <= SEG_DT_MAX_MS_MOVEMENT) && (speed >= TRAVEL_MIN_MPS);

        // 1. 移動メトリクス (10 分以内 + 速度あり、 速度ノイズ除去)
        if (dt <= SEG_DT_MAX_MS_MOVEMENT) {
          b.distance_m += dist;
          if (speed >= TRAVEL_MIN_MPS) b.travel_ms += dt;
          if (speed >= WALK_MIN_MPS && speed <= WALK_MAX_MPS) {
            b.walking_ms += dt;
            b.walking_distance_m += dist;
          }
        }

        // 2. 滞在分類 (GPS は移動した時だけ点を打つ前提):
        //    短時間 (≤ 10 分) で動いている → 移動中として away_moving
        //    それ以外の gap (静止 or sparse) → p1 の場所に滞在し続けたと仮定
        if (moving) {
          b.away_moving_ms += dt;
        } else {
          attributeDwell(b, dt, prev.cls);
        }
      }
    }
    prev = { ts, key, lat: r.lat, lon: r.lon, accOk, cls };
  }

  const out: GpsWalkingRow[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const k = dateKeyLocal(dt);
    const b = perDay.get(k);
    if (!b) {
      out.push({
        date: k, distance_km: 0, walking_distance_km: 0, walking_minutes: 0, travel_minutes: 0,
        home_minutes: 0, away_minutes: 0, away_moving_minutes: 0,
        away_places: [], away_unknown_minutes: 0,
      });
      continue;
    }
    const home_min = Math.round(b.home_ms / 60_000);
    const moving_min = Math.round(b.away_moving_ms / 60_000);
    const unknown_min = Math.round(b.away_unknown_ms / 60_000);
    const places_arr = [...b.away_places_ms.entries()]
      .map(([name, ms]) => ({ name, minutes: Math.round(ms / 60_000) }))
      .filter(p => p.minutes > 0)
      .sort((a, b2) => b2.minutes - a.minutes);
    const places_total = places_arr.reduce((s, p) => s + p.minutes, 0);
    out.push({
      date: k,
      distance_km: Number((b.distance_m / 1000).toFixed(2)),
      walking_distance_km: Number((b.walking_distance_m / 1000).toFixed(2)),
      walking_minutes: Math.round(b.walking_ms / 60_000),
      travel_minutes: Math.round(b.travel_ms / 60_000),
      home_minutes: home_min,
      away_minutes: moving_min + places_total + unknown_min,
      away_moving_minutes: moving_min,
      away_places: places_arr,
      away_unknown_minutes: unknown_min,
    });
  }
  return out;
}

const KEYWORD_STOPWORDS = new Set<string>([
  'the','and','for','with','from','that','this','your','you','our','have','has','was','were','will','what','when','where','which','who','about','into','than','then','also','but','not','are','can','use','using','how','why','etc',
  'について','として','による','によって','などの','する','して','です','ます','ない','ある','こと','もの','よう','これ','それ','ため','など','とは','では','での','さん','さま','様','記事','ページ','こちら','そして','しかし','ただし','ここ','以下','以上',
]);

function tokenize(text: string | null | undefined): string[] {
  const t = String(text || '').toLowerCase();
  const out: string[] = [];
  // ASCII / Latin words ≥ 3 chars.
  for (const m of t.matchAll(/[a-z][a-z0-9_+#.-]{2,}/g)) out.push(m[0]);
  // Japanese-ish runs ≥ 2 chars (CJK + katakana/hiragana lump).
  for (const m of t.matchAll(/[぀-ヿ一-鿿]{2,}/g)) out.push(m[0]);
  return out.filter(w => !KEYWORD_STOPWORDS.has(w));
}

/**
 * Keyword frequency across recent page titles + bookmark titles + dig
 * queries. Crude tokeniser: ASCII words ≥3 chars + JP runs ≥2 chars,
 * minus stopwords.
 */
export function trendsKeywords(db: Db, { sinceDays = 30, limit = 25 }: { sinceDays?: number; limit?: number } = {}): { word: string; count: number }[] {
  const days = Number(sinceDays) || 30;
  const ago = `-${days} days`;
  const sources: (string | null)[] = [];
  for (const r of db.prepare(`
    SELECT title FROM page_visits WHERE last_seen_at >= datetime('now', ?)
  `).all(ago) as { title: string | null }[]) sources.push(r.title);
  for (const r of db.prepare(`
    SELECT title FROM bookmarks WHERE created_at >= datetime('now', ?)
  `).all(ago) as { title: string | null }[]) sources.push(r.title);
  for (const r of db.prepare(`
    SELECT query FROM dig_sessions WHERE created_at >= datetime('now', ?)
  `).all(ago) as { query: string | null }[]) sources.push(r.query);
  // Dictionary terms also reflect what the user is studying.
  for (const r of db.prepare(`
    SELECT term FROM dictionary_entries WHERE updated_at >= datetime('now', ?)
  `).all(ago) as { term: string | null }[]) sources.push(r.term);

  const tally = new Map<string, number>();
  for (const text of sources) {
    if (!text) continue;
    const seen = new Set<string>();  // count each source once per word
    for (const w of tokenize(text)) {
      if (seen.has(w)) continue;
      seen.add(w);
      tally.set(w, (tally.get(w) || 0) + 1);
    }
  }
  return [...tally.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Number(limit) || 25);
}

export function recordAccess(db: Db, bookmarkId: number): void {
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO accesses (bookmark_id) VALUES (?)`).run(bookmarkId);
    db.prepare(`
      UPDATE bookmarks
      SET last_accessed_at = datetime('now'),
          access_count    = access_count + 1
      WHERE id = ?
    `).run(bookmarkId);
  });
  tx();
}

export function listAccesses(db: Db, bookmarkId: number, limit = 50): { id: number; accessed_at: string }[] {
  return db.prepare(`
    SELECT id, accessed_at FROM accesses
    WHERE bookmark_id = ? ORDER BY accessed_at DESC LIMIT ?
  `).all(bookmarkId, limit) as { id: number; accessed_at: string }[];
}

export function deleteBookmark(db: Db, id: number): string | null {
  const row = db.prepare(`SELECT html_path FROM bookmarks WHERE id = ?`).get(id) as { html_path: string } | undefined;
  db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(id);
  return row?.html_path ?? null;
}

export interface ImportedBookmarkInput {
  url: string;
  title?: string | null;
  html_path?: string | null;
  summary?: string | null;
  memo?: string | null;
  created_at?: string | null;
  last_accessed_at?: string | null;
  access_count?: number | null;
  categories?: string[];
}

export interface InsertImportedBookmarkResult {
  skipped: boolean;
  id: number;
}

/** Insert a bookmark from an export bundle. Skips if URL already exists. */
export function insertImportedBookmark(db: Db, b: ImportedBookmarkInput): InsertImportedBookmarkResult {
  const existing = findBookmarkByUrl(db, b.url);
  if (existing) return { skipped: true, id: existing.id };
  const info = db.prepare(`
    INSERT INTO bookmarks (url, title, html_path, summary, memo, status, created_at, updated_at, last_accessed_at, access_count)
    VALUES (?, ?, ?, ?, ?, 'done', COALESCE(?, datetime('now')), datetime('now'), ?, ?)
  `).run(
    b.url,
    b.title ?? '',
    b.html_path ?? '',
    b.summary ?? null,
    b.memo ?? '',
    b.created_at ?? null,
    b.last_accessed_at ?? null,
    b.access_count ?? 0,
  );
  const id = Number(info.lastInsertRowid);
  if (Array.isArray(b.categories)) {
    const ins = db.prepare(`INSERT OR IGNORE INTO bookmark_categories (bookmark_id, category) VALUES (?, ?)`);
    for (const cat of b.categories) {
      const trimmed = String(cat).trim();
      if (trimmed) ins.run(id, trimmed);
    }
  }
  return { skipped: false, id };
}

// ---------------------------------------------------------------------------
// gps_locations — OwnTracks 由来の位置情報
// ---------------------------------------------------------------------------

// 停止区間判定の距離閾値 (メートル)。 GPS 精度 (5-20m) より十分大きく取り、
// 数 m の jitter を停止扱いに集約する。 50m を超える移動は別セグメント扱い。
export const GPS_STATIONARY_THRESHOLD_M = 50;

/**
 * Haversine 距離 (m)。地球半径 6371008 (mean)。db.js 内専用ヘルパ。
 */
function gpsHaversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_008;
  const t = (d: number): number => (d * Math.PI) / 180;
  const dLat = t(b.lat - a.lat);
  const dLon = t(b.lon - a.lon);
  const sa = Math.sin(dLat / 2);
  const so = Math.sin(dLon / 2);
  const h = sa * sa + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * so * so;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GpsLocationInput {
  userId?: string;
  deviceId?: string | null;
  recordedAt?: string;
  tst?: number;
  lat: number;
  lon: number;
  accuracy?: number | null;
  altitude?: number | null;
  velocity?: number | null;
  course?: number | null;
  battery?: number | null;
  conn?: string | null;
  rawJson?: string | null;
}

export type InsertGpsLocationResult =
  | { skipped: true; id: number }
  | { merged: true; id: number }
  | { inserted: true; id: number };

/**
 * 1 点の GPS 位置を挿入する。同一 (user_id, device_id, recorded_at) は無視 (重複防止)。
 * `loc.recordedAt` は ISO 8601、`loc.tst` (OwnTracks の epoch 秒) どちらか必須。
 *
 * **圧縮**: 同 user+device の直近 2 行 (PREV, LAST) を見て、 PREV-LAST-NEW
 * の 3 つすべてが {@link GPS_STATIONARY_THRESHOLD_M} 内にあれば「停止区間が
 * 継続している」 とみなし、 LAST 行を NEW で UPDATE する (start = PREV を残し、
 * tail = LAST が NEW にスライド)。 結果として停止区間は常に 2 行 (start + end)
 * に圧縮される。 移動した瞬間 (どれかが threshold 超過) は通常 INSERT。
 *
 * 戻り値:
 *   { skipped: true, id }   — 重複 (同 ts の同点が既にある)
 *   { merged: true, id }    — 圧縮 (UPDATE LAST → NEW)
 *   { inserted: true, id }  — 通常挿入
 */
export function insertGpsLocation(db: Db, loc: GpsLocationInput): InsertGpsLocationResult {
  const userId = loc.userId || 'me';
  const recordedAt = loc.recordedAt
    ? loc.recordedAt
    : (typeof loc.tst === 'number'
        ? new Date(loc.tst * 1000).toISOString()
        : new Date().toISOString());

  // CONFLICT 回避: 同一 (user, device, time) の点は dedup
  const dupCheck = db.prepare(`
    SELECT id FROM gps_locations
    WHERE user_id = ? AND IFNULL(device_id, '') = IFNULL(?, '') AND recorded_at = ?
    LIMIT 1
  `).get(userId, loc.deviceId ?? null, recordedAt) as { id: number } | undefined;
  if (dupCheck) return { skipped: true, id: dupCheck.id };

  // 圧縮判定: 直近 2 行を確認
  const recent = db.prepare(`
    SELECT id, lat, lon, recorded_at, samples_count, samples_first_at
    FROM gps_locations
    WHERE user_id = ? AND IFNULL(device_id, '') = IFNULL(?, '')
    ORDER BY recorded_at DESC
    LIMIT 2
  `).all(userId, loc.deviceId ?? null) as { id: number; lat: number; lon: number; recorded_at: string; samples_count: number; samples_first_at: string | null }[];

  if (recent.length === 2) {
    const LAST = recent[0];
    const PREV = recent[1];
    const N = { lat: loc.lat, lon: loc.lon };
    const T = GPS_STATIONARY_THRESHOLD_M;
    if (
      gpsHaversine(PREV, LAST) < T &&
      gpsHaversine(PREV, N) < T &&
      gpsHaversine(LAST, N) < T
    ) {
      // 停止区間継続。 LAST を NEW で上書き (PREV = anchor, LAST = tail を更新)。
      // samples_first_at は LAST が初めて圧縮対象になった瞬間を保持する。
      const samplesFirstAt = LAST.samples_first_at || LAST.recorded_at;
      db.prepare(`
        UPDATE gps_locations
        SET recorded_at = ?, lat = ?, lon = ?,
            accuracy_m = ?, altitude_m = ?, velocity_kmh = ?, course_deg = ?,
            battery_pct = ?, conn = ?, raw_json = ?,
            samples_count = samples_count + 1,
            samples_first_at = COALESCE(samples_first_at, ?)
        WHERE id = ?
      `).run(
        recordedAt,
        loc.lat,
        loc.lon,
        loc.accuracy ?? null,
        loc.altitude ?? null,
        loc.velocity ?? null,
        loc.course ?? null,
        loc.battery ?? null,
        loc.conn ?? null,
        loc.rawJson ?? null,
        samplesFirstAt,
        LAST.id,
      );
      return { merged: true, id: LAST.id };
    }
  }

  // 通常 INSERT
  const info = db.prepare(`
    INSERT INTO gps_locations
      (user_id, device_id, recorded_at, lat, lon,
       accuracy_m, altitude_m, velocity_kmh, course_deg, battery_pct, conn, raw_json,
       samples_count, samples_first_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
  `).run(
    userId,
    loc.deviceId ?? null,
    recordedAt,
    loc.lat,
    loc.lon,
    loc.accuracy ?? null,
    loc.altitude ?? null,
    loc.velocity ?? null,
    loc.course ?? null,
    loc.battery ?? null,
    loc.conn ?? null,
    loc.rawJson ?? null,
  );
  return { inserted: true, id: Number(info.lastInsertRowid) };
}

// ── 位置照合 (place name/address) 関連 helpers ──────────────────────────────

export interface NearbyPlace {
  place_name: string | null;
  place_address: string | null;
  place_source: GpsLocationRow['place_source'];
}

/**
 * 近接 (約 gridM 以内) で既に place_name が解決済の点を 1 件返す.
 * 数百件規模の DB なら full scan で十分速い (lat/lon 範囲条件で枝刈り).
 */
export function findNearbyResolvedPlace(db: Db, lat: number, lon: number, gridM = 10): NearbyPlace | null {
  // 1 度 ≈ 111,320m → 10m なら 0.00009 度. 緯度方向は固定、 経度は cos 補正.
  const dLat = gridM / 111_320;
  const dLon = gridM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const row = db.prepare(`
    SELECT place_name, place_address, place_source
      FROM gps_locations
     WHERE place_resolved_at IS NOT NULL
       AND place_source IN ('places', 'geocode', 'cached')
       AND lat BETWEEN ? AND ?
       AND lon BETWEEN ? AND ?
     ORDER BY place_resolved_at DESC
     LIMIT 1
  `).get(lat - dLat, lat + dLat, lon - dLon, lon + dLon) as NearbyPlace | undefined;
  return row ?? null;
}

export interface SetGpsPlaceInput {
  name?: string | null;
  address?: string | null;
  source?: GpsLocationRow['place_source'];
}

/** id の行に place 結果を書き込む. resolved_at は now (unix sec). */
export function setGpsPlace(db: Db, id: number, { name, address, source }: SetGpsPlaceInput): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE gps_locations
       SET place_name = ?, place_address = ?, place_source = ?, place_resolved_at = ?
     WHERE id = ?
  `).run(name ?? null, address ?? null, source ?? 'failed', now, id);
}

export interface UnresolvedGpsLocation {
  id: number;
  lat: number;
  lon: number;
  recorded_at: string;
  device_id: string | null;
}

/**
 * 未解決の点 (place_resolved_at IS NULL) を新しい順に N 件返す.
 * バックフィルジョブ用.
 */
export function listUnresolvedGpsLocations(db: Db, limit = 50): UnresolvedGpsLocation[] {
  return db.prepare(`
    SELECT id, lat, lon, recorded_at, device_id
      FROM gps_locations
     WHERE place_resolved_at IS NULL
     ORDER BY id DESC
     LIMIT ?
  `).all(limit) as UnresolvedGpsLocation[];
}

/** 1 行を id 指定で読む (resolver の race 防止用). */
export function findGpsLocationById(db: Db, id: number): { id: number; lat: number; lon: number; place_resolved_at: number | null } | null {
  return (db.prepare(`SELECT id, lat, lon, place_resolved_at FROM gps_locations WHERE id = ?`)
    .get(id) as { id: number; lat: number; lon: number; place_resolved_at: number | null } | undefined) ?? null;
}

export interface CompressGpsHistoryInput {
  userId?: string;
  deviceId?: string | null;
  threshold?: number;
}

export interface CompressGpsHistorySummary {
  devices: { device_id: string | null; before: number; after: number; deleted: number; segments: number }[];
  total_deleted: number;
  total_segments: number;
  total_kept: number;
}

/**
 * 既存 GPS データに対して圧縮を遡及適用する (backfill)。
 *
 * デバイスごとに時系列で点列を読み、 連続点が threshold 内にある「停止クラスタ」を
 * 検出して、 始点 (anchor) と終点 (tail) の 2 行のみ残し中間を削除する。
 * tail の samples_count にはクラスタ内の元 raw 発行数 (削除分含む) が
 * 集約される。
 *
 * 引数:
 *   userId   — 対象ユーザ (default 'me')
 *   deviceId — 特定デバイスのみ処理 (default 全デバイス)
 *   threshold — 距離閾値 m (default GPS_STATIONARY_THRESHOLD_M)
 *
 * 戻り値: { devices: [{device_id, before, after, deleted, segments}], total_deleted, total_segments }
 */
export function compressGpsHistory(db: Db, { userId = 'me', deviceId = null, threshold = GPS_STATIONARY_THRESHOLD_M }: CompressGpsHistoryInput = {}): CompressGpsHistorySummary {
  const T = threshold;

  // 対象デバイスを列挙
  const deviceRows: { device_id: string | null }[] = deviceId
    ? [{ device_id: deviceId }]
    : (db.prepare(`
        SELECT DISTINCT device_id FROM gps_locations WHERE user_id = ?
      `).all(userId) as { device_id: string | null }[]);

  const summary: CompressGpsHistorySummary = { devices: [], total_deleted: 0, total_segments: 0, total_kept: 0 };

  for (const { device_id } of deviceRows) {
    const rows = db.prepare(`
      SELECT id, recorded_at, lat, lon, samples_count, samples_first_at
      FROM gps_locations
      WHERE user_id = ? AND IFNULL(device_id, '') = IFNULL(?, '')
      ORDER BY recorded_at ASC
    `).all(userId, device_id) as { id: number; recorded_at: string; lat: number; lon: number; samples_count: number; samples_first_at: string | null }[];

    const before = rows.length;
    if (rows.length < 3) {
      summary.devices.push({ device_id, before, after: before, deleted: 0, segments: rows.length > 0 ? 1 : 0 });
      summary.total_kept += before;
      continue;
    }

    let deleted = 0;
    let segments = 0;

    const tx = db.transaction(() => {
      let i = 0;
      while (i < rows.length) {
        const anchor = rows[i];
        // クラスタ拡張: 次点が anchor + 直前点 両方から threshold 内にある間延長
        let j = i + 1;
        while (
          j < rows.length &&
          gpsHaversine(anchor, rows[j]) < T &&
          gpsHaversine(rows[j - 1], rows[j]) < T
        ) {
          j++;
        }
        // クラスタは rows[i .. j-1]
        const clusterSize = j - i;
        segments++;
        if (clusterSize > 2) {
          // 中間 rows[i+1 .. j-2] を削除、 tail = rows[j-1] を更新
          const tail = rows[j - 1];
          const middleIds = rows.slice(i + 1, j - 1).map((r) => r.id);
          // tail の samples_count = anchor を除いたクラスタ全 raw 発行数 (= 削除分 + 元 tail 自身)
          const tailNewSamples = rows.slice(i + 1, j).reduce((s, r) => s + (r.samples_count || 1), 0);
          const samplesFirstAt = rows[i + 1].samples_first_at || rows[i + 1].recorded_at;
          const delStmt = db.prepare(`DELETE FROM gps_locations WHERE id = ?`);
          for (const id of middleIds) delStmt.run(id);
          db.prepare(`
            UPDATE gps_locations
            SET samples_count = ?, samples_first_at = ?
            WHERE id = ?
          `).run(tailNewSamples, samplesFirstAt, tail.id);
          deleted += middleIds.length;
        }
        i = j;
      }
    });
    tx();

    summary.devices.push({
      device_id,
      before,
      after: before - deleted,
      deleted,
      segments,
    });
    summary.total_deleted += deleted;
    summary.total_segments += segments;
    summary.total_kept += before - deleted;
  }

  return summary;
}

export interface ListGpsLocationsInRangeInput {
  from?: string;
  to?: string;
  userId?: string;
  deviceId?: string | null;
}

export type GpsLocationInRangeRow = Pick<
  GpsLocationRow,
  | 'id' | 'user_id' | 'device_id' | 'recorded_at' | 'lat' | 'lon'
  | 'accuracy_m' | 'altitude_m' | 'velocity_kmh' | 'course_deg' | 'battery_pct' | 'conn'
  | 'samples_count' | 'samples_first_at'
>;

/**
 * 期間内の位置点を時系列順で返す。`from` / `to` は ISO 8601。
 * device_id を絞り込みたい場合は `deviceId` を渡す。
 */
export function listGpsLocationsInRange(db: Db, { from, to, userId = 'me', deviceId }: ListGpsLocationsInRangeInput = {}): GpsLocationInRangeRow[] {
  const where = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (from) { where.push('recorded_at >= ?'); params.push(from); }
  if (to)   { where.push('recorded_at <= ?'); params.push(to); }
  if (deviceId) { where.push('device_id = ?'); params.push(deviceId); }
  return db.prepare(`
    SELECT id, user_id, device_id, recorded_at, lat, lon,
           accuracy_m, altitude_m, velocity_kmh, course_deg, battery_pct, conn,
           samples_count, samples_first_at
    FROM gps_locations
    WHERE ${where.join(' AND ')}
    ORDER BY recorded_at ASC
  `).all(...params) as GpsLocationInRangeRow[];
}

export interface GpsLocationDay {
  day: string;
  points: number;
  first_at: string;
  last_at: string;
}

/**
 * 位置情報を持っている日付 (YYYY-MM-DD, local TZ) と件数を新しい順で返す。
 * UI の date picker / カレンダー表示用。
 */
export function listGpsLocationDays(db: Db, { userId = 'me', limit = 365 }: { userId?: string; limit?: number } = {}): GpsLocationDay[] {
  return db.prepare(`
    SELECT date(recorded_at, 'localtime') AS day,
           COUNT(*)                       AS points,
           MIN(recorded_at)               AS first_at,
           MAX(recorded_at)               AS last_at
    FROM gps_locations
    WHERE user_id = ?
    GROUP BY day
    ORDER BY day DESC
    LIMIT ?
  `).all(userId, limit) as GpsLocationDay[];
}

/**
 * 当日 (local TZ) の点件数。日記 / metrics 用の安価な取得。
 */
export function gpsLocationCountForDate(db: Db, dateStr: string, { userId = 'me' }: { userId?: string } = {}): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM gps_locations
    WHERE user_id = ? AND date(recorded_at, 'localtime') = ?
  `).get(userId, dateStr) as { n: number } | undefined;
  return row ? row.n : 0;
}

export type GpsLocationForDateRow = Pick<
  GpsLocationRow,
  | 'id' | 'device_id' | 'recorded_at' | 'lat' | 'lon'
  | 'accuracy_m' | 'altitude_m' | 'velocity_kmh' | 'course_deg'
  | 'samples_count' | 'samples_first_at'
  | 'place_name' | 'place_address' | 'place_source'
>;

/**
 * 指定日 (local TZ) の点を時系列で返す。日記の metrics + Maps overlay 共用。
 */
export function listGpsLocationsForDate(db: Db, dateStr: string, { userId = 'me' }: { userId?: string } = {}): GpsLocationForDateRow[] {
  return db.prepare(`
    SELECT id, device_id, recorded_at, lat, lon,
           accuracy_m, altitude_m, velocity_kmh, course_deg,
           samples_count, samples_first_at,
           place_name, place_address, place_source
    FROM gps_locations
    WHERE user_id = ? AND date(recorded_at, 'localtime') = ?
    ORDER BY recorded_at ASC
  `).all(userId, dateStr) as GpsLocationForDateRow[];
}

/**
 * 古い点を削除する (retention)。`olderThan` は ISO 8601。
 */
export function deleteGpsLocationsOlderThan(db: Db, olderThan: string, { userId = 'me' }: { userId?: string } = {}): number {
  const info = db.prepare(`
    DELETE FROM gps_locations
    WHERE user_id = ? AND recorded_at < ?
  `).run(userId, olderThan);
  return info.changes;
}

// ─── meals ────────────────────────────────────────────────

export interface NearestGpsResult {
  id: number;
  recorded_at: string;
  lat: number;
  lon: number;
  accuracy_m: number | null;
}

/** Find the GPS point closest to `at` (ISO8601), within `windowMs`. */
export function findNearestGpsLocation(db: Db, at: string, { windowMs = 5 * 60 * 1000, userId = 'me' }: { windowMs?: number; userId?: string } = {}): NearestGpsResult | null {
  const center = new Date(at);
  if (isNaN(center.getTime())) return null;
  const from = new Date(center.getTime() - windowMs).toISOString();
  const to = new Date(center.getTime() + windowMs).toISOString();
  const rows = db.prepare(`
    SELECT id, recorded_at, lat, lon, accuracy_m
    FROM gps_locations
    WHERE user_id = ? AND recorded_at BETWEEN ? AND ?
    ORDER BY recorded_at
  `).all(userId, from, to) as NearestGpsResult[];
  if (rows.length === 0) return null;
  let best = rows[0];
  let bestDiff = Math.abs(new Date(best.recorded_at).getTime() - center.getTime());
  for (const r of rows.slice(1)) {
    const d = Math.abs(new Date(r.recorded_at).getTime() - center.getTime());
    if (d < bestDiff) {
      bestDiff = d;
      best = r;
    }
  }
  return best;
}

export interface InsertMealInput {
  photo_path: string;
  eaten_at: string;
  eaten_at_source?: MealRow['eaten_at_source'];
  lat?: number | null;
  lon?: number | null;
  location_label?: string | null;
  location_source?: string | null;
  description?: string | null;
  calories?: number | null;
  items_json?: string | null;
  ai_status?: MealRow['ai_status'];
  ai_error?: string | null;
  user_note?: string | null;
  user_corrected_description?: string | null;
  user_corrected_calories?: number | null;
}

export function insertMeal(db: Db, m: InsertMealInput): number {
  const info = db.prepare(`
    INSERT INTO meals (
      photo_path, eaten_at, eaten_at_source,
      lat, lon, location_label, location_source,
      description, calories, items_json,
      ai_status, ai_error, user_note,
      user_corrected_description, user_corrected_calories
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.photo_path, m.eaten_at, m.eaten_at_source ?? 'manual',
    m.lat ?? null, m.lon ?? null, m.location_label ?? null, m.location_source ?? null,
    m.description ?? null, m.calories ?? null, m.items_json ?? null,
    m.ai_status ?? 'pending', m.ai_error ?? null, m.user_note ?? null,
    m.user_corrected_description ?? null, m.user_corrected_calories ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function getMeal(db: Db, id: number): MealRow | undefined {
  return db.prepare(`SELECT * FROM meals WHERE id = ?`).get(id) as MealRow | undefined;
}

export interface ListMealsOptions {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function listMeals(db: Db, { from, to, limit = 100, offset = 0 }: ListMealsOptions = {}): MealRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (from) { where.push(`eaten_at >= ?`); args.push(from); }
  if (to)   { where.push(`eaten_at <= ?`); args.push(to);   }
  const sql = `
    SELECT * FROM meals
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY eaten_at DESC
    LIMIT ? OFFSET ?
  `;
  args.push(limit, offset);
  return db.prepare(sql).all(...args) as MealRow[];
}

export function countMeals(db: Db, { from, to }: { from?: string; to?: string } = {}): number {
  const where: string[] = [];
  const args: unknown[] = [];
  if (from) { where.push(`eaten_at >= ?`); args.push(from); }
  if (to)   { where.push(`eaten_at <= ?`); args.push(to);   }
  const sql = `SELECT COUNT(*) AS c FROM meals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const row = db.prepare(sql).get(...args) as { c: number };
  return row.c;
}

export function updateMeal(db: Db, id: number, patch: Record<string, unknown>): void {
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = ?`);
    args.push(v);
  }
  if (cols.length === 0) return;
  cols.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE meals SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteMeal(db: Db, id: number): void {
  db.prepare(`DELETE FROM meals WHERE id = ?`).run(id);
}

export function listPendingMeals(db: Db, { limit = 20 }: { limit?: number } = {}): MealRow[] {
  return db.prepare(`
    SELECT * FROM meals WHERE ai_status = 'pending'
    ORDER BY id ASC LIMIT ?
  `).all(limit) as MealRow[];
}

/** 指定日 (ローカル YYYY-MM-DD) の食事を eaten_at 昇順で返す。 */
export function listMealsForDate(db: Db, dateStr: string): MealRow[] {
  return db.prepare(`
    SELECT * FROM meals
    WHERE date(eaten_at, 'localtime') = ?
    ORDER BY eaten_at ASC
  `).all(dateStr) as MealRow[];
}

// ─── user stopwords (ユーザカスタムの語彙除外) ─────────────────
//
// dig graph / wordcloud などで「もう出さなくていい」 単語を蓄積する。
// 表示側 (app.js) で随時 filter するのと、 サーバ抽出側で除外するのと
// 両方で参照する想定 (今は表示側 filter のみで運用)。

// ---- implementation notes -------------------------------------------------

export interface ListImplementationNotesOptions {
  limit?: number;
  offset?: number;
  shareable?: boolean | 0 | 1 | null;
}

export function listImplementationNotes(db: Db, { limit = 100, offset = 0, shareable = null }: ListImplementationNotesOptions = {}): ImplementationNoteRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (shareable != null) {
    where.push('shareable = ?');
    args.push(shareable ? 1 : 0);
  }
  args.push(limit, offset);
  return db.prepare(`
    SELECT * FROM implementation_notes
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args) as ImplementationNoteRow[];
}

export function getImplementationNote(db: Db, id: number): ImplementationNoteRow | undefined {
  return db.prepare(`SELECT * FROM implementation_notes WHERE id = ?`).get(id) as ImplementationNoteRow | undefined;
}

export interface InsertImplementationNoteInput {
  product?: string | null;
  title: string;
  good_points?: string | null;
  bad_points?: string | null;
  attachment_type?: string | null;
  attachment_value?: string | null;
  shareable?: boolean | 0 | 1;
}

export function insertImplementationNote(db: Db, note: InsertImplementationNoteInput): number {
  const info = db.prepare(`
    INSERT INTO implementation_notes
      (product, title, good_points, bad_points, attachment_type, attachment_value, shareable)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    note.product ?? '',
    note.title,
    note.good_points ?? null,
    note.bad_points ?? null,
    note.attachment_type ?? null,
    note.attachment_value ?? null,
    note.shareable ? 1 : 0,
  );
  return Number(info.lastInsertRowid);
}

export function updateImplementationNote(db: Db, id: number, patch: Record<string, unknown>): void {
  const allowed = new Set([
    'product', 'title', 'good_points', 'bad_points',
    'attachment_type', 'attachment_value',
    'shareable', 'shared_at', 'shared_origin',
  ]);
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    cols.push(`${k} = ?`);
    args.push(k === 'shareable' ? (v ? 1 : 0) : v);
  }
  if (!cols.length) return;
  cols.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE implementation_notes SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteImplementationNote(db: Db, id: number): void {
  db.prepare(`DELETE FROM implementation_notes WHERE id = ?`).run(id);
}

// ---- agent projects + runs (AI 実装委託) ----------------------------------

export function listAgentProjects(db: Db): AgentProjectRow[] {
  return db.prepare(`SELECT * FROM agent_projects ORDER BY created_at ASC`).all() as AgentProjectRow[];
}

export function getAgentProject(db: Db, id: number): AgentProjectRow | undefined {
  return db.prepare(`SELECT * FROM agent_projects WHERE id = ?`).get(id) as AgentProjectRow | undefined;
}

export interface InsertAgentProjectInput {
  name: string;
  path: string;
  rules?: string | null;
  default_agent?: AgentProjectRow['default_agent'];
}

export function insertAgentProject(db: Db, p: InsertAgentProjectInput): number {
  const info = db.prepare(`
    INSERT INTO agent_projects (name, path, rules, default_agent)
    VALUES (?, ?, ?, ?)
  `).run(
    p.name,
    p.path,
    p.rules ?? null,
    p.default_agent || 'claude_code',
  );
  return Number(info.lastInsertRowid);
}

export function updateAgentProject(db: Db, id: number, patch: Record<string, unknown>): void {
  const allowed = new Set(['name', 'path', 'rules', 'default_agent']);
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    cols.push(`${k} = ?`);
    args.push(v);
  }
  if (!cols.length) return;
  cols.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE agent_projects SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteAgentProject(db: Db, id: number): void {
  db.prepare(`DELETE FROM agent_projects WHERE id = ?`).run(id);
}

export interface ListAgentRunsOptions {
  taskId?: number | null;
  projectId?: number | null;
  limit?: number;
  offset?: number;
}

export function listAgentRuns(db: Db, { taskId = null, projectId = null, limit = 100, offset = 0 }: ListAgentRunsOptions = {}): AgentRunRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (taskId != null) { where.push('task_id = ?'); args.push(Number(taskId)); }
  if (projectId != null) { where.push('project_id = ?'); args.push(Number(projectId)); }
  args.push(Number(limit) || 100, Number(offset) || 0);
  return db.prepare(`
    SELECT * FROM agent_runs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).all(...args) as AgentRunRow[];
}

export function getAgentRun(db: Db, id: number): AgentRunRow | undefined {
  return db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as AgentRunRow | undefined;
}

export interface InsertAgentRunInput {
  task_id?: number | null;
  project_id?: number | null;
  agent: AgentRunRow['agent'];
  model?: string | null;
  prompt?: string | null;
  status?: AgentRunRow['status'];
  log_path?: string | null;
  mode?: AgentRunRow['mode'];
}

export function insertAgentRun(db: Db, r: InsertAgentRunInput): number {
  const info = db.prepare(`
    INSERT INTO agent_runs (task_id, project_id, agent, model, prompt, status, log_path, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.task_id ?? null,
    r.project_id ?? null,
    r.agent,
    r.model ?? null,
    r.prompt ?? null,
    r.status || 'pending',
    r.log_path ?? null,
    r.mode ?? 'local',
  );
  return Number(info.lastInsertRowid);
}

export function updateAgentRun(db: Db, id: number, patch: Record<string, unknown>): void {
  const allowed = new Set(['status', 'exit_code', 'log_path', 'pid', 'summary', 'finished_at', 'model', 'concordia_session_id']);
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    cols.push(`${k} = ?`);
    args.push(v);
  }
  if (!cols.length) return;
  args.push(id);
  db.prepare(`UPDATE agent_runs SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

// ---- work locations -------------------------------------------------------

export function listWorkLocations(db: Db, { limit = 200, offset = 0 }: { limit?: number; offset?: number } = {}): WorkLocationRow[] {
  return db.prepare(`
    SELECT * FROM work_locations
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(Number(limit) || 200, Number(offset) || 0) as WorkLocationRow[];
}

export function getWorkLocation(db: Db, id: number): WorkLocationRow | undefined {
  return db.prepare(`SELECT * FROM work_locations WHERE id = ?`).get(id) as WorkLocationRow | undefined;
}

export interface InsertWorkLocationInput {
  name: string;
  address?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  description?: string | null;
  url?: string | null;
  tags?: string | null;
  /** カンマ区切り (例 'MyHomeWifi,MyHomeWifi-5G') */
  wifi_ssids?: string | null;
  /** 有線接続時のデフォルト workplace に使う */
  is_home?: boolean | 0 | 1;
  shareable?: boolean | 0 | 1;
  /** GPS 誤差許容半径 (m)。 null/undefined なら global default を使う */
  radius_m?: number | string | null;
}

export function insertWorkLocation(db: Db, loc: InsertWorkLocationInput): number {
  // is_home=true なら既存の home flag を全部 clear (= 1 つだけ true 制約をソフトに維持)
  if (loc.is_home) {
    db.prepare(`UPDATE work_locations SET is_home = 0 WHERE is_home = 1`).run();
  }
  const info = db.prepare(`
    INSERT INTO work_locations
      (name, address, latitude, longitude, description, url, tags, wifi_ssids, is_home, shareable, radius_m)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    loc.name,
    loc.address ?? null,
    loc.latitude == null ? null : Number(loc.latitude),
    loc.longitude == null ? null : Number(loc.longitude),
    loc.description ?? null,
    loc.url ?? null,
    loc.tags ?? null,
    loc.wifi_ssids ?? null,
    loc.is_home ? 1 : 0,
    loc.shareable ? 1 : 0,
    loc.radius_m == null ? null : Math.max(1, Math.min(50_000, Number(loc.radius_m) || 0)) || null,
  );
  return Number(info.lastInsertRowid);
}

export function updateWorkLocation(db: Db, id: number, patch: Record<string, unknown>): void {
  // is_home を true に変えるリクエストなら、 他の行の is_home を先に clear
  if (patch.is_home === true || patch.is_home === 1) {
    db.prepare(`UPDATE work_locations SET is_home = 0 WHERE is_home = 1 AND id != ?`).run(id);
  }
  const allowed = new Set([
    'name', 'address', 'latitude', 'longitude', 'description', 'url', 'tags',
    'wifi_ssids', 'is_home', 'radius_m',
    'shareable', 'shared_at', 'shared_origin',
    'owner_user_id', 'owner_user_name',
  ]);
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    cols.push(`${k} = ?`);
    if (k === 'shareable' || k === 'is_home') args.push(v ? 1 : 0);
    else if (k === 'latitude' || k === 'longitude') args.push(v == null ? null : Number(v));
    else args.push(v);
  }
  if (!cols.length) return;
  cols.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE work_locations SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteWorkLocation(db: Db, id: number): void {
  db.prepare(`DELETE FROM work_locations WHERE id = ?`).run(id);
}

export function setWorkLocationOwner(db: Db, id: number, { ownerUserId, ownerUserName, sharedAt, sharedOrigin }: OwnerInput): void {
  db.prepare(`
    UPDATE work_locations
       SET owner_user_id = ?, owner_user_name = ?, shared_at = ?, shared_origin = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(ownerUserId ?? null, ownerUserName ?? null, sharedAt ?? null, sharedOrigin ?? null, id);
}

// ---- tasks ----------------------------------------------------------------

export interface ListTasksOptions {
  status?: TaskRow['status'] | null;
  /**
   * - 'task' | 'goal' : その kind だけ返す
   * - 'all'           : 両方
   * - null (既定)      : 'task' (= 通常タスク一覧、 目標は別 query で取る前提)
   */
  kind?: TaskRow['kind'] | 'all' | null;
  limit?: number;
  offset?: number;
}

export function listTasks(db: Db, { status = null, kind = null, limit = 100, offset = 0 }: ListTasksOptions = {}): TaskRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  if (kind === null) {
    where.push(`kind = 'task'`);
  } else if (kind !== 'all') {
    where.push('kind = ?');
    args.push(kind);
  }
  args.push(limit, offset);
  return db.prepare(`
    SELECT * FROM tasks
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
      COALESCE(due_at, '9999-12-31') ASC,
      created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args) as TaskRow[];
}

export function getTask(db: Db, id: number): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

export interface InsertTaskInput {
  title: string;
  details?: string | null;
  status?: TaskRow['status'];
  kind?: TaskRow['kind'];
  creator_type?: TaskRow['creator_type'];
  due_at?: string | null;
  share_actio?: boolean | 0 | 1;
  category?: string | null;
}

export function insertTask(db: Db, task: InsertTaskInput): number {
  const info = db.prepare(`
    INSERT INTO tasks (title, details, status, kind, creator_type, due_at, share_actio, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.title,
    task.details ?? null,
    task.status || 'todo',
    task.kind === 'goal' ? 'goal' : 'task',
    task.creator_type === 'ai' ? 'ai' : 'human',
    task.due_at ?? null,
    task.share_actio ? 1 : 0,
    task.category ?? null,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Distinct categories from tasks + manually registered ones (stored in
 * app_settings as JSON `task.categories.registered`). Merged + deduped +
 * sorted ascending. Manually-registered ones can have 0 tasks attached
 * (they show up in the side menu so users can pre-create categories).
 *
 * 1 タスクは複数カテゴリを持てる。 `tasks.category` カラムには **カンマ区切り**
 * で保存する (`"開発, 学習"` のように)。 ここでは split + flatten + 重複排除する。
 */
export function listTaskCategories(db: Db): string[] {
  const rows = db.prepare(`
    SELECT category
    FROM tasks
    WHERE category IS NOT NULL AND category != ''
      AND status IN ('todo', 'doing')
  `).all() as { category: string | null }[];
  const fromTasks = new Set<string>();
  for (const row of rows) {
    for (const c of String(row.category || '').split(',')) {
      const t = c.trim();
      if (t) fromTasks.add(t);
    }
  }
  let registered: string[] = [];
  try {
    const raw = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get('task.categories.registered') as { value: string | null } | undefined;
    if (raw?.value) registered = (JSON.parse(raw.value) as string[]) || [];
  } catch { /* ignore */ }
  const all = new Set<string>([...fromTasks]);
  for (const c of registered) if (c) all.add(c);
  return [...all].sort((a, b) => a.localeCompare(b));
}

export function registerTaskCategory(db: Db, name: string): void {
  const n = String(name || '').trim();
  if (!n) return;
  let registered: string[] = [];
  try {
    const raw = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get('task.categories.registered') as { value: string | null } | undefined;
    if (raw?.value) registered = (JSON.parse(raw.value) as string[]) || [];
  } catch { /* ignore */ }
  if (!registered.includes(n)) {
    registered.push(n);
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('task.categories.registered', JSON.stringify(registered));
  }
}

export function unregisterTaskCategory(db: Db, name: string): void {
  const n = String(name || '').trim();
  if (!n) return;
  let registered: string[] = [];
  try {
    const raw = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get('task.categories.registered') as { value: string | null } | undefined;
    if (raw?.value) registered = (JSON.parse(raw.value) as string[]) || [];
  } catch { /* ignore */ }
  const next = registered.filter(c => c !== n);
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run('task.categories.registered', JSON.stringify(next));
}

export function updateTask(db: Db, id: number, patch: Record<string, unknown>): void {
  const allowed = new Set(['title', 'details', 'status', 'kind', 'creator_type', 'due_at', 'share_actio', 'shared_at', 'shared_origin', 'category']);
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    cols.push(`${k} = ?`);
    args.push(k === 'share_actio' ? (v ? 1 : 0) : v);
  }
  if (!cols.length) return;
  cols.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteTask(db: Db, id: number): void {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

// ---- external chat messages ----------------------------------------------

export interface InsertExternalChatMessageInput {
  source: string;
  conversation_id?: string | null;
  role?: string | null;
  content: string;
  metadata?: unknown;
}

export function insertExternalChatMessage(db: Db, msg: InsertExternalChatMessageInput): number {
  const info = db.prepare(`
    INSERT INTO external_chat_messages (source, conversation_id, role, content, metadata_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    msg.source,
    msg.conversation_id ?? null,
    msg.role ?? null,
    msg.content,
    msg.metadata ? JSON.stringify(msg.metadata) : null,
  );
  return Number(info.lastInsertRowid);
}

export interface ListExternalChatMessagesOptions {
  source?: string | null;
  limit?: number;
  offset?: number;
}

export function listExternalChatMessages(db: Db, { source = null, limit = 100, offset = 0 }: ListExternalChatMessagesOptions = {}): ExternalChatMessageRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (source) {
    where.push('source = ?');
    args.push(source);
  }
  args.push(limit, offset);
  return db.prepare(`
    SELECT * FROM external_chat_messages
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY received_at DESC
    LIMIT ? OFFSET ?
  `).all(...args) as ExternalChatMessageRow[];
}

export function ensureUserStopwordsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_stopwords (
      word        TEXT PRIMARY KEY,
      lower       TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_stopwords_lower ON user_stopwords(lower);
  `);
}

export interface UserStopwordWithLower extends UserStopwordRow {
  lower: string;
  word: string;
}

export function listUserStopwords(db: Db): UserStopwordWithLower[] {
  return db.prepare(`SELECT word, lower, created_at FROM user_stopwords ORDER BY created_at DESC`).all() as UserStopwordWithLower[];
}

export function addUserStopword(db: Db, word: string): boolean {
  const w = String(word ?? '').trim();
  if (!w) return false;
  db.prepare(`INSERT OR IGNORE INTO user_stopwords (word, lower) VALUES (?, ?)`).run(w, w.toLowerCase());
  return true;
}

export function removeUserStopword(db: Db, word: string): boolean {
  const w = String(word ?? '').trim();
  if (!w) return false;
  const info = db.prepare(`DELETE FROM user_stopwords WHERE lower = ?`).run(w.toLowerCase());
  return info.changes > 0;
}

// ─── notes (markdown ライク WYSIWYG ノート) ─────────────────────────────────
//
// 1 ノート = ヘッダ (notes 行) + N 個のブロック (note_blocks 行)。 並び順は
// position (REAL) で安定ソート。 挿入時は隣接 2 ブロックの平均値を取る方針なので
// 全体 reindex は reorder API のみで発生する。

export interface ListNotesOptions {
  q?: string;
  kind?: NoteKind | null;
  bookmarkId?: number | null;
  limit?: number;
  offset?: number;
}

export interface NoteListRow extends NoteRow {
  block_count: number;
  preview: string;
}

function normalizeNoteText(text: string | undefined): string {
  return (text ?? '').replace(/\r\n|\r/g, '\n');
}

export function listNotes(db: Db, opts: ListNotesOptions = {}): { items: NoteListRow[]; total: number } {
  const { q = '', kind = null, bookmarkId = null, limit = 50, offset = 0 } = opts;
  const where: string[] = [];
  const args: unknown[] = [];
  if (kind) { where.push('n.kind = ?'); args.push(kind); }
  if (bookmarkId != null) { where.push('n.bookmark_id = ?'); args.push(bookmarkId); }
  if (q.trim()) {
    where.push('(n.title LIKE ? OR n.tags_json LIKE ? OR EXISTS (SELECT 1 FROM note_blocks b WHERE b.note_id = n.id AND b.text LIKE ?))');
    const like = `%${q.trim()}%`;
    args.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM notes n ${whereSql}`).get(...args) as { c: number }).c;
  args.push(limit, offset);
  const items = db.prepare(`
    SELECT n.*,
           (SELECT COUNT(*) FROM note_blocks b WHERE b.note_id = n.id) AS block_count,
           COALESCE((
             SELECT b.text FROM note_blocks b
              WHERE b.note_id = n.id AND b.block_type IN ('text','heading_1','heading_2','heading_3','quote')
              ORDER BY b.position ASC LIMIT 1
           ), '') AS preview
    FROM notes n
    ${whereSql}
    ORDER BY n.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...args) as NoteListRow[];
  return { items, total };
}

export function getNote(db: Db, id: string): NoteRow | undefined {
  return db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as NoteRow | undefined;
}

export function findNoteByBookmarkId(db: Db, bookmarkId: number): NoteRow | undefined {
  return db.prepare(`SELECT * FROM notes WHERE bookmark_id = ? ORDER BY created_at ASC LIMIT 1`).get(bookmarkId) as NoteRow | undefined;
}

export function listNoteBlocks(db: Db, noteId: string): NoteBlockRow[] {
  return db.prepare(`
    SELECT * FROM note_blocks
    WHERE note_id = ?
    ORDER BY position ASC, id ASC
  `).all(noteId) as NoteBlockRow[];
}

export interface InsertNoteInput {
  id?: string;                  // 既存 UUID を引き継ぐ場合 (Hub からの download)。 省略時は新規生成
  title?: string;
  kind?: NoteKind;
  tags?: string[] | null;
  bookmark_id?: number | null;
  bookmark_url?: string | null;
  source_kind?: string | null;
  source_ref?: string | null;
}

export function insertNote(db: Db, input: InsertNoteInput): string {
  const id = input.id || randomUUID();
  const tagsJson = input.tags && input.tags.length ? JSON.stringify(input.tags) : null;
  db.prepare(`
    INSERT INTO notes (id, title, kind, tags_json, bookmark_id, bookmark_url, source_kind, source_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.title ?? '',
    input.kind ?? 'doc',
    tagsJson,
    input.bookmark_id ?? null,
    input.bookmark_url ?? null,
    input.source_kind ?? null,
    input.source_ref ?? null,
  );
  return id;
}

export function updateNote(db: Db, id: string, patch: Record<string, unknown>): void {
  const allowed = new Set([
    'title', 'kind', 'tags', 'bookmark_id', 'bookmark_url', 'source_kind', 'source_ref',
  ]);
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    if (k === 'tags') {
      cols.push('tags_json = ?');
      args.push(Array.isArray(v) && v.length ? JSON.stringify(v) : null);
    } else {
      cols.push(`${k} = ?`);
      args.push(v);
    }
  }
  if (!cols.length) return;
  cols.push(`updated_at = datetime('now')`);
  args.push(id);
  db.prepare(`UPDATE notes SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}

export function bumpNoteUpdated(db: Db, id: string): void {
  db.prepare(`UPDATE notes SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

export function deleteNote(db: Db, id: string): void {
  db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
}

/** bookmark 削除時に紐付き note の bookmark_id を NULL に切る (URL は保持)。 */
export function unlinkBookmarkFromNotes(db: Db, bookmarkId: number): void {
  db.prepare(`UPDATE notes SET bookmark_id = NULL, updated_at = datetime('now') WHERE bookmark_id = ?`).run(bookmarkId);
}

function isValidBlockType(t: string): t is NoteBlockType {
  return (NOTE_BLOCK_TYPES as readonly string[]).includes(t);
}

export interface InsertBlockInput {
  block_type: NoteBlockType;
  text?: string;
  data?: Record<string, unknown> | null;
  position?: number;
  after_block_uuid?: string | null;
  uuid?: string;                // Hub download 時に既存 UUID を引き継ぐ
}

export function insertBlock(db: Db, noteId: string, input: InsertBlockInput): NoteBlockRow {
  if (!isValidBlockType(input.block_type)) {
    throw new Error(`invalid block_type: ${input.block_type}`);
  }
  let position = input.position;
  if (position == null) {
    if (input.after_block_uuid) {
      const cur = db.prepare(`SELECT position FROM note_blocks WHERE uuid = ? AND note_id = ?`).get(input.after_block_uuid, noteId) as { position: number } | undefined;
      if (cur) {
        const next = db.prepare(`
          SELECT position FROM note_blocks
          WHERE note_id = ? AND position > ?
          ORDER BY position ASC LIMIT 1
        `).get(noteId, cur.position) as { position: number } | undefined;
        position = next ? (cur.position + next.position) / 2 : cur.position + 1;
      }
    }
    if (position == null) {
      const maxRow = db.prepare(`SELECT COALESCE(MAX(position), 0) AS p FROM note_blocks WHERE note_id = ?`).get(noteId) as { p: number };
      position = maxRow.p + 1;
    }
  }
  const dataJson = input.data ? JSON.stringify(input.data) : null;
  const uuid = input.uuid || randomUUID();
  const info = db.prepare(`
    INSERT INTO note_blocks (uuid, note_id, position, block_type, text, data_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid, noteId, position, input.block_type, normalizeNoteText(input.text), dataJson);
  bumpNoteUpdated(db, noteId);
  const id = Number(info.lastInsertRowid);
  return db.prepare(`SELECT * FROM note_blocks WHERE id = ?`).get(id) as NoteBlockRow;
}

export function getBlockByUuid(db: Db, noteId: string, blockUuid: string): NoteBlockRow | undefined {
  return db.prepare(`SELECT * FROM note_blocks WHERE uuid = ? AND note_id = ?`).get(blockUuid, noteId) as NoteBlockRow | undefined;
}

export function updateBlock(db: Db, noteId: string, blockUuid: string, patch: Record<string, unknown>): NoteBlockRow | null {
  const cols: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.block_type === 'string') {
    if (!isValidBlockType(patch.block_type)) throw new Error(`invalid block_type: ${patch.block_type}`);
    cols.push('block_type = ?'); args.push(patch.block_type);
  }
  if (typeof patch.text === 'string') {
    cols.push('text = ?'); args.push(normalizeNoteText(patch.text));
  }
  if ('data' in patch) {
    cols.push('data_json = ?');
    args.push(patch.data == null ? null : JSON.stringify(patch.data));
  }
  if (!cols.length) return getBlockByUuid(db, noteId, blockUuid) ?? null;
  cols.push(`updated_at = datetime('now')`);
  args.push(blockUuid, noteId);
  const info = db.prepare(`UPDATE note_blocks SET ${cols.join(', ')} WHERE uuid = ? AND note_id = ?`).run(...args);
  if (info.changes === 0) return null;
  bumpNoteUpdated(db, noteId);
  return getBlockByUuid(db, noteId, blockUuid) ?? null;
}

export function deleteBlock(db: Db, noteId: string, blockUuid: string): boolean {
  const info = db.prepare(`DELETE FROM note_blocks WHERE uuid = ? AND note_id = ?`).run(blockUuid, noteId);
  if (info.changes > 0) bumpNoteUpdated(db, noteId);
  return info.changes > 0;
}

export function reorderBlocks(db: Db, noteId: string, order: string[]): NoteBlockRow[] {
  const existing = db.prepare(`SELECT uuid FROM note_blocks WHERE note_id = ?`).all(noteId) as { uuid: string }[];
  const existingSet = new Set(existing.map((r) => r.uuid));
  if (order.length !== existing.length || order.some((u) => !existingSet.has(u))) {
    throw new Error('reorder must include exactly all blocks of the note');
  }
  const stmt = db.prepare(`UPDATE note_blocks SET position = ?, updated_at = datetime('now') WHERE uuid = ? AND note_id = ?`);
  const tx = db.transaction((uuids: string[]) => {
    uuids.forEach((uuid, idx) => stmt.run(idx + 1, uuid, noteId));
  });
  tx(order);
  bumpNoteUpdated(db, noteId);
  return listNoteBlocks(db, noteId);
}

// ─── note_comment_sets / note_comments ──────────────────────────────────────

export interface InsertCommentSetInput {
  id?: string;
  owner_user_id?: string | null;
  owner_user_name?: string | null;
}

/** idempotent: 既存 set があればそれを返す。 */
export function getOrCreateCommentSet(db: Db, noteId: string, input: InsertCommentSetInput = {}): NoteCommentSetRow {
  const ownerId = input.owner_user_id ?? null;
  const existing = db.prepare(`
    SELECT * FROM note_comment_sets
    WHERE note_id = ? AND (owner_user_id IS ? OR owner_user_id = ?)
    LIMIT 1
  `).get(noteId, ownerId, ownerId) as NoteCommentSetRow | undefined;
  if (existing) return existing;
  const id = input.id || randomUUID();
  db.prepare(`
    INSERT INTO note_comment_sets (id, note_id, owner_user_id, owner_user_name)
    VALUES (?, ?, ?, ?)
  `).run(id, noteId, ownerId, input.owner_user_name ?? null);
  return db.prepare(`SELECT * FROM note_comment_sets WHERE id = ?`).get(id) as NoteCommentSetRow;
}

export interface ListCommentSetsOptions {
  ownerUserId?: string | null;     // null = ローカル自分の set のみ。 undefined = 全 set
}

export function listCommentSets(db: Db, noteId: string, opts: ListCommentSetsOptions = {}): NoteCommentSetRow[] {
  if (opts.ownerUserId === undefined) {
    return db.prepare(`
      SELECT * FROM note_comment_sets WHERE note_id = ?
      ORDER BY created_at ASC
    `).all(noteId) as NoteCommentSetRow[];
  }
  const v = opts.ownerUserId;
  return db.prepare(`
    SELECT * FROM note_comment_sets
    WHERE note_id = ? AND (owner_user_id IS ? OR owner_user_id = ?)
    ORDER BY created_at ASC
  `).all(noteId, v, v) as NoteCommentSetRow[];
}

export function getCommentSet(db: Db, setId: string): NoteCommentSetRow | undefined {
  return db.prepare(`SELECT * FROM note_comment_sets WHERE id = ?`).get(setId) as NoteCommentSetRow | undefined;
}

export function deleteCommentSet(db: Db, setId: string): boolean {
  const info = db.prepare(`DELETE FROM note_comment_sets WHERE id = ?`).run(setId);
  return info.changes > 0;
}

export function listComments(db: Db, setId: string): NoteCommentRow[] {
  return db.prepare(`
    SELECT * FROM note_comments WHERE set_id = ?
    ORDER BY position ASC, created_at ASC
  `).all(setId) as NoteCommentRow[];
}

export interface InsertCommentInput {
  id?: string;
  text: string;
  target_block_uuid?: string | null;
  data?: Record<string, unknown> | null;
  position?: number;
}

export function insertComment(db: Db, setId: string, input: InsertCommentInput): NoteCommentRow {
  let position = input.position;
  if (position == null) {
    const maxRow = db.prepare(`SELECT COALESCE(MAX(position), 0) AS p FROM note_comments WHERE set_id = ?`).get(setId) as { p: number };
    position = maxRow.p + 1;
  }
  const id = input.id || randomUUID();
  const dataJson = input.data ? JSON.stringify(input.data) : null;
  db.prepare(`
    INSERT INTO note_comments (id, set_id, target_block_uuid, position, text, data_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, setId, input.target_block_uuid ?? null, position, input.text ?? '', dataJson);
  // bump set updated_at
  db.prepare(`UPDATE note_comment_sets SET updated_at = datetime('now') WHERE id = ?`).run(setId);
  return db.prepare(`SELECT * FROM note_comments WHERE id = ?`).get(id) as NoteCommentRow;
}

export function updateComment(db: Db, setId: string, commentId: string, patch: Record<string, unknown>): NoteCommentRow | null {
  const cols: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.text === 'string') { cols.push('text = ?'); args.push(patch.text); }
  if ('target_block_uuid' in patch) {
    cols.push('target_block_uuid = ?');
    const v = patch.target_block_uuid;
    args.push(typeof v === 'string' ? v : null);
  }
  if ('data' in patch) {
    cols.push('data_json = ?');
    args.push(patch.data == null ? null : JSON.stringify(patch.data));
  }
  if (!cols.length) return db.prepare(`SELECT * FROM note_comments WHERE id = ? AND set_id = ?`).get(commentId, setId) as NoteCommentRow | null;
  cols.push(`updated_at = datetime('now')`);
  args.push(commentId, setId);
  const info = db.prepare(`UPDATE note_comments SET ${cols.join(', ')} WHERE id = ? AND set_id = ?`).run(...args);
  if (info.changes === 0) return null;
  db.prepare(`UPDATE note_comment_sets SET updated_at = datetime('now') WHERE id = ?`).run(setId);
  return db.prepare(`SELECT * FROM note_comments WHERE id = ?`).get(commentId) as NoteCommentRow;
}

export function deleteComment(db: Db, setId: string, commentId: string): boolean {
  const info = db.prepare(`DELETE FROM note_comments WHERE id = ? AND set_id = ?`).run(commentId, setId);
  if (info.changes > 0) {
    db.prepare(`UPDATE note_comment_sets SET updated_at = datetime('now') WHERE id = ?`).run(setId);
  }
  return info.changes > 0;
}

// ─── extension dispatch rules (chat / impl / shopping ボタン設定) ─────────────
//
// app_settings の 1 キー (`extension_rules_json`) に JSON で集約して保持。
// デフォルトはサーバ起動時にこのキーが空なら埋める。

export interface ExtensionChatDomain {
  host: string;
  source: 'chatgpt' | 'claude' | 'gemini';
  enabled: boolean;
}

export interface ExtensionImplRule {
  label: string;
  host_pattern: string;
  keywords: string[];
  enabled: boolean;
}

export interface ExtensionShoppingDomain {
  host: string;
  label: string;
  enabled: boolean;
}

export interface ExtensionNotionDomain {
  host: string;
  enabled: boolean;
}

export interface ExtensionRules {
  chat_domains: ExtensionChatDomain[];
  impl_rules: ExtensionImplRule[];
  shopping_domains: ExtensionShoppingDomain[];
  notion_domains: ExtensionNotionDomain[];
}

const DEFAULT_EXTENSION_RULES: ExtensionRules = {
  chat_domains: [
    { host: 'chatgpt.com', source: 'chatgpt', enabled: true },
    { host: 'chat.openai.com', source: 'chatgpt', enabled: true },
    { host: 'claude.ai', source: 'claude', enabled: true },
    { host: 'gemini.google.com', source: 'gemini', enabled: true },
  ],
  impl_rules: [
    { label: 'LUDIARS GitHub', host_pattern: 'github.com', keywords: ['LUDIARS'], enabled: true },
  ],
  shopping_domains: [
    { host: 'amazon.co.jp', label: 'Amazon (JP)', enabled: true },
    { host: 'amazon.com', label: 'Amazon (US)', enabled: true },
    { host: 'rakuten.co.jp', label: '楽天市場', enabled: true },
  ],
  notion_domains: [
    { host: 'notion.so', enabled: true },
    { host: 'www.notion.so', enabled: true },
    { host: 'notion.site', enabled: true },
  ],
};

export function getExtensionRules(db: Db): ExtensionRules {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('extension_rules_json') as { value: string } | undefined;
  if (!row?.value) {
    setExtensionRules(db, DEFAULT_EXTENSION_RULES);
    return DEFAULT_EXTENSION_RULES;
  }
  try {
    const parsed = JSON.parse(row.value) as Partial<ExtensionRules>;
    return {
      chat_domains: parsed.chat_domains ?? DEFAULT_EXTENSION_RULES.chat_domains,
      impl_rules: parsed.impl_rules ?? DEFAULT_EXTENSION_RULES.impl_rules,
      shopping_domains: parsed.shopping_domains ?? DEFAULT_EXTENSION_RULES.shopping_domains,
      notion_domains: parsed.notion_domains ?? DEFAULT_EXTENSION_RULES.notion_domains,
    };
  } catch {
    return DEFAULT_EXTENSION_RULES;
  }
}

export function setExtensionRules(db: Db, rules: ExtensionRules): void {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('extension_rules_json', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(rules));
}

// ── recommendation_runs (AI 主導おすすめ) ─────────────────────────────────────

export interface RecommendationRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: 'pending' | 'running' | 'done' | 'error';
  error: string | null;
  agent_logs_json: string | null;
  results_json: string | null;
  model_sonnet: string | null;
  model_opus: string | null;
  duration_ms: number | null;
  result_count: number | null;
}

export function insertRecommendationRun(db: Db): number {
  const res = db.prepare(`
    INSERT INTO recommendation_runs (status) VALUES ('running')
  `).run();
  return Number(res.lastInsertRowid);
}

export function failRecommendationRun(db: Db, id: number, error: string): void {
  // WHERE status='running' を付けて、 既に cancel/done に遷移済の row を
  // 上書きしないようにする (= 「キューを上書き」 した abandoned run が後から
  // 完了しても、 現在の状態を破壊しない)。
  db.prepare(`
    UPDATE recommendation_runs
       SET status = 'error',
           error = ?,
           finished_at = datetime('now'),
           duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = ? AND status = 'running'
  `).run(error.slice(0, 4000), id);
}

// 'running' のまま放置されている run を 'cancelled' に変更し、 件数を返す。
// サーバが死んだまま再起動した / inFlight promise が hang した、 等で
// 詰まったキューを掃除するために使う。
export function cancelRunningRecommendationRuns(db: Db, reason = 'user_cancelled'): number {
  const r = db.prepare(`
    UPDATE recommendation_runs
       SET status = 'cancelled',
           error = ?,
           finished_at = datetime('now'),
           duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE status = 'running'
  `).run(reason.slice(0, 4000));
  return r.changes;
}

export function completeRecommendationRun(
  db: Db,
  id: number,
  payload: {
    agentLogs: unknown;
    results: unknown[];
    modelSonnet: string;
    modelOpus: string;
  },
): void {
  // WHERE status='running' で、 cancel/done 済の row を上書きしない。
  // (force 実行で abandon された旧 run が遅れて終わっても無視する)
  db.prepare(`
    UPDATE recommendation_runs
       SET status = 'done',
           finished_at = datetime('now'),
           agent_logs_json = ?,
           results_json = ?,
           model_sonnet = ?,
           model_opus = ?,
           result_count = ?,
           duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = ? AND status = 'running'
  `).run(
    JSON.stringify(payload.agentLogs),
    JSON.stringify(payload.results),
    payload.modelSonnet,
    payload.modelOpus,
    payload.results.length,
    id,
  );
}

export function getRecommendationRun(db: Db, id: number): RecommendationRunRow | null {
  const row = db.prepare(`SELECT * FROM recommendation_runs WHERE id = ?`).get(id) as RecommendationRunRow | undefined;
  return row ?? null;
}

export function getLatestRecommendationRun(db: Db, status: 'done' | 'any' = 'done'): RecommendationRunRow | null {
  const where = status === 'done' ? `WHERE status = 'done'` : '';
  const row = db.prepare(`
    SELECT * FROM recommendation_runs
    ${where}
    ORDER BY started_at DESC
    LIMIT 1
  `).get() as RecommendationRunRow | undefined;
  return row ?? null;
}

export function listRecommendationRuns(db: Db, limit = 30): RecommendationRunRow[] {
  return db.prepare(`
    SELECT id, started_at, finished_at, status, error, model_sonnet, model_opus, duration_ms, result_count
    FROM recommendation_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(Number(limit) || 30) as RecommendationRunRow[];
}

export function findRunningRecommendationRun(db: Db): RecommendationRunRow | null {
  const row = db.prepare(`
    SELECT * FROM recommendation_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1
  `).get() as RecommendationRunRow | undefined;
  return row ?? null;
}

// ── recommendation 入力データ集計 (直近 N 日) ────────────────────────────────
//
// 6 agent に渡すための各領域 1 週間サマリ。 LLM への入力サイズが現実的になる
// よう、 各 agent 用に top-N で truncate する。

export interface RecSourceBookmark {
  id: number;
  url: string;
  title: string;
  summary: string | null;
  memo: string;
  created_at: string;
  categories: string[];
}

export function recRecentBookmarks(db: Db, sinceDays = 7, limit = 50): RecSourceBookmark[] {
  const rows = db.prepare(`
    SELECT id, url, title, summary, memo, created_at
    FROM bookmarks
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(`-${sinceDays} days`, limit) as Array<Omit<RecSourceBookmark, 'categories'>>;
  const ids = rows.map(r => r.id);
  if (ids.length === 0) return [];
  const cats = db.prepare(`
    SELECT bookmark_id, category FROM bookmark_categories
    WHERE bookmark_id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as { bookmark_id: number; category: string }[];
  const byId = new Map<number, string[]>();
  for (const c of cats) {
    let arr = byId.get(c.bookmark_id);
    if (!arr) { arr = []; byId.set(c.bookmark_id, arr); }
    arr.push(c.category);
  }
  return rows.map(r => ({ ...r, categories: byId.get(r.id) ?? [] }));
}

export interface RecBrowserDomain {
  domain: string;
  visits: number;
  last_seen_at: string;
  sample_titles: string[];
}

export function recBrowserHistory(db: Db, sinceDays = 7, topDomains = 30): RecBrowserDomain[] {
  // domain × visit_events 集計 + 各 domain の代表 title を 3 件まで
  const rows = db.prepare(`
    SELECT domain, COUNT(*) AS visits, MAX(visited_at) AS last_seen_at
    FROM visit_events
    WHERE visited_at >= datetime('now', ?)
      AND domain IS NOT NULL AND domain <> ''
    GROUP BY domain
    ORDER BY visits DESC
    LIMIT ?
  `).all(`-${sinceDays} days`, topDomains) as { domain: string; visits: number; last_seen_at: string }[];
  if (rows.length === 0) return [];
  const titleStmt = db.prepare(`
    SELECT DISTINCT title FROM visit_events
    WHERE domain = ? AND visited_at >= datetime('now', ?) AND title IS NOT NULL AND title <> ''
    ORDER BY visited_at DESC
    LIMIT 3
  `);
  return rows.map(r => ({
    domain: r.domain,
    visits: r.visits,
    last_seen_at: r.last_seen_at,
    sample_titles: (titleStmt.all(r.domain, `-${sinceDays} days`) as { title: string }[]).map(t => t.title),
  }));
}

export interface RecGitCommit {
  occurred_at: string;
  source: string | null;     // repo name
  content: string;           // commit message (1 行目)
  metadata: Record<string, unknown> | null;
}

export function recGitCommits(db: Db, sinceDays = 7, limit = 80): RecGitCommit[] {
  const rows = db.prepare(`
    SELECT occurred_at, source, content, metadata_json
    FROM activity_events
    WHERE kind = 'git_commit' AND occurred_at >= datetime('now', ?)
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(`-${sinceDays} days`, limit) as { occurred_at: string; source: string | null; content: string; metadata_json: string | null }[];
  return rows.map(r => ({
    occurred_at: r.occurred_at,
    source: r.source,
    content: r.content,
    metadata: r.metadata_json ? safeParse(r.metadata_json) as Record<string, unknown> : null,
  }));
}

export interface RecClaudePrompt {
  occurred_at: string;
  source: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
}

export function recClaudePrompts(db: Db, sinceDays = 7, limit = 80): RecClaudePrompt[] {
  const rows = db.prepare(`
    SELECT occurred_at, source, content, metadata_json
    FROM activity_events
    WHERE kind = 'claude_code_prompt' AND occurred_at >= datetime('now', ?)
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(`-${sinceDays} days`, limit) as { occurred_at: string; source: string | null; content: string; metadata_json: string | null }[];
  return rows.map(r => ({
    occurred_at: r.occurred_at,
    source: r.source,
    content: r.content,
    metadata: r.metadata_json ? safeParse(r.metadata_json) as Record<string, unknown> : null,
  }));
}

export interface RecGameSummary {
  appid: number;
  name: string;
  minutes_7d: number;
  last_played_at: string;
}

export function recGamesLastWeek(db: Db, sinceDays = 7, limit = 20): RecGameSummary[] {
  const rows = db.prepare(`
    SELECT appid, name,
           MAX(playtime_2weeks_min) - MIN(playtime_2weeks_min) AS minutes_7d,
           MAX(sampled_at) AS last_played_at
    FROM steam_activity
    WHERE sampled_at >= datetime('now', ?)
    GROUP BY appid, name
    HAVING minutes_7d > 0
    ORDER BY minutes_7d DESC
    LIMIT ?
  `).all(`-${sinceDays} days`, limit) as RecGameSummary[];
  return rows;
}

export interface RecAppSummary {
  process_name: string;
  app_name: string | null;
  kind: string | null;
  minutes_7d: number;
  sample_titles: string[];
}

export function recAppsLastWeek(db: Db, sinceDays = 7, limit = 30): RecAppSummary[] {
  // app_samples は 30s 周期で 1 行 = sample_interval_sec 秒なので合算
  const rows = db.prepare(`
    SELECT s.process_name,
           a.name AS app_name,
           a.kind AS kind,
           SUM(s.sample_interval_sec) / 60.0 AS minutes_7d
    FROM app_samples s
    LEFT JOIN applications a ON a.process_name = s.process_name
    WHERE s.sampled_at >= datetime('now', ?)
    GROUP BY s.process_name
    HAVING minutes_7d >= 5
    ORDER BY minutes_7d DESC
    LIMIT ?
  `).all(`-${sinceDays} days`, limit) as { process_name: string; app_name: string | null; kind: string | null; minutes_7d: number }[];
  if (rows.length === 0) return [];
  const titleStmt = db.prepare(`
    SELECT DISTINCT window_title FROM app_samples
    WHERE process_name = ? AND sampled_at >= datetime('now', ?) AND window_title IS NOT NULL AND window_title <> ''
    ORDER BY sampled_at DESC
    LIMIT 5
  `);
  return rows.map(r => ({
    process_name: r.process_name,
    app_name: r.app_name,
    kind: r.kind,
    minutes_7d: Math.round(r.minutes_7d),
    sample_titles: (titleStmt.all(r.process_name, `-${sinceDays} days`) as { window_title: string }[]).map(t => t.window_title),
  }));
}

export interface RecNoteSummary {
  id: string;
  title: string;
  kind: string;
  updated_at: string;
  preview: string;
}

export function recRecentNotes(db: Db, sinceDays = 7, limit = 30): RecNoteSummary[] {
  const notes = db.prepare(`
    SELECT id, title, kind, updated_at
    FROM notes
    WHERE updated_at >= datetime('now', ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(`-${sinceDays} days`, limit) as { id: string; title: string; kind: string; updated_at: string }[];
  if (notes.length === 0) return [];
  const blockStmt = db.prepare(`
    SELECT text FROM note_blocks
    WHERE note_id = ?
    ORDER BY position
    LIMIT 6
  `);
  return notes.map(n => {
    const blocks = blockStmt.all(n.id) as { text: string }[];
    const preview = blocks.map(b => (b.text || '').trim()).filter(Boolean).join('\n').slice(0, 600);
    return { id: n.id, title: n.title, kind: n.kind, updated_at: n.updated_at, preview };
  });
}

export interface RecDigSummary {
  id: number;
  query: string;
  created_at: string;
  status: string;
  result_preview: string;
}

export function recRecentDigs(db: Db, sinceDays = 7, limit = 25): RecDigSummary[] {
  const rows = db.prepare(`
    SELECT id, query, created_at, status, result_json
    FROM dig_sessions
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(`-${sinceDays} days`, limit) as { id: number; query: string; created_at: string; status: string; result_json: string | null }[];
  return rows.map(r => ({
    id: r.id,
    query: r.query,
    created_at: r.created_at,
    status: r.status,
    result_preview: r.result_json ? String(r.result_json).slice(0, 400) : '',
  }));
}
