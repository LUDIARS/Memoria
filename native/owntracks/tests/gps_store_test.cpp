#include <optional>
#include <string>

#include "gps_fixture.hpp"
#include "gps_schema.hpp"
#include "gps_store.hpp"
#include "test.hpp"

using namespace memoria::owntracks;
using lapilli::sqlite::Database;
using lapilli::sqlite::OpenOptions;
using lapilli::sqlite::Statement;

namespace {

Database open_existing(const testing::TempPath& path, int busy_timeout_ms = 5000) {
	OpenOptions o;
	o.wal = true;
	o.busy_timeout_ms = busy_timeout_ms;
	return Database::open(path.str(), o);
}

GpsLocationInput point(std::optional<std::string> device, double tst, double lat, double lon) {
	GpsLocationInput p;
	p.user_id = "me";
	p.device_id = std::move(device);
	p.tst = tst;
	p.lat = lat;
	p.lon = lon;
	return p;
}

std::int64_t count_rows(const testing::TempPath& path) {
	Database db = open_existing(path);
	Statement s = db.prepare("SELECT count(*) FROM gps_locations");
	return s.first([](const Statement& r) { return r.column_int64(0); }).value_or(-1);
}

struct Row {
	std::string recorded_at;
	std::int64_t samples_count = 0;
	std::optional<std::string> samples_first_at;
	double lat = 0;
};

Row read_row(const testing::TempPath& path, std::int64_t id) {
	Database db = open_existing(path);
	Statement s = db.prepare("SELECT recorded_at, samples_count, samples_first_at, lat FROM gps_locations WHERE id = ?");
	s.bind_all(id);
	Row row;
	s.first([&](const Statement& r) {
		row.recorded_at = r.column_text(0);
		row.samples_count = r.column_int64(1);
		row.samples_first_at = r.column_optional<std::string>(2);
		row.lat = r.column_double(3);
		return 0;
	});
	return row;
}

}

TEST(gps_store_three_way, "gps_store: 重複は skipped、停止中は merged (LAST を更新)、動けば inserted") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	GpsStore store = GpsStore::open(path.str());

	//0.0001 度 ≒ 11m
	const InsertResult r1 = store.insert(point(std::string("phone"), 1700000000, 35.0, 135.0));
	CHECK(r1.kind == InsertKind::inserted);
	CHECK_EQ(r1.id, 1);
	const InsertResult dup = store.insert(point(std::string("phone"), 1700000000, 35.0005, 135.0));	//同じ時刻は位置が違っても重複
	CHECK(dup.kind == InsertKind::skipped);
	CHECK_EQ(dup.id, 1);

	const InsertResult r2 = store.insert(point(std::string("phone"), 1700000060, 35.0001, 135.0));
	CHECK(r2.kind == InsertKind::inserted);	//直近が 1 行だけなので圧縮しない
	const InsertResult r3 = store.insert(point(std::string("phone"), 1700000120, 35.0, 135.0001));
	CHECK(r3.kind == InsertKind::merged);
	CHECK_EQ(r3.id, r2.id);
	CHECK_EQ(count_rows(path), 2);

	//1km 動いた
	const InsertResult r4 = store.insert(point(std::string("phone"), 1700000180, 35.01, 135.0));
	CHECK(r4.kind == InsertKind::inserted);
	CHECK_EQ(r4.id, 3);
	//LAST は動いた点、PREV は停止区間の終点: PREV-LAST が 50m 以上なので圧縮しない
	const InsertResult r5 = store.insert(point(std::string("phone"), 1700000240, 35.01, 135.0));
	CHECK(r5.kind == InsertKind::inserted);
	CHECK_EQ(count_rows(path), 4);

	//別の端末は別系列 (同じ時刻でも重複ではない)
	CHECK(store.insert(point(std::string("tablet"), 1700000000, 35.0, 135.0)).kind == InsertKind::inserted);
	//別のユーザも別系列
	GpsLocationInput other = point(std::string("phone"), 1700000000, 35.0, 135.0);
	other.user_id = "someone";
	CHECK(store.insert(other).kind == InsertKind::inserted);
}

TEST(gps_store_samples_first_at, "gps_store: 何度圧縮しても samples_first_at は最初に圧縮対象になった時の recorded_at、samples_count は件数") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	GpsStore store = GpsStore::open(path.str());
	store.insert(point(std::string("p"), 1000, 35.0, 135.0));
	const InsertResult tail = store.insert(point(std::string("p"), 1060, 35.0001, 135.0));
	for (int i = 2; i <= 6; ++i) {
		const InsertResult r = store.insert(point(std::string("p"), 1000 + 60 * i, 35.0 + (i % 2) * 0.0001, 135.0));
		CHECK(r.kind == InsertKind::merged);
		CHECK_EQ(r.id, tail.id);
		const Row row = read_row(path, tail.id);
		CHECK_EQ(row.samples_count, i);
		CHECK(row.samples_first_at == std::string("1970-01-01T00:17:40.000Z"));	//tst=1060
	}
	const Row row = read_row(path, tail.id);
	CHECK_STR(row.recorded_at, "1970-01-01T00:22:40.000Z");	//tst=1360
	CHECK_EQ(count_rows(path), 2);
}

TEST(gps_store_null_device, "gps_store: device_id が NULL でも重複判定と系列が動く (IFNULL(device_id, ''))") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	GpsStore store = GpsStore::open(path.str());
	const InsertResult a = store.insert(point(std::nullopt, 2000, 35.0, 135.0));
	CHECK(a.kind == InsertKind::inserted);
	CHECK(store.insert(point(std::nullopt, 2000, 35.0, 135.0)).kind == InsertKind::skipped);
	//NULL と '' は同じ系列として扱う (TS と同じ SQL)
	const InsertResult empty = store.insert(point(std::string(""), 2000, 35.0, 135.0));
	CHECK(empty.kind == InsertKind::skipped);
	CHECK_EQ(empty.id, a.id);
	store.insert(point(std::nullopt, 2060, 35.0001, 135.0));
	CHECK(store.insert(point(std::string(""), 2120, 35.0, 135.0001)).kind == InsertKind::merged);

	Database db = open_existing(path);
	Statement s = db.prepare("SELECT count(*) FROM gps_locations WHERE device_id IS NULL");
	CHECK_EQ(s.first([](const Statement& r) { return r.column_int64(0); }).value_or(-1), 2);
}

TEST(gps_store_storage_classes, "gps_store: 数値は REAL で bind し、battery_pct は整数値なら INTEGER (better-sqlite3 と同じ)") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	GpsStore store = GpsStore::open(path.str());
	GpsLocationInput p = point(std::string("p"), 1700000000, 35.5, 139.5);
	p.accuracy = 5;
	p.altitude = 40.5;
	p.velocity = 0;
	p.course = 270;
	p.battery = 85;
	p.conn = std::string("w");
	p.raw_json = std::string(u8R"({"desc":"自宅"})");
	store.insert(p);
	GpsLocationInput q = point(std::string("p"), 1700000060, 36.5, 139.5);
	q.battery = 85.5;
	store.insert(q);

	Database db = open_existing(path);
	Statement s = db.prepare(R"(SELECT typeof(user_id), typeof(device_id), typeof(recorded_at), typeof(lat), typeof(accuracy_m), typeof(velocity_kmh),
		typeof(battery_pct), battery_pct, typeof(conn), raw_json, typeof(altitude_m), typeof(samples_first_at), samples_count
		FROM gps_locations ORDER BY id)");
	int n = 0;
	s.for_each([&](const Statement& r) {
		++n;
		CHECK_STR(r.column_text(0), "text");
		CHECK_STR(r.column_text(1), "text");
		CHECK_STR(r.column_text(2), "text");
		CHECK_STR(r.column_text(3), "real");
		CHECK_STR(r.column_text(11), "null");
		CHECK_EQ(r.column_int64(12), 1);
		if (n == 1) {
			CHECK_STR(r.column_text(4), "real");
			CHECK_STR(r.column_text(5), "real");	//0 も REAL 列なので real
			CHECK_STR(r.column_text(6), "integer");	//85.0 → INTEGER 親和性で 85
			CHECK_EQ(r.column_int64(7), 85);
			CHECK_STR(r.column_text(8), "text");
			CHECK_STR(r.column_text(9), u8R"({"desc":"自宅"})");
			CHECK_STR(r.column_text(10), "real");
		} else {
			CHECK_STR(r.column_text(4), "null");
			CHECK_STR(r.column_text(6), "real");	//85.5 は整数にできないので REAL のまま
			CHECK_STR(r.column_text(8), "null");
			CHECK_STR(r.column_text(10), "null");
		}
	});
	CHECK_EQ(n, 2);
}

TEST(gps_store_recorded_at_rules, "gps_store: recorded_at は指定 > tst の順、空の recorded_at と空の user_id は無いものとして扱う") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	GpsStore store = GpsStore::open(path.str());

	GpsLocationInput a = point(std::string("p"), 1700000000, 35.0, 135.0);
	a.recorded_at = std::string("2026-01-01T00:00:00.000Z");
	a.user_id = "";
	const InsertResult ra = store.insert(a);
	GpsLocationInput b = point(std::string("p"), 1700000000, 40.0, 135.0);
	b.recorded_at = std::string("");
	const InsertResult rb = store.insert(b);

	Database db = open_existing(path);
	Statement s = db.prepare("SELECT recorded_at, user_id FROM gps_locations WHERE id = ?");
	s.bind_all(ra.id);
	s.first([](const Statement& r) {
		CHECK_STR(r.column_text(0), "2026-01-01T00:00:00.000Z");
		CHECK_STR(r.column_text(1), "me");
		return 0;
	});
	s.bind_all(rb.id);
	s.first([](const Statement& r) {
		CHECK_STR(r.column_text(0), "2023-11-14T22:13:20.000Z");
		return 0;
	});

	//recorded_at も tst も無ければ現在時刻
	GpsLocationInput c;
	c.lat = 1;
	c.lon = 1;
	c.device_id = std::string("now");
	CHECK(store.insert(c).kind == InsertKind::inserted);
}

TEST(gps_store_invalid_time, "gps_store: Date の範囲外の tst は Invalid time value で、何も書かない") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	GpsStore store = GpsStore::open(path.str());
	bool threw = false;
	try {
		store.insert(point(std::string("p"), 1e300, 35.0, 135.0));
	} catch (const InvalidTimeError& e) {
		threw = true;
		CHECK_STR(e.what(), "Invalid time value");
	}
	CHECK(threw);
	CHECK_EQ(count_rows(path), 0);
	CHECK(store.insert(point(std::string("p"), 1, 35.0, 135.0)).kind == InsertKind::inserted);	//その後も使える
}

TEST(gps_store_samples_first_at_empty_string, "gps_store: samples_first_at が空文字列なら recorded_at を使う (TS の ||) が、COALESCE は空文字列を残す") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	{
		GpsStore store = GpsStore::open(path.str());
		store.insert(point(std::string("p"), 1000, 35.0, 135.0));
		store.insert(point(std::string("p"), 1060, 35.0001, 135.0));
	}
	{
		Database db = open_existing(path);
		db.exec("UPDATE gps_locations SET samples_first_at = '' WHERE id = 2");
	}
	GpsStore store = GpsStore::open(path.str());
	CHECK(store.insert(point(std::string("p"), 1120, 35.0, 135.0001)).kind == InsertKind::merged);
	const Row row = read_row(path, 2);
	CHECK(row.samples_first_at == std::string(""));
	CHECK_EQ(row.samples_count, 2);
}

TEST(gps_store_busy, "gps_store: 別の接続が書き込みロックを持っていれば BUSY の Error で、ロックが外れれば書ける") {
	testing::TempPath path;
	testing::create_gps_db(path.str());
	GpsStore store(open_existing(path, 50));
	Database other = open_existing(path);
	other.exec("BEGIN IMMEDIATE");
	bool busy = false;
	try {
		store.insert(point(std::string("p"), 1, 35.0, 135.0));
	} catch (const lapilli::sqlite::Error& e) {
		busy = e.code() == lapilli::sqlite::code::busy;
	}
	CHECK(busy);
	other.exec("ROLLBACK");
	CHECK(store.insert(point(std::string("p"), 1, 35.0, 135.0)).kind == InsertKind::inserted);
	store.close();
	CHECK_THROWS(store.insert(point(std::string("p"), 2, 35.0, 135.0)));
}
