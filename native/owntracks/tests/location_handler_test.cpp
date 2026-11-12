#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "gps_fixture.hpp"
#include "location_handler.hpp"
#include "test.hpp"

using namespace memoria::owntracks;
using lapilli::sqlite::Database;
using lapilli::sqlite::OpenOptions;
using lapilli::sqlite::Statement;

namespace {

//ログを手元に溜める出力先
class CaptureSink : public portus::LogSink {
public:
	void write(const portus::LogRecord& rec) override {
		std::lock_guard<std::mutex> lock(mu_);
		lines_.push_back(std::string(portus::level_name(rec.level)) + " " + rec.scope + " " + rec.msg);
	}
	std::vector<std::string> lines() {
		std::lock_guard<std::mutex> lock(mu_);
		return lines_;
	}

private:
	std::mutex mu_;
	std::vector<std::string> lines_;
};

struct Fixture {
	testing::TempPath path;
	std::shared_ptr<CaptureSink> sink = std::make_shared<CaptureSink>();
	portus::Logger log{ "owntracks", portus::LogLevel::Debug, { sink } };

	Fixture() { testing::create_gps_db(path.str()); }

	std::int64_t rows() {
		Database db = Database::open(path.str(), OpenOptions());
		Statement s = db.prepare("SELECT count(*) FROM gps_locations");
		return s.first([](const Statement& r) { return r.column_int64(0); }).value_or(-1);
	}
};

const char* kPayload = R"({"_type":"location","lat":35.660425,"lon":139.698275,"tst":1700000000,"batt":80,"password":"x"})";

}

TEST(handler_inserts_and_logs, "handler: 挿入した点を 1 行ログに出す (payload は出さない)、重複は何も出さない") {
	Fixture f;
	GpsStore store = GpsStore::open(f.path.str());
	LocationHandler h(store, "me", f.log);
	h.on_message("owntracks/me/iphone", kPayload);
	h.on_message("owntracks/me/iphone", kPayload);	//重複
	f.log.flush();
	const std::vector<std::string> lines = f.sink->lines();
	CHECK_EQ(lines.size(), 1u);
	if (!lines.empty()) CHECK_STR(lines[0], "info owntracks insert id=1 iphone (35.66042, 139.69827) tst=1700000000");
	for (const std::string& l : lines) CHECK(l.find("password") == std::string::npos);
	CHECK_EQ(f.rows(), 1);

	Database db = Database::open(f.path.str(), OpenOptions());
	Statement s = db.prepare("SELECT raw_json, device_id, user_id FROM gps_locations");
	s.first([](const Statement& r) {
		CHECK_STR(r.column_text(0), kPayload);	//raw_json は受けた文字列そのもの
		CHECK_STR(r.column_text(1), "iphone");
		CHECK_STR(r.column_text(2), "me");
		return 0;
	});
}

TEST(handler_ignores_non_locations, "handler: topic / JSON / payload が位置でなければ黙って捨てる") {
	Fixture f;
	GpsStore store = GpsStore::open(f.path.str());
	LocationHandler h(store, "me", f.log);
	h.on_message("other/me/iphone", kPayload);
	h.on_message("owntracks/me", kPayload);
	h.on_message("owntracks/me/iphone", "not json");
	h.on_message("owntracks/me/iphone", R"({"_type":"transition","lat":1,"lon":2,"tst":3})");
	h.on_message("owntracks/me/iphone", R"({"_type":"location","lat":91,"lon":2,"tst":3})");
	f.log.flush();
	CHECK(f.sink->lines().empty());
	CHECK_EQ(f.rows(), 0);
}

TEST(handler_survives_failures, "handler: 書き込みの失敗 (範囲外の tst・BUSY) はログに残して続ける") {
	Fixture f;
	OpenOptions o;
	o.busy_timeout_ms = 50;
	GpsStore store(Database::open(f.path.str(), o));
	LocationHandler h(store, "me", f.log);

	h.on_message("owntracks/me/iphone", R"({"_type":"location","lat":1,"lon":2,"tst":1e300})");
	{
		Database other = Database::open(f.path.str(), OpenOptions());
		other.exec("BEGIN IMMEDIATE");
		h.on_message("owntracks/me/iphone", kPayload);
		other.exec("ROLLBACK");
	}
	h.on_message("owntracks/me/iphone", kPayload);
	f.log.flush();
	const std::vector<std::string> lines = f.sink->lines();
	CHECK_EQ(lines.size(), 3u);
	if (lines.size() == 3) {
		CHECK_STR(lines[0], "error owntracks location handler threw: Invalid time value");
		CHECK(lines[1].rfind("error owntracks location handler threw: ", 0) == 0);
		CHECK(lines[1].find("locked") != std::string::npos || lines[1].find("busy") != std::string::npos);
		CHECK_STR(lines[2], "info owntracks insert id=1 iphone (35.66042, 139.69827) tst=1700000000");
	}
	CHECK_EQ(f.rows(), 1);
}

TEST(handler_empty_user_id, "handler: MEMORIA_USER_ID が空なら user_id は 'me' (TS の `userId || 'me'`)") {
	Fixture f;
	GpsStore store = GpsStore::open(f.path.str());
	LocationHandler h(store, "", f.log);
	h.on_message("owntracks/x/d", R"({"_type":"location","lat":1,"lon":2,"tst":3.25})");
	f.log.flush();
	const std::vector<std::string> lines = f.sink->lines();
	CHECK_EQ(lines.size(), 1u);
	if (!lines.empty()) CHECK_STR(lines[0], "info owntracks insert id=1 d (1.00000, 2.00000) tst=3.25");
	Database db = Database::open(f.path.str(), OpenOptions());
	Statement s = db.prepare("SELECT user_id, recorded_at FROM gps_locations");
	s.first([](const Statement& r) {
		CHECK_STR(r.column_text(0), "me");
		CHECK_STR(r.column_text(1), "1970-01-01T00:00:03.250Z");
		return 0;
	});
}
