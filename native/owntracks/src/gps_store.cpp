#include "gps_store.hpp"

#include <optional>
#include <utility>
#include <vector>

#include "gps_schema.hpp"
#include "haversine.hpp"
#include "js_date.hpp"
#include "portus/util.hpp"

namespace memoria::owntracks {

using lapilli::sqlite::Database;
using lapilli::sqlite::RunResult;
using lapilli::sqlite::Statement;
using lapilli::sqlite::Transaction;

namespace {

//SQL は server/db.ts の insertGpsLocation と同じ文 (空白だけ違う)
const char* kDupSql = R"(
	SELECT id FROM gps_locations
	WHERE user_id = ? AND IFNULL(device_id, '') = IFNULL(?, '') AND recorded_at = ?
	LIMIT 1)";

const char* kRecentSql = R"(
	SELECT id, lat, lon, recorded_at, samples_count, samples_first_at
	FROM gps_locations
	WHERE user_id = ? AND IFNULL(device_id, '') = IFNULL(?, '')
	ORDER BY recorded_at DESC
	LIMIT 2)";

const char* kMergeSql = R"(
	UPDATE gps_locations
	SET recorded_at = ?, lat = ?, lon = ?,
	    accuracy_m = ?, altitude_m = ?, velocity_kmh = ?, course_deg = ?,
	    battery_pct = ?, conn = ?, raw_json = ?,
	    samples_count = samples_count + 1,
	    samples_first_at = COALESCE(samples_first_at, ?)
	WHERE id = ?)";

const char* kInsertSql = R"(
	INSERT INTO gps_locations
	  (user_id, device_id, recorded_at, lat, lon,
	   accuracy_m, altitude_m, velocity_kmh, course_deg, battery_pct, conn, raw_json,
	   samples_count, samples_first_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL))";

struct RecentRow {
	std::int64_t id = 0;
	double lat = 0;
	double lon = 0;
	std::string recorded_at;
	std::optional<std::string> samples_first_at;
};

//`loc.recordedAt ? loc.recordedAt : (typeof loc.tst === 'number' ? new Date(tst*1000).toISOString() : new Date().toISOString())`
std::string recorded_at_of(const GpsLocationInput& loc) {
	if (loc.recorded_at && !loc.recorded_at->empty()) return *loc.recorded_at;
	if (loc.tst) {
		std::optional<std::string> iso = js_iso_string_from_epoch_seconds(*loc.tst);
		if (!iso) throw InvalidTimeError();
		return *iso;
	}
	return portus::iso_time(portus::now_ms());
}

}

const char* insert_kind_name(InsertKind kind) {
	switch (kind) {
	case InsertKind::skipped: return "skipped";
	case InsertKind::merged: return "merged";
	case InsertKind::inserted: return "inserted";
	}
	return "?";
}

struct GpsStore::Impl {
	Database db;
	Statement dup;
	Statement recent;
	Statement merge;
	Statement ins;

	explicit Impl(Database d)
		: db(std::move(d)), dup(db.prepare(kDupSql)), recent(db.prepare(kRecentSql)), merge(db.prepare(kMergeSql)), ins(db.prepare(kInsertSql)) {}
};

GpsStore GpsStore::open(const std::string& path) {
	lapilli::sqlite::OpenOptions o;
	o.create = false;	//スキーマは Node サーバが作る。無い DB を空で作らない
	o.wal = true;	//Node サーバと同時に使う
	o.busy_timeout_ms = 5000;
	o.foreign_keys = true;	//openDb と同じ
	return GpsStore(Database::open(path, o));
}

GpsStore::GpsStore(Database db) {
	verify_gps_schema(db);	//文の準備より先に確かめる (列が無いときに分かりやすい文で止まるように)
	impl_ = std::make_unique<Impl>(std::move(db));
}

GpsStore::~GpsStore() = default;
GpsStore::GpsStore(GpsStore&&) noexcept = default;
GpsStore& GpsStore::operator=(GpsStore&&) noexcept = default;

void GpsStore::close() noexcept {
	impl_.reset();	//文を先に捨ててから接続を閉じる (Impl のメンバは宣言の逆順に破棄される)
}

InsertResult GpsStore::insert(const GpsLocationInput& loc) {
	if (!impl_) throw std::logic_error("GpsStore is closed");
	Impl& s = *impl_;
	const std::string user_id = loc.user_id.empty() ? std::string("me") : loc.user_id;
	const std::string recorded_at = recorded_at_of(loc);

	Transaction tx(s.db);

	//CONFLICT 回避: 同一 (user, device, time) の点は dedup
	s.dup.bind_all(user_id, loc.device_id, recorded_at);
	if (const std::optional<std::int64_t> id = s.dup.first([](const Statement& r) { return r.column_int64(0); })) {
		tx.commit();
		return { InsertKind::skipped, *id };
	}

	//圧縮判定: 直近 2 行を確認
	std::vector<RecentRow> recent;
	s.recent.bind_all(user_id, loc.device_id);
	s.recent.for_each([&](const Statement& r) {
		RecentRow row;
		row.id = r.column_int64(0);
		row.lat = r.column_double(1);
		row.lon = r.column_double(2);
		row.recorded_at = r.column_text(3);
		row.samples_first_at = r.column_optional<std::string>(5);
		recent.push_back(std::move(row));
	});

	if (recent.size() == 2) {
		const RecentRow& last = recent[0];
		const RecentRow& prev = recent[1];
		const double t = kGpsStationaryThresholdM;
		//引数の順も TS と同じ: gpsHaversine(PREV, LAST) / (PREV, N) / (LAST, N)
		if (gps_haversine_m(prev.lat, prev.lon, last.lat, last.lon) < t &&
			gps_haversine_m(prev.lat, prev.lon, loc.lat, loc.lon) < t &&
			gps_haversine_m(last.lat, last.lon, loc.lat, loc.lon) < t) {
			//`LAST.samples_first_at || LAST.recorded_at`: 空文字列も偽として扱う
			const std::string samples_first_at = (last.samples_first_at && !last.samples_first_at->empty()) ? *last.samples_first_at : last.recorded_at;
			s.merge.bind_all(recorded_at, loc.lat, loc.lon, loc.accuracy, loc.altitude, loc.velocity, loc.course, loc.battery, loc.conn, loc.raw_json, samples_first_at, last.id).run();
			tx.commit();
			return { InsertKind::merged, last.id };
		}
	}

	//通常 INSERT
	const RunResult info = s.ins.bind_all(user_id, loc.device_id, recorded_at, loc.lat, loc.lon, loc.accuracy, loc.altitude, loc.velocity, loc.course, loc.battery, loc.conn, loc.raw_json).run();
	tx.commit();
	return { InsertKind::inserted, info.last_insert_rowid };
}

}
