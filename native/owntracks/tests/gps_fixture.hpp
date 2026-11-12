#pragma once
//テスト用の gps_locations。server/db.ts の openDb が作る DDL (CREATE TABLE と索引、後から ALTER で
//足した列を作った後の索引) をそのまま写した。Node サーバの openDb が作った DB と同じ形であることは
//native/README.md の「TS 版との突き合わせ」で sqlite_master を比べて確かめた
#include <string>

#include <lapilli/sqlite.hpp>

namespace testing {

inline const char* gps_locations_ddl() {
	return R"(
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
    CREATE INDEX IF NOT EXISTS idx_gps_locations_at
      ON gps_locations(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gps_locations_user_at
      ON gps_locations(user_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gps_locations_dedup
      ON gps_locations(user_id, device_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_gps_locations_unresolved
           ON gps_locations(place_resolved_at) WHERE place_resolved_at IS NULL;
)";
}

//path に新しい DB を作って gps_locations を用意する (Node サーバが一度起動した後の状態)
inline void create_gps_db(const std::string& path) {
	lapilli::sqlite::OpenOptions o;
	o.create = true;
	o.wal = true;
	lapilli::sqlite::Database db = lapilli::sqlite::Database::open(path, o);
	db.exec(gps_locations_ddl());
}

}
