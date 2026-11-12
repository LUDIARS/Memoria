#include <filesystem>
#include <string>

#include "gps_fixture.hpp"
#include "gps_schema.hpp"
#include "gps_store.hpp"
#include "test.hpp"

using namespace memoria::owntracks;
using lapilli::sqlite::Database;
using lapilli::sqlite::OpenOptions;

namespace {

Database open_new(const testing::TempPath& path) {
	OpenOptions o;
	o.create = true;
	return Database::open(path.str(), o);
}

std::string schema_error_of(const testing::TempPath& path) {
	try {
		GpsStore::open(path.str());
	} catch (const GpsSchemaError& e) {
		return e.what();
	}
	return "";
}

}

TEST(gps_schema_missing_file, "gps_schema: DB ファイルが無ければ開かない (作らない)") {
	testing::TempPath path;
	bool cantopen = false;
	try {
		GpsStore::open(path.str());
	} catch (const lapilli::sqlite::Error& e) {
		cantopen = e.code() == lapilli::sqlite::code::cantopen;
	}
	CHECK(cantopen);
	CHECK(!std::filesystem::exists(path.str()));
}

TEST(gps_schema_missing_table, "gps_schema: gps_locations が無ければ、Memoria サーバに作らせるよう促して止まる") {
	testing::TempPath path;
	open_new(path).exec("CREATE TABLE bookmarks (id INTEGER PRIMARY KEY)");
	const std::string msg = schema_error_of(path);
	CHECK(msg.find("gps_locations does not exist") != std::string::npos);
	CHECK(msg.find("Memoria server") != std::string::npos);
	//テーブルを作っていない
	CHECK(open_new(path).table_columns("gps_locations").empty());
}

TEST(gps_schema_missing_columns, "gps_schema: 圧縮の列を足す前の古い gps_locations なら、足りない列を挙げて止まる") {
	testing::TempPath path;
	open_new(path).exec(R"(CREATE TABLE gps_locations (
		id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'me', device_id TEXT, recorded_at TEXT NOT NULL,
		lat REAL NOT NULL, lon REAL NOT NULL, accuracy_m REAL, altitude_m REAL, velocity_kmh REAL, course_deg REAL,
		battery_pct INTEGER, conn TEXT, raw_json TEXT, received_at TEXT NOT NULL DEFAULT (datetime('now'))))");
	const std::string msg = schema_error_of(path);
	CHECK(msg.find("lacks column(s): samples_count, samples_first_at.") != std::string::npos);
	//列を足していない
	CHECK_EQ(open_new(path).table_columns("gps_locations").size(), 14u);
}

TEST(gps_schema_ok, "gps_schema: openDb と同じ DDL なら足りない列は無い (place_* は使わない)") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	OpenOptions o;
	Database db = Database::open(path.str(), o);
	CHECK(missing_gps_columns(db).empty());
	CHECK_EQ(db.table_columns("gps_locations").size(), 20u);
}
